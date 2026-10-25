import { html } from '../views/html.js';
import { layout, csrf, field, empty } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { getSettings } from '../db.js';
import { walletBalance } from '../booking.js';
import { SIZES, parcelPrice, bookParcel, cancelParcel, sendRecipientCode } from '../parcels.js';
import { zoneSelect } from './public.js';
import { ZONES } from '../config.js';
import { rand } from '../pricing.js';
import { nowLocal, addDays, formatDate } from '../time.js';

export const PARCEL_STATUS = {
  unmatched: 'Finding a run', booked: 'Booked on a run', collected: 'On its way', delivered: 'Delivered', cancelled: 'Cancelled'
};
const PARCEL_PILL = { unmatched: 'unassigned', booked: 'scheduled', collected: 'en_route', delivered: 'completed', cancelled: 'cancelled' };
export const parcelPill = s => html`<span class="pill pill-${PARCEL_PILL[s]}">${PARCEL_STATUS[s]}</span>`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function parcelRoutes(app, db) {
  const only = requireRole('passenger', 'business');

  const page = async (req, res, values = {}, error = '') => {
    const s = await getSettings(db);
    const today = nowLocal().date;
    const parcels = await db.prepare(`SELECT pa.*, t.pickup_time FROM parcels pa LEFT JOIN trips t ON t.id = pa.trip_id
      WHERE pa.sender_id = ? ORDER BY pa.date DESC, pa.id DESC LIMIT 50`).all(req.user.id);
    const balance = req.user.role === 'passenger' ? await walletBalance(db, req.user.id) : null;
    const v = k => values[k] ?? '';
    res.status(error ? 400 : 200).send(String(layout(req, { title: 'Go Parcels', body: html`
      <h1>Go Parcels</h1>
      <p class="lede">Send a parcel on a driver's daily route. It travels on a scheduled commute run, so it costs a fixed, low price and arrives the same day.</p>
      ${error ? html`<p class="flash err">${error}</p>` : ''}
      <form method="post" action="/parcels" class="form card">${csrf(req)}
        <div class="grid-2">
          ${field('From area', zoneSelect('from_zone', v('from_zone')))}
          ${field('To area', zoneSelect('to_zone', v('to_zone')))}
          ${field('Collection address', html`<input name="pickup_address" required value="${v('pickup_address')}">`)}
          ${field('Delivery address', html`<input name="dropoff_address" required value="${v('dropoff_address')}">`)}
          ${field("Recipient's name", html`<input name="recipient_name" required value="${v('recipient_name')}">`)}
          ${field("Recipient's mobile", html`<input type="tel" name="recipient_phone" required value="${v('recipient_phone')}">`, 'We send them a code to give the driver')}
          ${field('Date', html`<input type="date" name="date" required min="${today}" max="${addDays(today, s.booking_horizon_days - 1)}" value="${v('date') || addDays(today, 1)}">`)}
          ${field('What is it? (optional)', html`<input name="description" maxlength="120" value="${v('description')}">`)}
        </div>
        <fieldset class="field"><legend>Size</legend>
          <div class="size-options">${Object.entries(SIZES).map(([k, label]) => html`<label class="size-option">
            <input type="radio" name="size" value="${k}" required ${(v('size') || 'small') === k ? 'checked' : ''}>
            <span><strong>${rand(parcelPrice(k, s))}</strong>${label}</span></label>`)}</div></fieldset>
        <p class="muted">${req.user.role === 'business' ? 'Billed to your company on the monthly invoice.' : html`Paid from your ride balance (${rand(balance)}). <a href="/passenger/billing#packs">Top up</a>`}</p>
        <button class="btn">Send parcel</button>
      </form>
      <h2>Your parcels</h2>
      ${parcels.length ? parcels.map(p => html`<article class="card">
        <div class="row-between"><strong>${p.from_zone} → ${p.to_zone}</strong>${parcelPill(p.status)}</div>
        <p>${formatDate(p.date)}${p.pickup_time ? ` · collected around ${p.pickup_time}` : ''} · ${p.size} · ${rand(p.price)}</p>
        <p class="muted">To ${p.recipient_name}, ${p.dropoff_address}</p>
        <div class="row"><a class="btn btn-sm btn-ghost" href="/p/${p.token}">Track</a>
          ${['unmatched', 'booked'].includes(p.status) ? html`<form method="post" action="/parcels/${p.id}/cancel">${csrf(req)}<button class="link danger" data-confirm="Cancel this parcel?">Cancel</button></form>` : ''}</div>
      </article>`) : empty('No parcels yet.')}` })));
  };

  app.get('/parcels', only, async (req, res) => page(req, res));

  app.post('/parcels', only, async (req, res) => {
    const b = req.body;
    const today = nowLocal().date;
    const { booking_horizon_days } = await getSettings(db);
    const form = Object.fromEntries(['from_zone', 'to_zone', 'pickup_address', 'dropoff_address', 'recipient_name', 'recipient_phone', 'date', 'description', 'size']
      .map(k => [k, String(b[k] ?? '').trim().slice(0, 200)]));
    if (!ZONES.includes(form.from_zone) || !ZONES.includes(form.to_zone)) return page(req, res, form, 'Choose the areas the parcel travels between.');
    if (form.from_zone === form.to_zone) return page(req, res, form, 'Go Parcels carries parcels between areas. Choose two different areas.');
    if (!SIZES[form.size]) return page(req, res, form, 'Choose a size.');
    if (!DATE.test(form.date) || form.date < today || form.date > addDays(today, booking_horizon_days - 1)) {
      return page(req, res, form, `Choose a date in the next ${booking_horizon_days} days.`);
    }
    for (const k of ['pickup_address', 'dropoff_address', 'recipient_name', 'recipient_phone']) if (!form[k]) return page(req, res, form, 'Please fill in all the required fields.');
    const out = await bookParcel(db, req.user, form);
    if (out.error) return page(req, res, form, out.error);
    await sendRecipientCode(out.parcel, req.app.locals.siteUrl);
    const msg = out.matched
      ? `Parcel booked on a ${formatDate(form.date)} run. ${form.recipient_name} will get a code to give the driver.`
      : 'Parcel received. We are finding a run on that route and will confirm soon; if none is found, you get a full refund.';
    res.redirect(`/parcels?ok=${encodeURIComponent(msg)}`);
  });

  app.post('/parcels/:id/cancel', only, async (req, res) => {
    const ok = await cancelParcel(db, Number(req.params.id), req.user.id);
    res.redirect(ok ? '/parcels?ok=Parcel cancelled and refunded.' : '/parcels?err=This parcel can no longer be cancelled.');
  });

  // Public tracking link for sender and recipient. It never shows the delivery code.
  app.get('/p/:token', async (req, res) => {
    const p = await db.prepare(`SELECT pa.*, t.pickup_time, du.name AS driver_name FROM parcels pa
      LEFT JOIN trips t ON t.id = pa.trip_id LEFT JOIN users du ON du.id = t.driver_id WHERE pa.token = ?`).get(req.params.token);
    if (!p) return res.status(404).send('This parcel link is not valid.');
    const steps = ['booked', 'collected', 'delivered'];
    const at = steps.indexOf(p.status);
    res.send(String(layout(req, { title: 'Parcel', body: html`<section class="narrow">
      <h1>Parcel for ${p.recipient_name.split(' ')[0]}</h1>
      <div class="card">
        <p class="trip-route"><span>${p.from_zone}</span><span class="arrow">→</span><span>${p.to_zone}</span></p>
        <p>${formatDate(p.date)}${p.pickup_time ? ` · on the ${p.pickup_time} run` : ''}</p>
        <p>${parcelPill(p.status)}</p>
        ${p.status !== 'cancelled' ? html`<ol class="track-steps">${steps.map((s, i) => html`<li class="${i <= at ? 'done' : ''}">${PARCEL_STATUS[s]}</li>`)}</ol>` : ''}
        ${p.driver_name && ['booked', 'collected'].includes(p.status) ? html`<p>Driver: ${p.driver_name.split(' ')[0]}</p>` : ''}
        <p class="muted">Recipients: give the driver the 4-digit code we sent you by SMS.</p>
      </div></section>` })));
  });
}
