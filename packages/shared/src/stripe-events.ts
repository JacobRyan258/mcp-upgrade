/**
 * Which Stripe events this product acts on.
 *
 * Lives in shared rather than in the web app because it is read by two things
 * that must agree exactly: the webhook handler, which dispatches on it, and
 * `scripts/setup-stripe.ts`, which subscribes the Stripe endpoint to it. A
 * second copy in the setup script would mean adding a seventh event to the
 * handler and silently never receiving it.
 *
 * It is a plain list of strings on purpose — no Stripe types, no runtime
 * dependency — so this module stays as isomorphic as the rest of the package.
 */

export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export function isHandledEvent(type: string): type is HandledEvent {
  return (HANDLED_EVENTS as readonly string[]).includes(type);
}
