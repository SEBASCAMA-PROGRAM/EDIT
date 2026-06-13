import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, eventConfig, getTier, DEMO_PAYMENTS, DEMO_EMAIL, DB_PERSISTENT, OUTBOX_DIR, ROOT } from './config.js';
import * as db from './db.js';
import { createCheckout, constructWebhookEvent, isSessionPaid } from './payments.js';
import { qrDataUrl, qrPngBuffer, ticketUrl } from './qr.js';
import { sendEmail, paymentEmailHtml, ticketEmailHtml } from './email.js';
import { publicLayout, adminLayout, esc, money, flash } from './render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cookieParser(env.SESSION_SECRET));

// Asegura que las tablas existan antes de atender cualquier petición.
// (En serverless esto se ejecuta una sola vez por instancia.)
app.use(async (req, res, next) => {
  try { await db.init(); next(); } catch (err) { next(err); }
});

// ---------- Webhook de Stripe (cuerpo crudo, ANTES del json parser) ----------
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Webhook inválido:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = parseInt(session.metadata?.order_id, 10);
      if (orderId) await fulfillOrder(orderId);
    }
  } catch (err) {
    console.error('Error procesando webhook:', err);
  }
  res.json({ received: true });
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// =========================================================
//  CUMPLIMIENTO: marcar pagado + enviar boleto con QR
// =========================================================
async function fulfillOrder(orderId) {
  let order = await db.getOrder(orderId);
  if (!order) return null;
  if (order.status === 'paid') return order; // idempotente
  order = await db.markPaid(orderId);
  const full = await db.orderWithContact(orderId);
  const perks = JSON.parse(order.perks || '[]');

  if (full.contact_email) {
    try {
      const png = await qrPngBuffer(order.ticket_token);
      const html = ticketEmailHtml({
        name: full.contact_name,
        tierName: order.tier_name,
        perks,
        ticketUrl: ticketUrl(order.ticket_token),
        surveyUrl: `${env.BASE_URL}/formulario/${order.ticket_token}`,
        qrUrl: `${env.BASE_URL}/qr/${order.ticket_token}.png`,
      });
      await sendEmail({
        to: full.contact_email,
        subject: `🎟️ Tu boleto para ${eventConfig.event.title}`,
        html,
        attachments: [{ filename: 'boleto-qr.png', content: png }],
      });
    } catch (err) {
      console.error('No se pudo enviar el correo del boleto:', err.message);
    }
  }
  return order;
}

// =========================================================
//  PÁGINAS PÚBLICAS
// =========================================================
const ev = eventConfig.event;
const brand = eventConfig.brand;

function eventMeta() {
  return `<div class="meta">
    <span>📅 ${esc(ev.dateText)}</span>
    <span>🕗 ${esc(ev.timeText)}</span>
    <span>📍 ${esc(ev.venue)}${ev.address ? ', ' + esc(ev.address) : ''}</span>
  </div>`;
}

app.get('/', (req, res) => res.redirect('/evento'));

// Landing branded con invitación + pago
app.get('/evento', (req, res) => {
  const tiers = eventConfig.tiers.map((t) => `
    <div class="tier">
      <h3>${esc(t.name)}</h3>
      <div class="price">${money(t.price * 100)}</div>
      <ul>${t.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <form method="POST" action="/comprar" class="buyform">
        <input type="hidden" name="tier_id" value="${esc(t.id)}"/>
        <div class="row">
          <input name="name" placeholder="Tu nombre" required/>
          <input name="email" type="email" placeholder="Tu email" required/>
        </div>
        <input name="phone" placeholder="Tu teléfono (opcional)" style="margin-top:10px"/>
        <button class="btn block primary" style="margin-top:12px">Comprar ${esc(t.name)} →</button>
      </form>
    </div>`).join('');

  res.send(publicLayout({
    title: ev.title,
    body: `
      <div class="hero">
        <div class="kicker">${esc(brand.organizer || brand.name)}</div>
        <h1>${esc(ev.title)}</h1>
        <p class="tag">${esc(brand.tagline || '')}</p>
      </div>
      ${eventMeta()}
      <div class="card">
        <p style="font-size:16px;line-height:1.5">${esc(ev.description)}</p>
      </div>
      ${(eventConfig.speakers && eventConfig.speakers.length) ? `
      <h2 style="text-align:center;margin-top:30px">Expositores</h2>
      <div class="card">
        ${eventConfig.speakers.map((sp) => `
          <div class="speaker">
            <div class="sp-name">${esc(sp.name)}</div>
            <div class="sp-role">${esc(sp.role)}</div>
            ${sp.topics ? `<div class="sp-topics">${esc(sp.topics)}</div>` : ''}
          </div>`).join('')}
      </div>` : ''}
      ${(eventConfig.includes && eventConfig.includes.length) ? `
      <h2 style="text-align:center;margin-top:30px">Qué incluye tu entrada</h2>
      <div class="card">
        <ul class="includes">${eventConfig.includes.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      </div>` : ''}
      <h2 style="text-align:center;margin-top:30px">Elige tu boleto</h2>
      <div class="card">${tiers}</div>
      <p class="center muted" style="color:#bbb">Pago seguro${DEMO_PAYMENTS ? ' (MODO DEMO)' : ' con Stripe'} · Recibirás tu boleto con QR por correo.</p>
    `,
  }));
});

// Comprar desde la landing (self-service)
app.post('/comprar', async (req, res) => {
  const { tier_id, name, email, phone } = req.body;
  const tier = getTier(tier_id);
  if (!tier) return res.status(400).send('Boleto no válido');

  let contact = await db.findContactByEmail(email);
  if (!contact) contact = await db.createContact({ name, email, phone });

  const order = await db.createOrder({
    contact_id: contact.id,
    tier_id: tier.id,
    tier_name: tier.name,
    perks: tier.perks,
    amount_cents: Math.round(tier.price * 100),
    currency: eventConfig.currency,
    source: 'landing',
  });

  const checkout = await createCheckout(order, { contactEmail: email });
  await db.setOrderSession(order.id, checkout.id, checkout.url);
  res.redirect(checkout.url);
});

// Página de gracias (vuelta de Stripe). En modo demo el pago ya se cumplió.
app.get('/gracias', async (req, res) => {
  let order = await db.getOrderByToken(req.query.token);
  // Red de seguridad: si el webhook no llegó, confirmamos contra Stripe.
  if (order && order.status === 'pending' && await isSessionPaid(order.stripe_session_id)) {
    await fulfillOrder(order.id);
    order = await db.getOrder(order.id);
  }
  res.send(publicLayout({
    title: 'Gracias',
    body: `
      <div class="hero"><h1>¡Gracias! 🎉</h1></div>
      <div class="card center">
        <p style="font-size:17px">Tu pago se está confirmando. En unos momentos recibirás tu <b>boleto con código QR</b> en tu correo.</p>
        ${order ? `<p><a class="btn primary" href="/t/${order.ticket_token}">Ver mi boleto ahora →</a></p>` : ''}
        <p class="muted">Revisa también tu carpeta de spam.</p>
      </div>`,
  }));
});

app.get('/pago-cancelado', (req, res) => {
  res.send(publicLayout({
    title: 'Pago cancelado',
    body: `<div class="hero"><h1>Pago cancelado</h1></div>
      <div class="card center"><p>No se completó el pago. Puedes intentarlo de nuevo cuando quieras.</p>
      <a class="btn primary" href="/evento">Volver al evento</a></div>`,
  }));
});

// Página del boleto (lo que abre el QR)
app.get('/t/:token', async (req, res) => {
  const order = await db.orderWithContactByToken(req.params.token);
  if (!order) return res.status(404).send(publicLayout({ title: 'No encontrado', body: '<div class="card center">Boleto no encontrado.</div>' }));
  const perks = JSON.parse(order.perks || '[]');
  const dataUrl = await qrDataUrl(order.ticket_token);
  const paid = order.status === 'paid';

  res.send(publicLayout({
    title: 'Mi boleto',
    body: `
      <div class="hero">
        <div class="kicker">${esc(brand.organizer || brand.name)}</div>
        <h1>${esc(ev.title)}</h1>
      </div>
      <div class="card">
        ${paid ? '' : '<div class="flash info" style="margin-bottom:14px">Este boleto aún no está pagado.</div>'}
        <div class="qrbox">
          <img src="${dataUrl}" alt="QR"/>
          <p class="muted">Presenta este código en la entrada</p>
        </div>
        <h3 style="margin-top:8px">${esc(order.tier_name)}</h3>
        <p style="color:#555;margin:2px 0 8px">A nombre de <b>${esc(order.contact_name || '')}</b></p>
        <div style="font-size:13px;color:#7c7c8a;text-transform:uppercase;letter-spacing:.05em">Incluye</div>
        <ul style="color:#444">${perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        ${eventMeta().replace('class="meta"', 'class="meta" style="color:#666"')}
        ${order.survey_json
          ? '<p class="center" style="color:#1d8a4f;font-weight:700">✓ Formulario respondido</p>'
          : `<a class="btn block primary" href="/formulario/${order.ticket_token}">Responder formulario de llegada →</a>`}
      </div>`,
  }));
});

// QR como PNG (usado por el correo)
app.get('/qr/:token.png', async (req, res) => {
  const order = await db.getOrderByToken(req.params.token);
  if (!order) return res.status(404).end();
  const png = await qrPngBuffer(order.ticket_token);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(png);
});

// Formulario de preguntas (incluido con el boleto)
app.get('/formulario/:token', async (req, res) => {
  const order = await db.orderWithContactByToken(req.params.token);
  if (!order) return res.status(404).send('No encontrado');
  const s = eventConfig.survey;
  const done = !!order.survey_json;
  const fields = s.questions.map((q) => {
    let input;
    if (q.type === 'textarea') {
      input = `<textarea name="${esc(q.id)}" rows="3" ${q.required ? 'required' : ''}></textarea>`;
    } else if (q.type === 'select') {
      const opts = (q.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      input = `<select name="${esc(q.id)}" ${q.required ? 'required' : ''}>${opts}</select>`;
    } else {
      input = `<input type="${q.type === 'number' ? 'number' : 'text'}" name="${esc(q.id)}" ${q.required ? 'required' : ''}/>`;
    }
    return `<label>${esc(q.label)}${input}</label>`;
  }).join('');

  res.send(publicLayout({
    title: s.title,
    body: done
      ? `<div class="hero"><h1>¡Gracias!</h1></div><div class="card center"><p>Ya recibimos tus respuestas. Nos vemos en el evento 🎉</p><a class="btn primary" href="/t/${order.ticket_token}">Ver mi boleto</a></div>`
      : `<div class="hero"><h1>${esc(s.title)}</h1><p class="tag">${esc(s.intro || '')}</p></div>
         <div class="card">
           <form method="POST" action="/formulario/${order.ticket_token}">
             ${fields}
             <button class="btn block primary" style="margin-top:18px">Enviar respuestas</button>
           </form>
         </div>`,
  }));
});

app.post('/formulario/:token', async (req, res) => {
  const order = await db.getOrderByToken(req.params.token);
  if (!order) return res.status(404).send('No encontrado');
  const answers = {};
  for (const q of eventConfig.survey.questions) answers[q.id] = req.body[q.id] || '';
  await db.saveSurvey(order.id, answers);
  res.redirect(`/formulario/${order.ticket_token}`);
});

// ---------- MODO DEMO: simular pasarela de pago ----------
app.get('/demo/pay/:orderId', async (req, res) => {
  const order = await db.getOrder(req.params.orderId);
  if (!order) return res.status(404).send('Orden no encontrada');
  res.send(publicLayout({
    title: 'Pago (Demo)',
    body: `
      <div class="hero"><h1>Pasarela de pago (DEMO)</h1></div>
      <div class="card center">
        <p>Estás pagando <b>${esc(order.tier_name)}</b> por <b>${money(order.amount_cents)}</b>.</p>
        <p class="muted">Esto es una simulación porque aún no configuras Stripe. Al confirmar, se marcará como pagado y se enviará el boleto.</p>
        <form method="POST" action="/demo/pay/${order.id}">
          <button class="btn primary block" style="margin-top:12px">✅ Confirmar pago (simulado)</button>
        </form>
        <a class="btn ghost" style="margin-top:10px" href="/pago-cancelado?token=${order.ticket_token}">Cancelar</a>
      </div>`,
  }));
});

app.post('/demo/pay/:orderId', async (req, res) => {
  const order = await db.getOrder(req.params.orderId);
  if (!order) return res.status(404).send('Orden no encontrada');
  await fulfillOrder(order.id);
  res.redirect(`/gracias?token=${order.ticket_token}`);
});

// =========================================================
//  AUTENTICACIÓN DEL PANEL
// =========================================================
function sessionToken() {
  return crypto.createHmac('sha256', env.SESSION_SECRET).update('admin-ok').digest('hex');
}
function requireAuth(req, res, next) {
  if (req.signedCookies?.sid === sessionToken()) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  res.send(publicLayout({
    title: 'Entrar',
    body: `<div class="loginwrap"><div class="card">
      <h2 style="margin-top:0">Panel · ${esc(brand.name)}</h2>
      ${req.query.err ? '<div class="flash err">Contraseña incorrecta</div>' : ''}
      <form method="POST" action="/admin/login">
        <label>Contraseña<input type="password" name="password" autofocus required/></label>
        <button class="btn primary block" style="margin-top:16px">Entrar</button>
      </form>
    </div></div>`,
  }));
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === env.ADMIN_PASSWORD) {
    res.cookie('sid', sessionToken(), { httpOnly: true, signed: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 });
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?err=1');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie('sid');
  res.redirect('/admin/login');
});

app.use('/admin', requireAuth);

// =========================================================
//  PANEL — TABLERO
// =========================================================
const statusBadge = (o) => {
  if (o.status === 'paid') return o.checked_in ? '<span class="badge in">✓ En el evento</span>' : '<span class="badge paid">Pagado</span>';
  if (o.status === 'canceled') return '<span class="badge canceled">Cancelado</span>';
  return '<span class="badge pending">Pendiente</span>';
};

app.get('/admin', async (req, res) => {
  const s = await db.stats();
  const orders = await db.listOrders();
  const contacts = await db.listContacts();

  const tierOptions = eventConfig.tiers
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)} — ${money(t.price * 100)}</option>`)
    .join('') + '<option value="__custom">— Monto personalizado —</option>';

  const rows = orders.map((o) => `
    <tr>
      <td><b>${esc(o.contact_name || '—')}</b><br><span class="muted">${esc(o.contact_email || '')}</span></td>
      <td>${esc(o.tier_name)}</td>
      <td>${money(o.amount_cents)}</td>
      <td>${statusBadge(o)}</td>
      <td class="actions">
        ${o.payment_url && o.status === 'pending' ? `<button class="btn ghost sm copybtn" data-url="${esc(o.payment_url)}">Copiar link de pago</button>` : ''}
        ${o.status === 'paid' ? `<a class="btn ghost sm" href="/t/${o.ticket_token}" target="_blank">Ver boleto</a>` : ''}
        ${o.status === 'pending' ? `<form method="POST" action="/admin/orden/${o.id}/cobrar-reenviar" style="display:inline"><button class="btn ghost sm">Reenviar cobro</button></form>` : ''}
        ${o.status === 'pending' ? `<form method="POST" action="/admin/orden/${o.id}/marcar-pagado" style="display:inline" onsubmit="return confirm('¿Marcar como pagado manualmente y enviar el boleto?')"><button class="btn ghost sm">Marcar pagado</button></form>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">Aún no hay ventas. Crea tu primer cobro arriba 👆</td></tr>';

  const contactOptions = contacts
    .map((c) => `<option value="${c.id}">${esc(c.name)}${c.email ? ' (' + esc(c.email) + ')' : ''}</option>`)
    .join('');

  res.send(adminLayout({
    title: 'Tablero',
    active: 'home',
    body: `
      ${flash(req.query.msg, req.query.t || 'ok')}
      <div class="statgrid">
        <div class="stat"><div class="n">${s.paid}</div><div class="l">Boletos pagados</div></div>
        <div class="stat"><div class="n">${s.checked}</div><div class="l">Ya en el evento</div></div>
        <div class="stat"><div class="n">${s.pending}</div><div class="l">Cobros pendientes</div></div>
        <div class="stat"><div class="n">${money(s.revenue)}</div><div class="l">Recaudado</div></div>
      </div>

      <div class="panel">
        <h2>💸 Nuevo cobro (durante la llamada)</h2>
        <form method="POST" action="/admin/cobrar">
          <div class="row">
            <div>
              <label>Cliente existente
                <select name="contact_id">
                  <option value="">— Nuevo contacto —</option>
                  ${contactOptions}
                </select>
              </label>
            </div>
          </div>
          <div class="row">
            <label>Nombre<input name="name" placeholder="Nombre y apellido"/></label>
            <label>Email<input name="email" type="email" placeholder="correo@ejemplo.com"/></label>
            <label>Teléfono<input name="phone" placeholder="(305) 000-0000"/></label>
          </div>
          <div class="row">
            <label>Boleto / precio
              <select name="tier_id" id="tierSelect">${tierOptions}</select>
            </label>
            <label id="customAmtWrap" style="display:none">Monto personalizado (${eventConfig.currency.toUpperCase()})
              <input name="custom_amount" type="number" step="0.01" placeholder="50.00"/>
            </label>
          </div>
          <label id="customPerksWrap" style="display:none">¿Qué incluye? (una línea por beneficio)
            <textarea name="custom_perks" rows="3" placeholder="Acceso general&#10;Bebida de cortesía"></textarea>
          </label>
          <button class="btn primary" style="margin-top:16px">Crear cobro y enviar por correo</button>
          <p class="muted">Se crea el boleto, se manda el correo de cobro y aparece abajo con su link de pago para copiar.</p>
        </form>
      </div>

      <div class="panel">
        <h2>🎟️ Ventas y cobros</h2>
        <table>
          <thead><tr><th>Cliente</th><th>Boleto</th><th>Monto</th><th>Estado</th><th>Acciones</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <script>
        const sel = document.getElementById('tierSelect');
        function toggleCustom(){
          const c = sel.value === '__custom';
          document.getElementById('customAmtWrap').style.display = c ? '' : 'none';
          document.getElementById('customPerksWrap').style.display = c ? '' : 'none';
        }
        sel.addEventListener('change', toggleCustom); toggleCustom();
        document.querySelectorAll('.copybtn').forEach(b => b.addEventListener('click', () => {
          navigator.clipboard.writeText(b.dataset.url); b.textContent = '¡Copiado!';
          setTimeout(()=>b.textContent='Copiar link de pago', 1500);
        }));
      </script>
    `,
  }));
});

// Crear cobro desde el panel
app.post('/admin/cobrar', async (req, res) => {
  const { contact_id, name, email, phone, tier_id, custom_amount, custom_perks } = req.body;

  let contact = null;
  if (contact_id) contact = await db.getContact(contact_id);
  if (!contact) {
    if (!name && !email) return res.redirect('/admin?t=err&msg=' + encodeURIComponent('Pon al menos nombre o email'));
    contact = email ? await db.findContactByEmail(email) : null;
    if (!contact) contact = await db.createContact({ name, email, phone });
  }

  let tierName, perks, amountCents, tierIdVal;
  if (tier_id === '__custom') {
    amountCents = Math.round(parseFloat(custom_amount || '0') * 100);
    if (!amountCents || amountCents < 50) return res.redirect('/admin?t=err&msg=' + encodeURIComponent('Monto personalizado inválido'));
    perks = (custom_perks || '').split('\n').map((x) => x.trim()).filter(Boolean);
    tierName = 'Boleto personalizado';
    tierIdVal = null;
  } else {
    const tier = getTier(tier_id);
    if (!tier) return res.redirect('/admin?t=err&msg=' + encodeURIComponent('Boleto no válido'));
    tierName = tier.name; perks = tier.perks; amountCents = Math.round(tier.price * 100); tierIdVal = tier.id;
  }

  const order = await db.createOrder({
    contact_id: contact.id, tier_id: tierIdVal, tier_name: tierName,
    perks, amount_cents: amountCents, currency: eventConfig.currency, source: 'crm',
  });

  const checkout = await createCheckout(order, { contactEmail: contact.email });
  await db.setOrderSession(order.id, checkout.id, checkout.url);

  let mailMsg = '';
  if (contact.email) {
    try {
      await sendEmail({
        to: contact.email,
        subject: `Tu boleto para ${eventConfig.event.title} — completa tu pago`,
        html: paymentEmailHtml({
          name: contact.name, tierName, perks, amountCents,
          currency: eventConfig.currency, paymentUrl: checkout.url,
        }),
      });
      mailMsg = DEMO_EMAIL ? ' (correo en modo demo — ver pestaña Correos)' : ' y correo enviado';
    } catch (err) {
      mailMsg = ' (no se pudo enviar el correo: ' + err.message + ')';
    }
  } else {
    mailMsg = ' (sin email — copia el link de pago de la tabla)';
  }

  res.redirect('/admin?msg=' + encodeURIComponent(`Cobro creado para ${contact.name || contact.email}${mailMsg}`));
});

// Reenviar el correo de cobro
app.post('/admin/orden/:id/cobrar-reenviar', async (req, res) => {
  const o = await db.orderWithContact(req.params.id);
  if (!o || !o.payment_url) return res.redirect('/admin?t=err&msg=Orden sin link');
  if (!o.contact_email) return res.redirect('/admin?t=err&msg=' + encodeURIComponent('Ese contacto no tiene email'));
  try {
    await sendEmail({
      to: o.contact_email,
      subject: `Recordatorio: tu boleto para ${eventConfig.event.title}`,
      html: paymentEmailHtml({
        name: o.contact_name, tierName: o.tier_name, perks: JSON.parse(o.perks || '[]'),
        amountCents: o.amount_cents, currency: o.currency, paymentUrl: o.payment_url,
      }),
    });
    res.redirect('/admin?msg=' + encodeURIComponent('Cobro reenviado'));
  } catch (err) {
    res.redirect('/admin?t=err&msg=' + encodeURIComponent('Error: ' + err.message));
  }
});

// Marcar pagado a mano (Zelle/efectivo) y enviar boleto
app.post('/admin/orden/:id/marcar-pagado', async (req, res) => {
  const o = await db.getOrder(req.params.id);
  if (!o) return res.redirect('/admin?t=err&msg=Orden no encontrada');
  await fulfillOrder(o.id);
  res.redirect('/admin?msg=' + encodeURIComponent('Marcado como pagado y boleto enviado'));
});

// =========================================================
//  PANEL — CONTACTOS (CRM)
// =========================================================
app.get('/admin/contactos', async (req, res) => {
  const contacts = await db.listContacts();
  const rows = contacts.map((c) => `
    <tr>
      <td><b>${esc(c.name)}</b></td>
      <td>${esc(c.phone || '—')}</td>
      <td>${esc(c.email || '—')}</td>
      <td>${esc(c.notes || '')}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Sin contactos todavía.</td></tr>';

  res.send(adminLayout({
    title: 'Contactos',
    active: 'contacts',
    body: `
      ${flash(req.query.msg, req.query.t || 'ok')}
      <div class="panel">
        <h2>➕ Agregar contacto</h2>
        <form method="POST" action="/admin/contactos">
          <div class="row">
            <label>Nombre<input name="name" required/></label>
            <label>Teléfono<input name="phone"/></label>
            <label>Email<input name="email" type="email"/></label>
          </div>
          <label>Notas<input name="notes" placeholder="Ej: interesado en VIP, llamar el viernes"/></label>
          <button class="btn primary" style="margin-top:14px">Guardar contacto</button>
        </form>
      </div>
      <div class="panel">
        <h2>📇 Mis contactos (${contacts.length})</h2>
        <table>
          <thead><tr><th>Nombre</th><th>Teléfono</th><th>Email</th><th>Notas</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`,
  }));
});

app.post('/admin/contactos', async (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name) return res.redirect('/admin/contactos?t=err&msg=Falta el nombre');
  await db.createContact({ name, phone, email, notes });
  res.redirect('/admin/contactos?msg=' + encodeURIComponent('Contacto guardado'));
});

// =========================================================
//  PANEL — ESCÁNER DE ENTRADA
// =========================================================
app.get('/admin/scan', async (req, res) => {
  const s = await db.stats();
  res.send(adminLayout({
    title: 'Escanear',
    active: 'scan',
    body: `
      <div class="panel">
        <h2>📷 Escáner de entrada</h2>
        <p class="muted">Apunta la cámara al QR del boleto. Verás al instante quién está registrado.</p>
        <div class="statgrid" style="margin-bottom:16px">
          <div class="stat"><div class="n" id="cIn">${s.checked}</div><div class="l">Han entrado</div></div>
          <div class="stat"><div class="n">${s.paid}</div><div class="l">Boletos válidos</div></div>
        </div>
        <div id="reader"></div>
        <div id="result" class="scanresult"></div>
      </div>
      <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
      <script>
        const resEl = document.getElementById('result');
        const cInEl = document.getElementById('cIn');
        let busy = false, lastText = '', lastTime = 0;

        function show(cls, html){ resEl.className = 'scanresult show ' + cls; resEl.innerHTML = html; }

        function extractToken(text){
          try { const u = new URL(text); const m = u.pathname.match(/\\/t\\/([a-f0-9]+)/i); if (m) return m[1]; } catch(e){}
          const m2 = String(text).match(/([a-f0-9]{16,})/i); return m2 ? m2[1] : text;
        }

        async function onScan(text){
          const nowT = Date.now();
          if (busy) return;
          if (text === lastText && nowT - lastTime < 3000) return;
          lastText = text; lastTime = nowT; busy = true;
          const token = extractToken(text);
          try {
            const r = await fetch('/admin/api/checkin', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ token })
            });
            const d = await r.json();
            if (!d.valid) { show('red', '❌<div class="big">Boleto no válido</div>'); }
            else if (d.status !== 'paid') { show('amber', '⚠️<div class="big">'+d.name+'</div>Este boleto NO está pagado.'); }
            else if (d.already) {
              show('amber', '⚠️ Ya había entrado<div class="big">'+d.name+'</div>'+d.tier+'<br><span style="opacity:.8">Entró: '+d.checked_at+'</span>');
            } else {
              if (d.count != null) cInEl.textContent = d.count;
              show('green', '✓ Registrado<div class="big">'+d.name+'</div>'+d.tier+'<ul>'+d.perks.map(p=>'<li>'+p+'</li>').join('')+'</ul>');
            }
          } catch(e){ show('red', 'Error de conexión'); }
          setTimeout(()=>{ busy=false; }, 1200);
        }

        const scanner = new Html5Qrcode('reader');
        Html5Qrcode.getCameras().then(cams => {
          const camId = (cams.find(c=>/back|rear|trás|tras/i.test(c.label)) || cams[cams.length-1] || cams[0]).id;
          scanner.start(camId, { fps:10, qrbox:{width:240,height:240} }, onScan, ()=>{});
        }).catch(()=> show('red','No se pudo abrir la cámara. Da permiso de cámara y usa HTTPS o localhost.'));
      </script>
    `,
  }));
});

app.post('/admin/api/checkin', async (req, res) => {
  const order = await db.orderWithContactByToken(req.body.token);
  if (!order) return res.json({ valid: false });
  if (order.status !== 'paid') {
    return res.json({ valid: true, status: order.status, name: order.contact_name || 'Sin nombre' });
  }
  const already = order.checked_in === 1;
  if (!already) await db.checkIn(order.id);
  const s = await db.stats();
  res.json({
    valid: true,
    status: 'paid',
    already,
    name: order.contact_name || 'Sin nombre',
    tier: order.tier_name,
    perks: JSON.parse(order.perks || '[]'),
    checked_at: order.checked_in_at ? new Date(order.checked_in_at).toLocaleTimeString() : new Date().toLocaleTimeString(),
    count: s.checked,
  });
});

// =========================================================
//  PANEL — CORREOS (bandeja demo)
// =========================================================
app.get('/admin/outbox', (req, res) => {
  const dir = OUTBOX_DIR;
  let items = [];
  if (fs.existsSync(dir)) {
    items = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort().reverse();
  }
  const list = items.map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const to = (raw.match(/Para: (.*)/) || [])[1] || '';
    const subj = (raw.match(/Asunto: (.*)/) || [])[1] || '';
    return `<tr><td>${esc(to)}</td><td>${esc(subj)}</td><td><a class="btn ghost sm" href="/admin/outbox/${encodeURIComponent(f)}" target="_blank">Ver correo</a></td></tr>`;
  }).join('') || '<tr><td colspan="3" class="muted">Sin correos todavía.</td></tr>';

  res.send(adminLayout({
    title: 'Correos',
    active: 'outbox',
    body: `
      <div class="panel">
        <h2>📨 Bandeja de correos ${DEMO_EMAIL ? '(MODO DEMO)' : ''}</h2>
        ${DEMO_EMAIL
          ? '<div class="flash info">Estás en modo demo: los correos NO se envían de verdad, se guardan aquí para que veas cómo se ven. Configura RESEND_API_KEY para enviarlos.</div>'
          : '<div class="flash ok">Resend está configurado: los correos se envían de verdad. Esta bandeja solo muestra los del modo demo.</div>'}
        <table><thead><tr><th>Para</th><th>Asunto</th><th></th></tr></thead><tbody>${list}</tbody></table>
      </div>`,
  }));
});

app.get('/admin/outbox/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const p = path.join(OUTBOX_DIR, file);
  if (!p.endsWith('.html') || !fs.existsSync(p)) return res.status(404).send('No encontrado');
  res.send(fs.readFileSync(p, 'utf8'));
});

// ---------- Salud ----------
app.get('/health', (req, res) => res.json({ ok: true, demoPayments: DEMO_PAYMENTS, demoEmail: DEMO_EMAIL, dbPersistent: DB_PERSISTENT }));

// Manejo de errores (incluye fallos al inicializar la BD)
app.use((err, req, res, next) => {
  console.error('Error en la app:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Ocurrió un error. Revisa la configuración (base de datos / variables).');
});

// En local (no en Vercel) encendemos el servidor; en Vercel se exporta la app.
if (!process.env.VERCEL) {
  db.init().then(() => {
    app.listen(env.PORT, () => {
      console.log(`\n🎟️  ${eventConfig.event.title}`);
      console.log(`   Servidor en ${env.BASE_URL}  (puerto ${env.PORT})`);
      console.log(`   Panel:   ${env.BASE_URL}/admin   (contraseña: ${env.ADMIN_PASSWORD})`);
      console.log(`   Landing: ${env.BASE_URL}/evento`);
      console.log(`   Pagos:   ${DEMO_PAYMENTS ? '⚠️  MODO DEMO (sin Stripe)' : '✅ Stripe'}`);
      console.log(`   Correos: ${DEMO_EMAIL ? '⚠️  MODO DEMO (sin Resend)' : '✅ Resend'}`);
      console.log(`   Datos:   ${DB_PERSISTENT ? '✅ persistentes' : '⚠️  temporales'}\n`);
    });
  }).catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
}

export default app;
