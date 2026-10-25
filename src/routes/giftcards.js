import { html } from '../views/html.js';
import { layout, csrf, field, empty } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { PRESETS, MIN_AMOUNT, MAX_AMOUNT, validAmount, buyGiftCard, issueGiftCard, redeemGiftCard, cancelGiftCard } from '../giftcards.js';
import { rand } from '../pricing.js';

const STATUS = { pending: ['Awaiting payment', 'unassigned'], active: ['Ready to use', 'scheduled'], redeemed: ['Used', 'completed'], cancelled: ['Cancelled', 'cancelled'] };
const statusPill = s => html`<span class="pill pill-${STATUS[s][1]}">${STATUS[s][0]}</span>`;

// Failed redemptions per user in the last hour, to slow down code guessing. Kept in
// memory: enough for one server, and codes are long enough that guessing is hopeless anyway.
const failures = new Map();
const tooManyFailures = id => (failures.get(id) ?? []).filter(t => Date.now() - t < 3600e3).length >= 10;
const recordFailure = id => failures.set(id, [...(failures.get(id) ?? []).filter(t => Date.now() - t < 3600e3), Date.now()]);

const cardArt = (amount, code = 'GO-XXXX-XXXX') => html`<div class="gift-card" aria-hidden="true">
  <img src="/brand/go-rides-logo.png" alt="" class="gc-logo"><span class="gc-label">GIFT CARD</span>
  <strong class="gc-amount">${rand(amount)}</strong><span class="gc-code">${code}</span></div>`;

export default function giftCardRoutes(app, db) {
  const page = async (req, res, { values = {}, error = '' } = {}) => {
    const u = req.user;
    const canBuy = u && ['passenger', 'business'].includes(u.role);
    const mine = canBuy ? await db.prepare('SELECT * FROM gift_cards WHERE purchaser_id = ? ORDER BY id DESC LIMIT 30').all(u.id) : [];
    const v = k => values[k] ?? '';
    const chosen = Number(values.amount) || 500;
    res.status(error ? 400 : 200).send(String(layout(req, { title: 'Gift cards', body: html`
      <section class="split gift-hero">
        <div>
          <h1>Go Rides gift cards</h1>
          <p class="lede">Give someone dependable rides to work, or a parcel sent across town. A gift card adds to their Go Rides balance, which pays for ride packs, rides and parcels. It never expires.</p>
        </div>
        ${cardArt(chosen)}
      </section>
      ${error ? html`<p class="flash err">${error}</p>` : ''}
      <div class="grid-2 gift-forms">
        <div class="card">
          <h2>Buy a gift card</h2>
          ${canBuy ? html`<form method="post" action="/gift-cards" class="form">${csrf(req)}
            <fieldset class="field"><legend>Amount</legend><div class="amounts">
              ${PRESETS.map(a => html`<label class="amount"><input type="radio" name="amount" value="${a}" ${a === chosen && !values.custom ? 'checked' : ''}><span>${rand(a)}</span></label>`)}
            </div></fieldset>
            ${field('Or another amount (R)', html`<input type="number" name="custom" min="${MIN_AMOUNT}" max="${MAX_AMOUNT}" step="1" value="${v('custom')}" inputmode="numeric">`, `Between ${rand(MIN_AMOUNT)} and ${rand(MAX_AMOUNT)}`)}
            ${field("Recipient's name", html`<input name="recipient_name" maxlength="80" value="${v('recipient_name')}">`)}
            ${field("Recipient's mobile (optional)", html`<input type="tel" name="recipient_phone" value="${v('recipient_phone')}">`, 'We SMS them the code')}
            ${field("Recipient's email (optional)", html`<input type="email" name="recipient_email" value="${v('recipient_email')}">`)}
            ${field('Message (optional)', html`<input name="message" maxlength="140" value="${v('message')}">`)}
            <button class="btn">Continue to payment</button>
          </form>` : html`<p>Log in or create a free account to buy a gift card.</p>
            <div class="row"><a class="btn" href="/login?next=/gift-cards">Log in</a><a class="btn btn-ghost" href="/register?as=passenger">Sign up</a></div>`}
        </div>
        <div class="card">
          <h2>Redeem a gift card</h2>
          ${u?.role === 'passenger' ? html`<form method="post" action="/gift-cards/redeem" class="form">${csrf(req)}
            ${field('Gift card code', html`<input name="code" required placeholder="GO-XXXX-XXXX" autocomplete="off" autocapitalize="characters" value="${v('code')}">`)}
            <button class="btn">Add to my balance</button></form>`
            : html`<p>Gift cards are redeemed into a passenger's ride balance. ${u ? '' : html`<a href="/login?next=/gift-cards">Log in</a> or <a href="/register?as=passenger">sign up</a> to redeem one.`}</p>`}
          <p class="muted" style="margin-top:14px">Gift cards never expire, can be used once, and are not exchangeable for cash.</p>
        </div>
      </div>
      ${canBuy ? html`<h2>Gift cards you bought</h2>
        ${mine.length ? mine.map(c => html`<article class="card"><div class="row-between"><strong>${rand(c.amount)}${c.recipient_name ? ` for ${c.recipient_name}` : ''}</strong>${statusPill(c.status)}</div>
          ${['active', 'redeemed'].includes(c.status) ? html`<p>Code: <strong class="code">${c.code}</strong></p>` : ''}
          ${c.status === 'pending' ? html`<p><a class="btn btn-sm" href="/payments/${c.payment_id}/checkout">Pay now</a></p>` : ''}</article>`)
          : empty('None yet.')}` : ''}` })));
  };

  app.get('/gift-cards', async (req, res) => page(req, res));

  app.post('/gift-cards', requireRole('passenger', 'business'), async (req, res) => {
    const b = req.body;
    const amount = b.custom ? Number(b.custom) : Number(b.amount);
    const details = {
      amount, recipient_name: String(b.recipient_name ?? '').trim().slice(0, 80), recipient_phone: String(b.recipient_phone ?? '').trim().slice(0, 20),
      recipient_email: String(b.recipient_email ?? '').trim().slice(0, 120), message: String(b.message ?? '').trim().slice(0, 140)
    };
    if (!validAmount(amount)) return page(req, res, { values: { ...b }, error: `Choose a whole amount between ${rand(MIN_AMOUNT)} and ${rand(MAX_AMOUNT)}.` });
    if (details.recipient_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(details.recipient_email)) return page(req, res, { values: { ...b }, error: 'That email address does not look right.' });
    const { paymentId } = await buyGiftCard(db, req.user, details);
    res.redirect(`/payments/${paymentId}/checkout`);
  });

  app.post('/gift-cards/redeem', requireRole('passenger'), async (req, res) => {
    if (tooManyFailures(req.user.id)) return page(req, res, { error: 'Too many attempts. Please try again in an hour.' });
    const out = await redeemGiftCard(db, req.user.id, req.body.code);
    if (out.error) { recordFailure(req.user.id); return page(req, res, { values: { code: req.body.code }, error: out.error }); }
    res.redirect(`/passenger/billing?ok=${encodeURIComponent(`Gift card redeemed: ${rand(out.amount)} added to your ride balance.`)}`);
  });

  // Admin: every card, and complimentary cards for promotions, apologies or partners.
  const admin = requireRole('admin');
  app.get('/admin/gift-cards', admin, async (req, res) => {
    const cards = await db.prepare(`SELECT g.*, pu.name AS purchaser, ru.name AS redeemer FROM gift_cards g
      LEFT JOIN users pu ON pu.id = g.purchaser_id LEFT JOIN users ru ON ru.id = g.redeemed_by ORDER BY g.id DESC LIMIT 300`).all();
    const sold = cards.filter(c => c.purchaser_id && c.status !== 'pending' && c.status !== 'cancelled').reduce((a, c) => a + c.amount, 0);
    const outstanding = cards.filter(c => c.status === 'active').reduce((a, c) => a + c.amount, 0);
    res.send(String(layout(req, { title: 'Gift cards', wide: true, body: html`
      <h1>Gift cards</h1>
      <div class="grid-3"><div class="card stat"><span>Sold (paid)</span><strong>${rand(sold)}</strong></div>
        <div class="card stat"><span>Not yet redeemed</span><strong>${rand(outstanding)}</strong><small class="muted">owed as future rides</small></div>
        <div class="card stat"><span>Cards</span><strong>${cards.length}</strong></div></div>
      <form method="post" action="/admin/gift-cards" class="form card">${csrf(req)}<h3>Issue a complimentary card</h3>
        <div class="grid-2">${field('Amount (R)', html`<input type="number" name="amount" min="${MIN_AMOUNT}" max="${MAX_AMOUNT}" required>`)}
          ${field("Recipient's name", html`<input name="recipient_name" required>`)}
          ${field("Recipient's mobile", html`<input type="tel" name="recipient_phone">`)}
          ${field("Recipient's email", html`<input type="email" name="recipient_email">`)}</div>
        ${field('Message', html`<input name="message" maxlength="140">`)}
        <button class="btn btn-sm">Issue card</button></form>
      ${cards.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th class="num">Amount</th><th>From</th><th>For</th><th>Status</th><th></th></tr></thead><tbody>
        ${cards.map(c => html`<tr><td><strong class="code">${c.code}</strong><br><small>${c.created_at.slice(0, 10)}</small></td><td class="num">${rand(c.amount)}</td>
          <td>${c.purchaser ?? html`<span class="muted">Complimentary</span>`}</td><td>${c.recipient_name ?? ''}${c.redeemer ? html`<br><small>used by ${c.redeemer}</small>` : ''}</td>
          <td>${statusPill(c.status)}</td>
          <td>${['pending', 'active'].includes(c.status) ? html`<form method="post" action="/admin/gift-cards/${c.id}/cancel">${csrf(req)}<button class="link danger" data-confirm="Cancel this gift card? It can no longer be used.">Cancel</button></form>` : ''}</td></tr>`)}</tbody></table></div>`
        : empty('No gift cards yet.')}` })));
  });

  app.post('/admin/gift-cards', admin, async (req, res) => {
    const b = req.body;
    const amount = Number(b.amount);
    if (!validAmount(amount) || !String(b.recipient_name ?? '').trim()) return res.redirect(`/admin/gift-cards?err=${encodeURIComponent(`Enter a recipient and a whole amount between ${rand(MIN_AMOUNT)} and ${rand(MAX_AMOUNT)}.`)}`);
    const card = await issueGiftCard(db, req.user.id, { amount, recipient_name: b.recipient_name.trim(), recipient_phone: b.recipient_phone?.trim(), recipient_email: b.recipient_email?.trim(), message: b.message?.trim() });
    res.redirect(`/admin/gift-cards?ok=${encodeURIComponent(`Issued ${card.code} for ${rand(amount)}.`)}`);
  });

  app.post('/admin/gift-cards/:id/cancel', admin, async (req, res) => {
    const ok = await cancelGiftCard(db, Number(req.params.id));
    res.redirect(ok ? '/admin/gift-cards?ok=Gift card cancelled.' : '/admin/gift-cards?err=That card can no longer be cancelled.');
  });
}
