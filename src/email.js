import fs from 'node:fs';
import path from 'node:path';
import { Resend } from 'resend';
import { env, DEMO_EMAIL, eventConfig, OUTBOX_DIR } from './config.js';

const resend = DEMO_EMAIL ? null : new Resend(env.RESEND_API_KEY);
const outboxDir = OUTBOX_DIR;

function ensureOutbox() {
  if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
}

/**
 * Envía un correo. En modo demo lo guarda en data/outbox/ y lo registra.
 * attachments: [{ filename, content (Buffer) }]
 */
export async function sendEmail({ to, subject, html, attachments }) {
  if (DEMO_EMAIL) {
    ensureOutbox();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = (to || 'sin-destinatario').replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(outboxDir, `${stamp}__${safe}.html`);
    const header = `<!-- DEMO EMAIL\nPara: ${to}\nAsunto: ${subject}\nFecha: ${new Date().toLocaleString()}\n-->\n`;
    fs.writeFileSync(file, header + html);
    if (attachments?.length) {
      for (const a of attachments) {
        fs.writeFileSync(path.join(outboxDir, `${stamp}__${a.filename}`), a.content);
      }
    }
    console.log(`📧 [DEMO] Correo a ${to} — "${subject}" guardado en ${file}`);
    return { demo: true, file };
  }

  const payload = {
    from: env.EMAIL_FROM,
    to: [to],
    subject,
    html,
  };
  if (attachments?.length) {
    payload.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64'),
    }));
  }
  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend: ${JSON.stringify(error)}`);
  console.log(`📧 Correo enviado a ${to} — "${subject}" (id ${data?.id})`);
  return { id: data?.id };
}

// ---------- PLANTILLAS ----------
const brand = eventConfig.brand;
const ev = eventConfig.event;

function shell(inner) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2330">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:${brand.primaryColor};color:#fff;border-radius:16px 16px 0 0;padding:24px 28px">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">${brand.organizer || brand.name}</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${ev.title}</div>
    </div>
    <div style="background:#fff;border-radius:0 0 16px 16px;padding:28px;box-shadow:0 2px 10px rgba(0,0,0,.06)">
      ${inner}
    </div>
    <div style="text-align:center;color:#9aa0ad;font-size:12px;margin-top:16px">
      ${brand.name} · ${brand.contactEmail || ''}
    </div>
  </div></body></html>`;
}

function money(amountCents, currency) {
  const sym = (currency || 'usd').toLowerCase() === 'eur' ? '€' : '$';
  return sym + (amountCents / 100).toFixed(2);
}

// Correo de cobro (link de pago)
export function paymentEmailHtml({ name, tierName, perks, amountCents, currency, paymentUrl }) {
  const perksList = (perks || []).map((p) => `<li style="margin:4px 0">${p}</li>`).join('');
  return shell(`
    <p style="font-size:16px">Hola ${name || ''},</p>
    <p>Gracias por tu interés en <b>${ev.title}</b>. Aquí está tu enlace para completar el pago de tu boleto:</p>
    <div style="background:#f7f5ff;border:1px solid #e6e0ff;border-radius:12px;padding:16px;margin:16px 0">
      <div style="font-size:13px;color:#7c7c8a;text-transform:uppercase;letter-spacing:.05em">Tu boleto</div>
      <div style="font-size:18px;font-weight:800;margin:4px 0">${tierName} — ${money(amountCents, currency)}</div>
      <ul style="padding-left:18px;margin:8px 0;color:#444">${perksList}</ul>
    </div>
    <p style="text-align:center;margin:24px 0">
      <a href="${paymentUrl}" style="background:${brand.accentColor};color:#1a1a1a;font-weight:800;text-decoration:none;padding:14px 28px;border-radius:999px;display:inline-block">Pagar ${money(amountCents, currency)} →</a>
    </p>
    <p style="font-size:13px;color:#888">📅 ${ev.dateText} · ${ev.timeText}<br>📍 ${ev.venue}, ${ev.address}</p>
    <p style="font-size:12px;color:#aaa">Si el botón no abre, copia este enlace:<br>${paymentUrl}</p>
  `);
}

// Correo del boleto con QR
export function ticketEmailHtml({ name, tierName, perks, ticketUrl, surveyUrl, qrUrl }) {
  const perksList = (perks || []).map((p) => `<li style="margin:4px 0">${p}</li>`).join('');
  return shell(`
    <p style="font-size:16px">¡Listo, ${name || ''}! 🎉 Tu pago fue confirmado.</p>
    <p>Este es tu boleto para <b>${ev.title}</b>. Presenta el código QR en la entrada (puedes mostrarlo desde tu teléfono).</p>
    <div style="text-align:center;margin:20px 0">
      <img src="${qrUrl}" alt="Tu código QR" width="240" height="240" style="border:8px solid #fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.12)"/>
    </div>
    <div style="background:#f7f5ff;border:1px solid #e6e0ff;border-radius:12px;padding:16px;margin:16px 0">
      <div style="font-size:18px;font-weight:800">${tierName}</div>
      <div style="font-size:13px;color:#7c7c8a;margin-top:6px">Tu boleto incluye:</div>
      <ul style="padding-left:18px;margin:8px 0;color:#444">${perksList}</ul>
    </div>
    <p style="text-align:center;margin:18px 0">
      <a href="${ticketUrl}" style="background:${brand.primaryColor};color:#fff;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:999px;display:inline-block">Ver mi boleto en línea</a>
    </p>
    <div style="background:#fffaf0;border:1px solid #ffe6b3;border-radius:12px;padding:16px;margin:18px 0;text-align:center">
      <div style="font-weight:700;margin-bottom:6px">📝 Un último paso</div>
      <div style="font-size:14px;color:#555">Responde unas preguntas rápidas para que te recibamos mejor el día del evento.</div>
      <a href="${surveyUrl}" style="display:inline-block;margin-top:10px;color:${brand.primaryColor};font-weight:700;text-decoration:none">Responder formulario →</a>
    </div>
    <p style="font-size:13px;color:#888;text-align:center">📅 ${ev.dateText} · ${ev.timeText}<br>📍 ${ev.venue}, ${ev.address}</p>
  `);
}
