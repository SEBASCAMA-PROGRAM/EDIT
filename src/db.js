import { createClient } from '@libsql/client';
import crypto from 'node:crypto';
import { dbConfig } from './config.js';

const client = createClient(dbConfig);

// ---- helpers de bajo nivel ----
const nz = (v) => (v === undefined ? null : v); // libSQL no acepta undefined
async function run(sql, args = []) {
  return client.execute({ sql, args: args.map(nz) });
}
async function get(sql, args = []) {
  const r = await client.execute({ sql, args: args.map(nz) });
  return r.rows[0] || null;
}
async function all(sql, args = []) {
  const r = await client.execute({ sql, args: args.map(nz) });
  return r.rows;
}
const lastId = (r) => Number(r.lastInsertRowid);

const nowIso = () => new Date().toISOString();
export const token = (n = 16) => crypto.randomBytes(n).toString('hex');

// ---- creación de tablas (idempotente) ----
let initPromise = null;
export function init() {
  if (!initPromise) {
    initPromise = client.executeMultiple(`
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
        perks TEXT,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT DEFAULT 'crm',
        stripe_session_id TEXT,
        payment_url TEXT,
        ticket_token TEXT UNIQUE,
        checked_in INTEGER NOT NULL DEFAULT 0,
        checked_in_at TEXT,
        survey_json TEXT,
        created_at TEXT NOT NULL,
        paid_at TEXT
      );
    `);
  }
  return initPromise;
}

// ---------- CONTACTS ----------
export async function createContact({ name, phone, email, notes }) {
  const r = await run(
    'INSERT INTO contacts (name, phone, email, notes, created_at) VALUES (?, ?, ?, ?, ?)',
    [name, phone, email, notes, nowIso()]
  );
  return getContact(lastId(r));
}

export function getContact(id) {
  return get('SELECT * FROM contacts WHERE id = ?', [id]);
}

export function findContactByEmail(email) {
  if (!email) return null;
  return get('SELECT * FROM contacts WHERE lower(email) = lower(?)', [email]);
}

export function listContacts() {
  return all('SELECT * FROM contacts ORDER BY created_at DESC');
}

// ---------- ORDERS ----------
export async function createOrder(o) {
  const r = await run(
    `INSERT INTO orders
      (contact_id, tier_id, tier_name, perks, amount_cents, currency, status, source, ticket_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.contact_id, o.tier_id, o.tier_name, JSON.stringify(o.perks || []),
      o.amount_cents, o.currency, o.status || 'pending', o.source || 'crm',
      token(16), nowIso(),
    ]
  );
  return getOrder(lastId(r));
}

export function getOrder(id) {
  return get('SELECT * FROM orders WHERE id = ?', [id]);
}

export function getOrderByToken(t) {
  return get('SELECT * FROM orders WHERE ticket_token = ?', [t]);
}

export async function setOrderSession(id, sessionId, url) {
  await run('UPDATE orders SET stripe_session_id=?, payment_url=? WHERE id=?', [sessionId, url, id]);
  return getOrder(id);
}

export async function markPaid(id) {
  await run("UPDATE orders SET status='paid', paid_at=? WHERE id=?", [nowIso(), id]);
  return getOrder(id);
}

export async function checkIn(id) {
  await run('UPDATE orders SET checked_in=1, checked_in_at=? WHERE id=?', [nowIso(), id]);
  return getOrder(id);
}

export async function saveSurvey(id, answers) {
  await run('UPDATE orders SET survey_json=? WHERE id=?', [JSON.stringify(answers), id]);
  return getOrder(id);
}

export function listOrders(filter = {}) {
  let sql = `
    SELECT o.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id`;
  const args = [];
  if (filter.status) { sql += ' WHERE o.status = ?'; args.push(filter.status); }
  sql += ' ORDER BY o.created_at DESC';
  return all(sql, args);
}

export function orderWithContact(id) {
  return get(`
    SELECT o.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.id = ?`, [id]);
}

export function orderWithContactByToken(t) {
  return get(`
    SELECT o.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id WHERE o.ticket_token = ?`, [t]);
}

export async function stats() {
  const paid = (await get("SELECT COUNT(*) n FROM orders WHERE status='paid'")).n;
  const pending = (await get("SELECT COUNT(*) n FROM orders WHERE status='pending'")).n;
  const checked = (await get("SELECT COUNT(*) n FROM orders WHERE status='paid' AND checked_in=1")).n;
  const revenue = (await get("SELECT COALESCE(SUM(amount_cents),0) s FROM orders WHERE status='paid'")).s;
  const contacts = (await get('SELECT COUNT(*) n FROM contacts')).n;
  return { paid: Number(paid), pending: Number(pending), checked: Number(checked), revenue: Number(revenue), contacts: Number(contacts) };
}
