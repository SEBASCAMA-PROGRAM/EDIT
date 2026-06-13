import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Carga config/event.json
const eventConfigPath = path.join(root, 'config', 'event.json');
export const eventConfig = JSON.parse(fs.readFileSync(eventConfigPath, 'utf8'));

export const ROOT = root;

export const env = {
  BASE_URL: (process.env.BASE_URL || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` || 'http://localhost:3000').replace(/\/$/, ''),
  PORT: parseInt(process.env.PORT || '3000', 10),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'cambiame123',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-secret-cambiame',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || 'onboarding@resend.dev',
};

// Configuración de la base de datos. Prioridad:
//  1. DATABASE_URL  -> Postgres / Supabase  (persistente, ideal para Vercel)
//  2. TURSO_DATABASE_URL -> libSQL en la nube (alternativa)
//  3. Sin ninguna, en Vercel -> archivo temporal en /tmp (demo, NO persistente)
//  4. Sin ninguna, en local  -> archivo en ./data/app.db
const onVercel = !!process.env.VERCEL;
export const DB_DRIVER = process.env.DATABASE_URL ? 'postgres' : 'libsql';

export const pgConfig = {
  connectionString: process.env.DATABASE_URL,
  // Supabase requiere SSL
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
};

export const libsqlConfig = process.env.TURSO_DATABASE_URL
  ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
  : { url: `file:${onVercel ? '/tmp/app.db' : path.join(root, 'data', 'app.db')}` };

export const DB_PERSISTENT =
  !!process.env.DATABASE_URL || !!process.env.TURSO_DATABASE_URL || !onVercel;

// Carpeta de la bandeja demo (en Vercel el disco es de solo lectura salvo /tmp)
export const OUTBOX_DIR = onVercel ? '/tmp/outbox' : path.join(root, 'data', 'outbox');

// Modo demo: si no hay llaves reales, la app simula pagos/correos.
export const DEMO_PAYMENTS = !env.STRIPE_SECRET_KEY;
export const DEMO_EMAIL = !env.RESEND_API_KEY;

export function getTier(id) {
  return eventConfig.tiers.find((t) => t.id === id) || null;
}

export function currencySymbol() {
  const c = (eventConfig.currency || 'usd').toLowerCase();
  return c === 'usd' ? '$' : c === 'mxn' ? '$' : c === 'eur' ? '€' : '$';
}
