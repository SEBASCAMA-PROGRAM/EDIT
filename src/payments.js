import Stripe from 'stripe';
import { env, DEMO_PAYMENTS, eventConfig } from './config.js';

const stripe = DEMO_PAYMENTS ? null : new Stripe(env.STRIPE_SECRET_KEY);

export { stripe, DEMO_PAYMENTS };

/**
 * Crea la sesión de pago para una orden y devuelve { id, url }.
 * En modo demo devuelve una URL interna que simula la pasarela.
 */
export async function createCheckout(order, { contactEmail } = {}) {
  if (DEMO_PAYMENTS) {
    return { id: `demo_${order.id}`, url: `${env.BASE_URL}/demo/pay/${order.id}` };
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: contactEmail || undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: order.currency,
          unit_amount: order.amount_cents,
          product_data: {
            name: `${eventConfig.event.title} — ${order.tier_name}`,
            description: (JSON.parse(order.perks || '[]') || []).join(' · ') || undefined,
          },
        },
      },
    ],
    metadata: { order_id: String(order.id), ticket_token: order.ticket_token },
    success_url: `${env.BASE_URL}/gracias?token=${order.ticket_token}`,
    cancel_url: `${env.BASE_URL}/pago-cancelado?token=${order.ticket_token}`,
  });

  return { id: session.id, url: session.url };
}

/** Consulta a Stripe si la sesión ya fue pagada (red de seguridad sin webhook). */
export async function isSessionPaid(sessionId) {
  if (DEMO_PAYMENTS || !sessionId || sessionId.startsWith('demo_')) return false;
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    return s.payment_status === 'paid';
  } catch {
    return false;
  }
}

/** Verifica y construye el evento del webhook de Stripe. */
export function constructWebhookEvent(rawBody, signature) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    // Sin secreto configurado: parseo directo (solo para pruebas locales).
    return JSON.parse(rawBody.toString('utf8'));
  }
  return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}
