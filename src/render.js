import { eventConfig, currencySymbol } from './config.js';

const brand = eventConfig.brand;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export function money(amountCents) {
  return currencySymbol() + (amountCents / 100).toFixed(2);
}

const cssVars = `:root{--primary:${brand.primaryColor};--accent:${brand.accentColor};}`;

// Layout público (landing, ticket, formulario) — con la marca del evento
export function publicLayout({ title, body, wide = false }) {
  return `<!doctype html><html lang="es"><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(title)}</title>
  <style>${cssVars}</style>
  <link rel="stylesheet" href="/styles.css"/>
  </head><body class="pub">
    <div class="container ${wide ? 'wide' : ''}">${body}</div>
  </body></html>`;
}

// Layout del panel de administración
export function adminLayout({ title, body, active }) {
  const link = (href, label, key) =>
    `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  return `<!doctype html><html lang="es"><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(title)} · Panel</title>
  <style>${cssVars}</style>
  <link rel="stylesheet" href="/styles.css"/>
  </head><body class="admin">
    <header class="topbar">
      <div class="brand">🎟️ ${esc(brand.name)}</div>
      <nav>
        ${link('/admin', 'Tablero', 'home')}
        ${link('/admin/contactos', 'Contactos', 'contacts')}
        ${link('/admin/scan', 'Escanear', 'scan')}
        ${link('/admin/outbox', 'Correos', 'outbox')}
        <a href="/evento" target="_blank">Ver landing ↗</a>
        <a href="/admin/logout" class="logout">Salir</a>
      </nav>
    </header>
    <main class="content">${body}</main>
  </body></html>`;
}

export function flash(msg, type = 'ok') {
  if (!msg) return '';
  return `<div class="flash ${type}">${esc(msg)}</div>`;
}
