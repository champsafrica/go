import { randomInt } from 'node:crypto';
import { tx } from './db.js';
import { createPayment } from './payments.js';
import { notify, sendDirect, sendDirectEmail } from './notify.js';
import { rand } from './pricing.js';

// Go Rides gift cards: bought by a passenger or employer (or issued free by an admin),
// delivered to the recipient, and redeemed once into a passenger's ride balance.

export const MIN_AMOUNT = 100;
export const MAX_AMOUNT = 5000;
export const PRESETS = [200, 500, 1000, 2000];

// No 0/O or 1/I, so codes read clearly over the phone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `GO-${part()}-${part()}`;
}
export const normaliseCode = c => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^GO/, '').replace(/^(.{4})(.{4})$/, 'GO-$1-$2');

export function validAmount(amount) {
  return Number.isInteger(amount) && amount >= MIN_AMOUNT && amount <= MAX_AMOUNT;
}

async function insertCard(db, card) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    if (await db.prepare('SELECT 1 FROM gift_cards WHERE code = ?').get(code)) continue;
    const { lastInsertRowid } = await db.prepare(`INSERT INTO gift_cards (code, amount, purchaser_id, payment_id, recipient_name, recipient_email,
      recipient_phone, message, status, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, card.amount, card.purchaser_id ?? null,
      card.payment_id ?? null, card.recipient_name || null, card.recipient_email || null, card.recipient_phone || null, card.message || null,
      card.status, card.issued_by ?? null);
    return db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(lastInsertRowid);
  }
  throw new Error('Could not create a unique gift card code');
}

// A bought card waits for its payment; returns the payment to send the buyer to.
export async function buyGiftCard(db, buyer, details) {
  return tx(db, async db => {
    const paymentId = await createPayment(db, { userId: buyer.id, amount: details.amount, purpose: 'giftcard', item: `Go Rides gift card, ${rand(details.amount)}` });
    const card = await insertCard(db, { ...details, purchaser_id: buyer.id, payment_id: paymentId, status: 'pending' });
    return { card, paymentId };
  });
}

export async function issueGiftCard(db, adminId, details) {
  const card = await insertCard(db, { ...details, issued_by: adminId, status: 'active' });
  await deliver(db, card, 'Go Rides');
  return card;
}

// Sends the code to the recipient by SMS and email where we have them.
async function deliver(db, card, from) {
  const text = `${from} sent you a Go Rides gift card worth ${rand(card.amount)}${card.message ? `: "${card.message}"` : ''}. Your code is ${card.code}. Redeem it in Go Rides under Gift cards.`;
  if (card.recipient_phone) sendDirect(card.recipient_phone, text);
  if (card.recipient_email) sendDirectEmail(card.recipient_email, `You have a Go Rides gift card worth ${rand(card.amount)}`, text);
}

// Called by markPaid once a gift card payment succeeds.
export async function activateGiftCard(db, paymentId) {
  const card = await db.prepare("SELECT * FROM gift_cards WHERE payment_id = ? AND status = 'pending'").get(paymentId);
  if (!card) return null;
  await db.prepare("UPDATE gift_cards SET status = 'active' WHERE id = ?").run(card.id);
  const buyer = await db.prepare('SELECT name FROM users WHERE id = ?').get(card.purchaser_id);
  await notify(db, card.purchaser_id, 'Gift card ready',
    `Your ${rand(card.amount)} gift card code is ${card.code}.${card.recipient_phone || card.recipient_email ? ` We have sent it to ${card.recipient_name || 'the recipient'}.` : ' Share it with whoever you like.'}`);
  await deliver(db, { ...card, status: 'active' }, buyer?.name ?? 'Someone');
  return card;
}

export async function redeemGiftCard(db, passengerId, rawCode) {
  const code = normaliseCode(rawCode);
  return tx(db, async db => {
    const card = await db.prepare('SELECT * FROM gift_cards WHERE code = ?').get(code);
    if (!card || card.status === 'pending' || card.status === 'cancelled') return { error: 'That gift card code is not valid.' };
    if (card.status === 'redeemed') return { error: 'That gift card has already been used.' };
    await db.prepare("UPDATE gift_cards SET status = 'redeemed', redeemed_by = ?, redeemed_at = datetime('now') WHERE id = ?").run(passengerId, card.id);
    await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, 'topup', ?)")
      .run(passengerId, card.amount, `Gift card ${card.code}`);
    await notify(db, passengerId, 'Gift card redeemed', `${rand(card.amount)} has been added to your ride balance.`);
    return { amount: card.amount };
  });
}

export async function cancelGiftCard(db, id) {
  const { changes } = await db.prepare("UPDATE gift_cards SET status = 'cancelled' WHERE id = ? AND status IN ('pending','active')").run(id);
  return changes === 1;
}
