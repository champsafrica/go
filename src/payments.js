import { createHash } from 'node:crypto';
import { addDays, addMonths, nowLocal } from './time.js';
import { notify } from './notify.js';
import { rand } from './pricing.js';
import { tx } from './db.js';
import { activateGiftCard } from './giftcards.js';

// PayFast is South Africa's most widely used card/EFT gateway. Without merchant
// credentials the app uses a simulated checkout page so every flow can be tried out.
const env = process.env;
export const payfastEnabled = () => Boolean(env.PAYFAST_MERCHANT_ID && env.PAYFAST_MERCHANT_KEY);
const payfastHost = () => (env.PAYFAST_SANDBOX === 'false' ? 'www.payfast.co.za' : 'sandbox.payfast.co.za');

export async function createPayment(db, { userId, amount, purpose, subscriptionId = null, item }) {
  const { lastInsertRowid } = await db.prepare(`INSERT INTO payments (user_id, amount, purpose, subscription_id, item, provider)
    VALUES (?, ?, ?, ?, ?, ?)`).run(userId, amount, purpose, subscriptionId, item, payfastEnabled() ? 'payfast' : 'simulated');
  return Number(lastInsertRowid);
}

function pfEncode(v) {
  return encodeURIComponent(String(v).trim()).replace(/%20/g, '+');
}

export function payfastSignature(fields, passphrase) {
  const pairs = Object.entries(fields).filter(([k, v]) => k !== 'signature' && v !== '' && v != null)
    .map(([k, v]) => `${k}=${pfEncode(v)}`);
  if (passphrase) pairs.push(`passphrase=${pfEncode(passphrase)}`);
  return createHash('md5').update(pairs.join('&')).digest('hex');
}

// Fields for the auto-submitting form that sends the passenger to PayFast.
export function payfastCheckout(payment, user, siteUrl) {
  const fields = {
    merchant_id: env.PAYFAST_MERCHANT_ID,
    merchant_key: env.PAYFAST_MERCHANT_KEY,
    return_url: `${siteUrl}/payments/${payment.id}/done`,
    cancel_url: `${siteUrl}${payment.purpose === 'giftcard' ? '/gift-cards' : '/passenger/billing'}`,
    notify_url: `${siteUrl}/payments/notify`,
    name_first: user.name.split(' ')[0],
    email_address: user.email,
    m_payment_id: String(payment.id),
    amount: payment.amount.toFixed(2),
    item_name: `Go Rides: ${payment.item}`
  };
  fields.signature = payfastSignature(fields, env.PAYFAST_PASSPHRASE);
  return { action: `https://${payfastHost()}/eng/process`, fields };
}

// PayFast Instant Transaction Notification: check the signature, ask PayFast to confirm
// the notification is genuine, check the amount, then mark the payment paid.
export async function handlePayfastNotify(db, body) {
  if (payfastSignature(body, env.PAYFAST_PASSPHRASE) !== body.signature) return 'bad signature';
  const params = new URLSearchParams(Object.entries(body).filter(([k]) => k !== 'signature')).toString();
  const check = await fetch(`https://${payfastHost()}/eng/query/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params
  }).then(r => r.text()).catch(() => 'ERROR');
  if (check.trim() !== 'VALID') return 'not validated';
  const payment = await db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(body.m_payment_id));
  if (!payment) return 'unknown payment';
  if (Math.abs(Number(body.amount_gross) - payment.amount) > 0.01) return 'amount mismatch';
  if (body.payment_status === 'COMPLETE') await markPaid(db, payment.id, body.pf_payment_id);
  return 'ok';
}

// Applies a successful payment: activates the plan or credits the ride balance.
export async function markPaid(db, paymentId, providerRef = null) {
  return tx(db, async db => {
    const p = await db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p || p.status === 'paid') return false;
    await db.prepare("UPDATE payments SET status = 'paid', provider_ref = ?, paid_at = datetime('now') WHERE id = ?")
      .run(providerRef, paymentId);
    if (p.purpose === 'topup') {
      await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, 'topup', ?)")
        .run(p.user_id, p.amount, p.item);
      await notify(db, p.user_id, 'Payment received', `${rand(p.amount)} added to your ride balance.`);
    } else if (p.purpose === 'giftcard') {
      await activateGiftCard(db, p.id);
    } else {
      const sub = await db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(p.subscription_id);
      const today = nowLocal().date;
      // A plan paid late starts today rather than on its original start date.
      const start = sub.period_start < today ? today : sub.period_start;
      await db.prepare("UPDATE subscriptions SET status = 'active', period_start = ?, period_end = ? WHERE id = ?")
        .run(start, addDays(addMonths(start, 1), -1), sub.id);
      await notify(db, p.user_id, 'Plan active', `Payment of ${rand(p.amount)} received. Your plan is active and your rides are being booked.`);
    }
    return true;
  });
}
