import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT } from './config.js';

const db = new DatabaseSync(path.join(ROOT, 'data', 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER,
    tier_id TEXT,
    tier_name TEXT NOT NULL,
    perks TEXT,                 -- JSON array de lo que incluye
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | canceled
    source TEXT DEFAULT 'crm',  -- crm | landing
    stripe_session_id TEXT,
    payment_url TEXT,
    ticket_token TEXT UNIQUE,
    checked_in INTEGER NOT NULL DEFAULT 0,
    checked_in_at TEXT,
    survey_json TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
  );
`);

const now = () => new Date().toISOString();
export const token = (n = 16) => crypto.randomBytes(n).toString('hex');

// ---------- CONTACTS ----------
export function createContact({ name, phone, email, notes }) {
  const stmt = db.prepare(
    'INSERT INTO contacts (name, phone, email, notes, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const r = stmt.run(name, phone || null, email || null, notes || null, now());
  return getContact(r.lastInsertRowid);
}

export function getContact(id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) || null;
}

export function findContactByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM contacts WHERE lower(email) = lower(?)').get(email) || null;
}

export function updateContact(id, { name, phone, email, notes }) {
  db.prepare('UPDATE contacts SET name=?, phone=?, email=?, notes=? WHERE id=?')
    .run(name, phone || null, email || null, notes || null, id);
  return getContact(id);
}

export function listContacts() {
  return db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
}

// ---------- ORDERS ----------
export function createOrder(o) {
  const stmt = db.prepare(`
    INSERT INTO orders
      (contact_id, tier_id, tier_name, perks, amount_cents, currency, status, source, ticket_token, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    o.contact_id ?? null,
    o.tier_id ?? null,
    o.tier_name,
    JSON.stringify(o.perks || []),
    o.amount_cents,
    o.currency,
    o.status || 'pending',
    o.source || 'crm',
    token(16),
    now()
  );
  return getOrder(r.lastInsertRowid);
}

export function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

export function getOrderByToken(t) {
  return db.prepare('SELECT * FROM orders WHERE ticket_token = ?').get(t) || null;
}

export function getOrderBySession(sid) {
  return db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(sid) || null;
}

export function setOrderSession(id, sessionId, url) {
  db.prepare('UPDATE orders SET stripe_session_id=?, payment_url=? WHERE id=?')
    .run(sessionId, url, id);
  return getOrder(id);
}

export function markPaid(id) {
  db.prepare("UPDATE orders SET status='paid', paid_at=? WHERE id=?").run(now(), id);
  return getOrder(id);
}

export function markCanceled(id) {
  db.prepare("UPDATE orders SET status='canceled' WHERE id=?").run(id);
  return getOrder(id);
}

export function checkIn(id) {
  db.prepare('UPDATE orders SET checked_in=1, checked_in_at=? WHERE id=?').run(now(), id);
  return getOrder(id);
}

export function saveSurvey(id, answers) {
  db.prepare('UPDATE orders SET survey_json=? WHERE id=?').run(JSON.stringify(answers), id);
  return getOrder(id);
}

// Lista de órdenes con datos del contacto (join), para el panel
export function listOrders(filter = {}) {
  let sql = `
    SELECT o.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
  `;
  const where = [];
  const args = [];
  if (filter.status) { where.push('o.status = ?'); args.push(filter.status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY o.created_at DESC';
  return db.prepare(sql).all(...args);
}

export function orderWithContact(id) {
  return db.prepare(`
    SELECT o.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.id = ?
  `).get(id) || null;
}

export function orderWithContactByToken(t) {
  return db.prepare(`
    SELECT o.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.ticket_token = ?
  `).get(t) || null;
}

export function stats() {
  const paid = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid'").get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='pending'").get().n;
  const checked = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid' AND checked_in=1").get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM orders WHERE status='paid'").get().s;
  const contacts = db.prepare('SELECT COUNT(*) n FROM contacts').get().n;
  return { paid, pending, checked, revenue, contacts };
}

export default db;
