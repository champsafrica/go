import { html } from '../views/html.js';
import { layout, csrf, field, tripCard, stars, empty } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { getSettings } from '../db.js';
import { settleTrip, reassignDriverTrips, driverRating, carMates, earningsForecast } from '../booking.js';
import { driverParcels, collectParcel, deliverParcel } from '../parcels.js';
import { parcelPill } from './parcels.js';
import { notify } from '../notify.js';
import { rand } from '../pricing.js';
import { nowLocal, addDays, WEEKDAYS, formatDate } from '../time.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// What a driver can do next, in the order a trip normally goes.
const NEXT = {
  scheduled: [['en_route', 'Start: on my way'], ['no_show', 'Passenger no-show']],
  en_route: [['arrived', 'I have arrived']],
  arrived: [['in_progress', 'Passenger picked up'], ['no_show', 'Passenger no-show']],
  in_progress: [['completed', 'Trip complete']]
};

const PASSENGER_MESSAGE = {
  en_route: ['Driver on the way', d => `${d} is on the way to collect you.`],
  arrived: ['Your driver has arrived', d => `${d} is waiting at your pickup point.`],
  completed: ['You have arrived', () => 'Thanks for riding with Go Rides. Rate your driver in the app.'],
  no_show: ['Missed pickup', () => 'Your driver marked this pickup as a no-show. Contact support if this is wrong.']
};

export default function driverRoutes(app, db) {
  const only = requireRole('driver');
  const me = async req => await db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(req.user.id);
  const page = (req, res, title, body) => res.send(String(layout(req, { title, body })));

  const tripsQuery = where => db.prepare(`SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone
    FROM trips t JOIN users u ON u.id = t.passenger_id WHERE t.driver_id = ? AND ${where}`);

  // Loads the other passengers in each trip's shared car, for carInfo.
  const withMates = async trips => {
    for (const t of trips) t.mates = t.shared && !['completed', 'cancelled', 'no_show'].includes(t.status) ? await carMates(db, t) : [];
    return trips;
  };

  // For a shared car, show where this pickup falls in the run and who else is on it.
  const carInfo = t => {
    const mates = t.mates ?? [];
    if (!mates.length) return '';
    const run = [t, ...mates].sort((a, b) => a.pickup_time.localeCompare(b.pickup_time));
    return html`<p class="who"><strong>Shared car: pickup ${run.findIndex(r => r.id === t.id) + 1} of ${run.length}</strong></p>
      <ol class="mates">${run.map(r => html`<li>${r.pickup_time} ${r.id === t.id ? t.passenger_name : r.name} · ${r.id === t.id ? t.origin : r.origin}</li>`)}</ol>`;
  };

  const who = t => html`<p class="who">${t.passenger_name} · <a href="tel:${t.passenger_phone}">${t.passenger_phone}</a> · <a href="https://maps.google.com/?q=${encodeURIComponent(t.origin)}" target="_blank" rel="noopener">Directions</a></p>${carInfo(t)}`;

  const actions = (req, t) => html`<div class="row">
    ${(NEXT[t.status] ?? []).map(([to, label]) => html`<form method="post" action="/driver/trips/${t.id}/status">${csrf(req)}
      <input type="hidden" name="status" value="${to}"><button class="btn btn-sm ${to === 'no_show' ? 'btn-ghost' : ''}" ${to === 'no_show' ? html`data-confirm="Mark this passenger as a no-show?"` : ''}>${label}</button></form>`)}
    ${['scheduled', 'en_route'].includes(t.status) ? html`<form method="post" action="/driver/trips/${t.id}/delay" class="inline">${csrf(req)}
      <select name="minutes" aria-label="Delay">${[5, 10, 15, 20, 30].map(m => html`<option value="${m}">${m} min</option>`)}</select><button class="btn btn-sm btn-ghost">Report delay</button></form>` : ''}
  </div>`;

  const parcelCard = (req, p) => html`<article class="card parcel-card">
    <div class="row-between"><strong>Parcel · ${p.size}</strong>${parcelPill(p.status)}</div>
    <p>${formatDate(p.date)}, on your ${p.pickup_time} run · you earn ${rand(p.driver_payout)}</p>
    <p><span class="muted">Collect:</span> ${p.pickup_address} (${p.from_zone})<br><span class="muted">Deliver:</span> ${p.dropoff_address} (${p.to_zone}) to ${p.recipient_name}, <a href="tel:${p.recipient_phone}">${p.recipient_phone}</a></p>
    ${p.description ? html`<p class="muted">${p.description}</p>` : ''}
    ${p.status === 'booked' ? html`<form method="post" action="/driver/parcels/${p.id}/collected" class="row">${csrf(req)}<button class="btn btn-sm">Collected</button></form>` : ''}
    ${p.status === 'collected' ? html`<form method="post" action="/driver/parcels/${p.id}/delivered" class="row">${csrf(req)}
      <input name="code" inputmode="numeric" maxlength="4" placeholder="Recipient's code" aria-label="Recipient's 4-digit code" class="short" required><button class="btn btn-sm">Delivered</button></form>` : ''}
  </article>`;

  app.get('/driver', only, async (req, res) => {
    const d = await me(req);
    const now = nowLocal();
    const today = await withMates(await tripsQuery("t.date = ? AND t.status NOT IN ('cancelled') ORDER BY t.pickup_time").all(req.user.id, now.date));
    const r = await driverRating(db, req.user.id);
    const live = today.some(t => ['en_route', 'arrived', 'in_progress'].includes(t.status));
    const parcels = await driverParcels(db, req.user.id, now.date, now.date);
    const forecast = await earningsForecast(db, req.user.id, now);
    page(req, res, 'Today', html`
      ${d.status === 'pending' ? html`<div class="card notice"><strong>Verification in progress.</strong> We are checking your ID, licence and PrDP. You will be notified when you can start taking trips.</div>` : ''}
      ${d.status === 'suspended' ? html`<div class="card notice err"><strong>Your account is suspended.</strong> ${d.verification_notes ?? 'Contact Go Rides support.'}</div>` : ''}
      <h1>Today, ${formatDate(now.date)}</h1>
      <p>${stars(r.avg)} <span class="muted">${r.count} ratings · ${d.vehicle} ${d.vehicle_reg}</span></p>
      <div class="card location" data-location="${live ? 'on' : 'off'}" data-endpoint="/driver/location" data-csrf="${req.csrf}">
        <strong>Live location</strong> <span data-field="loc-status">${live ? 'Sharing with your passenger while a trip is under way.' : 'Shared automatically once you start a trip.'}</span>
      </div>
      <a class="card forecast" href="/driver/earnings"><span>Booked for the next 7 days</span><strong>${rand(forecast.amount)}</strong>
        <small>${forecast.trips} trips${forecast.parcels ? ` and ${forecast.parcels} parcels` : ''}, already on your schedule</small></a>
      ${today.length ? today.map(t => tripCard(t, { who: who(t), actions: actions(req, t) })) : empty('No trips today.')}
      ${parcels.length ? html`<h2>Parcels today</h2>${parcels.map(p => parcelCard(req, p))}` : ''}`);
  });

  app.post('/driver/parcels/:id/collected', only, async (req, res) => {
    const ok = await collectParcel(db, Number(req.params.id), req.user.id);
    res.redirect(ok ? '/driver?ok=Parcel collected.' : '/driver?err=That parcel cannot be collected now.');
  });

  app.post('/driver/parcels/:id/delivered', only, async (req, res) => {
    const out = await deliverParcel(db, Number(req.params.id), req.user.id, req.body.code);
    res.redirect(out.ok ? '/driver?ok=Parcel delivered. Thank you!' : `/driver?err=${encodeURIComponent(out.error)}`);
  });

  app.get('/driver/trips', only, async (req, res) => {
    const now = nowLocal();
    const upcoming = await withMates(await tripsQuery("t.date > ? AND t.date <= ? AND t.status = 'scheduled' ORDER BY t.date, t.pickup_time").all(req.user.id, now.date, addDays(now.date, 14)));
    const past = await tripsQuery("t.date < ? ORDER BY t.date DESC, t.pickup_time DESC LIMIT 40").all(req.user.id, now.date);
    const parcels = (await driverParcels(db, req.user.id, now.date, addDays(now.date, 14))).filter(p => p.status !== 'delivered');
    const passengers = await db.prepare(`SELECT u.name, u.phone, p.home_address, p.work_address, COUNT(*) AS n FROM trips t
      JOIN users u ON u.id = t.passenger_id JOIN passengers p ON p.user_id = t.passenger_id
      WHERE t.driver_id = ? AND t.date >= ? AND t.status = 'scheduled' GROUP BY t.passenger_id ORDER BY u.name`).all(req.user.id, now.date);
    page(req, res, 'Trips', html`
      <h1>Your passengers</h1>
      ${passengers.length ? html`<table class="table"><tbody>${passengers.map(p => html`<tr><td><strong>${p.name}</strong><br><a href="tel:${p.phone}">${p.phone}</a></td><td>${p.home_address} → ${p.work_address}</td><td class="num">${p.n} trips</td></tr>`)}</tbody></table>` : empty('No booked passengers yet.')}
      ${parcels.length ? html`<h2>Parcels on your runs</h2>${parcels.map(p => parcelCard(req, p))}` : ''}
      <h2>Next two weeks</h2>
      ${upcoming.length ? upcoming.map(t => tripCard(t, { who: who(t) })) : empty('Nothing booked yet.')}
      <h2>Recent</h2>
      ${past.length ? past.map(t => tripCard(t, { who: who(t) })) : empty('No past trips.')}`);
  });

  app.post('/driver/trips/:id/status', only, async (req, res) => {
    const t = await db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(Number(req.params.id), req.user.id);
    const to = req.body.status;
    if (!t || !(NEXT[t.status] ?? []).some(([s]) => s === to)) return res.redirect('/driver?err=That update is not possible for this trip.');
    if (to === 'completed') await settleTrip(db, t.id);
    else await db.prepare('UPDATE trips SET status = ? WHERE id = ?').run(to, t.id);
    const msg = PASSENGER_MESSAGE[to];
    if (msg) await notify(db, t.passenger_id, msg[0], msg[1](req.user.name));
    res.redirect('/driver');
  });

  app.post('/driver/trips/:id/delay', only, async (req, res) => {
    const minutes = Math.min(120, Math.max(0, Number(req.body.minutes) || 0));
    const t = await db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(Number(req.params.id), req.user.id);
    if (!t) return res.redirect('/driver');
    await db.prepare('UPDATE trips SET delay_minutes = ? WHERE id = ?').run(minutes, t.id);
    await notify(db, t.passenger_id, 'Your driver is running late', `${req.user.name} is running about ${minutes} minutes late for your ${t.pickup_time} pickup. Sorry for the wait.`);
    res.redirect('/driver?ok=Passenger notified.');
  });

  app.post('/driver/location', only, async (req, res) => {
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'bad location' });
    await db.prepare("UPDATE drivers SET lat = ?, lng = ?, location_at = datetime('now') WHERE user_id = ?").run(lat, lng, req.user.id);
    res.json({ ok: true });
  });

  app.get('/driver/availability', only, async (req, res) => {
    const windows = new Map((await db.prepare('SELECT * FROM driver_availability WHERE driver_id = ?').all(req.user.id)).map(w => [w.weekday, w]));
    const off = await db.prepare('SELECT * FROM driver_time_off WHERE driver_id = ? AND date >= ? ORDER BY date').all(req.user.id, nowLocal().date);
    page(req, res, 'Availability', html`
      <h1>When you can drive</h1>
      <form method="post" action="/driver/availability" class="form card">${csrf(req)}
        ${WEEKDAYS.map((d, i) => { const w = windows.get(i + 1); return html`<div class="avail-row">
          <label class="check"><input type="checkbox" name="on_${i + 1}" ${w ? 'checked' : ''}> ${d}</label>
          <input type="time" name="start_${i + 1}" value="${w?.start_time ?? '05:00'}" aria-label="${d} start">
          <span>to</span><input type="time" name="end_${i + 1}" value="${w?.end_time ?? '20:00'}" aria-label="${d} end"></div>`; })}
        <button class="btn">Save availability</button></form>
      <h2>Time off</h2>
      <p>Booking a day off moves your trips to backup drivers and tells your passengers.</p>
      <form method="post" action="/driver/time-off" class="form card">${csrf(req)}
        <div class="grid-2">${field('Date', html`<input type="date" name="date" required min="${nowLocal().date}">`)}${field('Reason (optional)', html`<input name="reason">`)}</div>
        <button class="btn btn-sm">Book time off</button></form>
      ${off.map(o => html`<div class="card row-between"><span>${formatDate(o.date)}${o.reason ? ` · ${o.reason}` : ''}</span>
        <form method="post" action="/driver/time-off/${o.date}/delete">${csrf(req)}<button class="link">Remove</button></form></div>`)}`);
  });

  app.post('/driver/availability', only, async (req, res) => {
    const b = req.body;
    await db.prepare('DELETE FROM driver_availability WHERE driver_id = ?').run(req.user.id);
    const ins = db.prepare('INSERT INTO driver_availability (driver_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
    for (let d = 1; d <= 7; d++) {
      if (b[`on_${d}`] && TIME.test(b[`start_${d}`]) && TIME.test(b[`end_${d}`]) && b[`start_${d}`] < b[`end_${d}`]) await ins.run(req.user.id, d, b[`start_${d}`], b[`end_${d}`]);
    }
    await req.app.locals.runBooking();
    res.redirect('/driver/availability?ok=Availability saved. Trips already booked stay with you unless you book time off.');
  });

  app.post('/driver/time-off', only, async (req, res) => {
    const date = String(req.body.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < nowLocal().date) return res.redirect('/driver/availability?err=Choose a date from today onwards.');
    await db.prepare('INSERT OR REPLACE INTO driver_time_off (driver_id, date, reason) VALUES (?, ?, ?)').run(req.user.id, date, req.body.reason || null);
    const r = await reassignDriverTrips(db, req.user.id, date);
    res.redirect(`/driver/availability?ok=${encodeURIComponent(`Time off booked. ${r.moved} trips moved to backup drivers${r.unassigned ? `, ${r.unassigned} waiting for a driver` : ''}.`)}`);
  });

  app.post('/driver/time-off/:date/delete', only, async (req, res) => {
    await db.prepare('DELETE FROM driver_time_off WHERE driver_id = ? AND date = ?').run(req.user.id, req.params.date);
    res.redirect('/driver/availability?ok=Time off removed.');
  });

  app.get('/driver/earnings', only, async (req, res) => {
    const month = nowLocal().date.slice(0, 7);
    const sum = await db.prepare(`SELECT COUNT(*) AS trips, COALESCE(SUM(driver_payout), 0) AS earned, COALESCE(SUM(fare), 0) AS fares
      FROM trips WHERE driver_id = ? AND status = 'completed' AND substr(date, 1, 7) = ?`).get(req.user.id, month);
    const byMonth = await db.prepare(`SELECT substr(date, 1, 7) AS month, COUNT(*) AS trips, SUM(driver_payout) AS earned FROM trips
      WHERE driver_id = ? AND status = 'completed' GROUP BY month ORDER BY month DESC LIMIT 12`).all(req.user.id);
    const reviews = await db.prepare('SELECT stars, comment, created_at FROM ratings WHERE ratee_id = ? ORDER BY id DESC LIMIT 10').all(req.user.id);
    const r = await driverRating(db, req.user.id);
    const { commission_pct } = await getSettings(db);
    const parcelsEarned = (await db.prepare(`SELECT COALESCE(SUM(pa.driver_payout), 0) AS e FROM parcels pa JOIN trips t ON t.id = pa.trip_id
      WHERE t.driver_id = ? AND pa.status = 'delivered' AND substr(pa.date, 1, 7) = ?`).get(req.user.id, month)).e;
    const forecast = await earningsForecast(db, req.user.id);
    page(req, res, 'Earnings', html`
      <h1>Earnings</h1>
      <div class="card forecast"><span>Booked for the next 7 days</span><strong>${rand(forecast.amount)}</strong>
        <small>${forecast.trips} trips${forecast.parcels ? ` and ${forecast.parcels} parcels` : ''}. Your week is planned before it starts.</small></div>
      <div class="grid-3">
        <div class="card stat"><span>This month</span><strong>${rand(sum.earned + parcelsEarned)}</strong>${parcelsEarned ? html`<small class="muted">incl. ${rand(parcelsEarned)} from parcels</small>` : ''}</div>
        <div class="card stat"><span>Trips completed</span><strong>${sum.trips}</strong></div>
        <div class="card stat"><span>Rating</span><strong>${r.avg ?? '–'}</strong></div>
      </div>
      <p class="muted">You keep ${100 - commission_pct}% of each fare. Plan trips pay the plan's per-trip value. In a shared car you are paid for every passenger, so a full car earns more than a solo trip.</p>
      <h2>By month</h2>
      ${byMonth.length ? html`<table class="table"><thead><tr><th>Month</th><th class="num">Trips</th><th class="num">Earned</th></tr></thead><tbody>
        ${byMonth.map(m => html`<tr><td>${m.month}</td><td class="num">${m.trips}</td><td class="num">${rand(m.earned)}</td></tr>`)}</tbody></table>` : empty('No completed trips yet.')}
      <h2>Recent feedback</h2>
      ${reviews.length ? reviews.map(v => html`<div class="card"><span class="stars">${'★'.repeat(v.stars)}</span> ${v.comment ?? ''}</div>`) : empty('No ratings yet.')}`);
  });
}
