import { html } from '../views/html.js';
import { layout, csrf, field, tripCard, stars, empty } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { settleTrip, reassignDriverTrips, driverRating, carMates } from '../booking.js';
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
  const me = req => db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(req.user.id);
  const page = (req, res, title, body) => res.send(String(layout(req, { title, body })));

  const tripsQuery = where => db.prepare(`SELECT t.*, u.name AS passenger_name, u.phone AS passenger_phone
    FROM trips t JOIN users u ON u.id = t.passenger_id WHERE t.driver_id = ? AND ${where}`);

  // For a shared car, show where this pickup falls in the run and who else is on it.
  const carInfo = t => {
    const mates = t.shared && !['completed', 'cancelled', 'no_show'].includes(t.status) ? carMates(db, t) : [];
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

  app.get('/driver', only, (req, res) => {
    const d = me(req);
    const now = nowLocal();
    const today = tripsQuery("t.date = ? AND t.status NOT IN ('cancelled') ORDER BY t.pickup_time").all(req.user.id, now.date);
    const r = driverRating(db, req.user.id);
    const live = today.some(t => ['en_route', 'arrived', 'in_progress'].includes(t.status));
    page(req, res, 'Today', html`
      ${d.status === 'pending' ? html`<div class="card notice"><strong>Verification in progress.</strong> We are checking your ID, licence and PrDP. You will be notified when you can start taking trips.</div>` : ''}
      ${d.status === 'suspended' ? html`<div class="card notice err"><strong>Your account is suspended.</strong> ${d.verification_notes ?? 'Contact Go Rides support.'}</div>` : ''}
      <h1>Today, ${formatDate(now.date)}</h1>
      <p>${stars(r.avg)} <span class="muted">${r.count} ratings · ${d.vehicle} ${d.vehicle_reg}</span></p>
      <div class="card location" data-location="${live ? 'on' : 'off'}" data-endpoint="/driver/location" data-csrf="${req.csrf}">
        <strong>Live location</strong> <span data-field="loc-status">${live ? 'Sharing with your passenger while a trip is under way.' : 'Shared automatically once you start a trip.'}</span>
      </div>
      ${today.length ? today.map(t => tripCard(t, { who: who(t), actions: actions(req, t) })) : empty('No trips today.')}`);
  });

  app.get('/driver/trips', only, (req, res) => {
    const now = nowLocal();
    const upcoming = tripsQuery("t.date > ? AND t.date <= ? AND t.status = 'scheduled' ORDER BY t.date, t.pickup_time").all(req.user.id, now.date, addDays(now.date, 14));
    const past = tripsQuery("t.date < ? ORDER BY t.date DESC, t.pickup_time DESC LIMIT 40").all(req.user.id, now.date);
    const passengers = db.prepare(`SELECT u.name, u.phone, p.home_address, p.work_address, COUNT(*) AS n FROM trips t
      JOIN users u ON u.id = t.passenger_id JOIN passengers p ON p.user_id = t.passenger_id
      WHERE t.driver_id = ? AND t.date >= ? AND t.status = 'scheduled' GROUP BY t.passenger_id ORDER BY u.name`).all(req.user.id, now.date);
    page(req, res, 'Trips', html`
      <h1>Your passengers</h1>
      ${passengers.length ? html`<table class="table"><tbody>${passengers.map(p => html`<tr><td><strong>${p.name}</strong><br><a href="tel:${p.phone}">${p.phone}</a></td><td>${p.home_address} → ${p.work_address}</td><td class="num">${p.n} trips</td></tr>`)}</tbody></table>` : empty('No booked passengers yet.')}
      <h2>Next two weeks</h2>
      ${upcoming.length ? upcoming.map(t => tripCard(t, { who: who(t) })) : empty('Nothing booked yet.')}
      <h2>Recent</h2>
      ${past.length ? past.map(t => tripCard(t, { who: who(t) })) : empty('No past trips.')}`);
  });

  app.post('/driver/trips/:id/status', only, (req, res) => {
    const t = db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(Number(req.params.id), req.user.id);
    const to = req.body.status;
    if (!t || !(NEXT[t.status] ?? []).some(([s]) => s === to)) return res.redirect('/driver?err=That update is not possible for this trip.');
    if (to === 'completed') settleTrip(db, t.id);
    else db.prepare('UPDATE trips SET status = ? WHERE id = ?').run(to, t.id);
    const msg = PASSENGER_MESSAGE[to];
    if (msg) notify(db, t.passenger_id, msg[0], msg[1](req.user.name));
    res.redirect('/driver');
  });

  app.post('/driver/trips/:id/delay', only, (req, res) => {
    const minutes = Math.min(120, Math.max(0, Number(req.body.minutes) || 0));
    const t = db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(Number(req.params.id), req.user.id);
    if (!t) return res.redirect('/driver');
    db.prepare('UPDATE trips SET delay_minutes = ? WHERE id = ?').run(minutes, t.id);
    notify(db, t.passenger_id, 'Your driver is running late', `${req.user.name} is running about ${minutes} minutes late for your ${t.pickup_time} pickup. Sorry for the wait.`);
    res.redirect('/driver?ok=Passenger notified.');
  });

  app.post('/driver/location', only, (req, res) => {
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'bad location' });
    db.prepare("UPDATE drivers SET lat = ?, lng = ?, location_at = datetime('now') WHERE user_id = ?").run(lat, lng, req.user.id);
    res.json({ ok: true });
  });

  app.get('/driver/availability', only, (req, res) => {
    const windows = new Map(db.prepare('SELECT * FROM driver_availability WHERE driver_id = ?').all(req.user.id).map(w => [w.weekday, w]));
    const off = db.prepare('SELECT * FROM driver_time_off WHERE driver_id = ? AND date >= ? ORDER BY date').all(req.user.id, nowLocal().date);
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

  app.post('/driver/availability', only, (req, res) => {
    const b = req.body;
    db.prepare('DELETE FROM driver_availability WHERE driver_id = ?').run(req.user.id);
    const ins = db.prepare('INSERT INTO driver_availability (driver_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
    for (let d = 1; d <= 7; d++) {
      if (b[`on_${d}`] && TIME.test(b[`start_${d}`]) && TIME.test(b[`end_${d}`]) && b[`start_${d}`] < b[`end_${d}`]) ins.run(req.user.id, d, b[`start_${d}`], b[`end_${d}`]);
    }
    req.app.locals.runBooking();
    res.redirect('/driver/availability?ok=Availability saved. Trips already booked stay with you unless you book time off.');
  });

  app.post('/driver/time-off', only, (req, res) => {
    const date = String(req.body.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < nowLocal().date) return res.redirect('/driver/availability?err=Choose a date from today onwards.');
    db.prepare('INSERT OR REPLACE INTO driver_time_off (driver_id, date, reason) VALUES (?, ?, ?)').run(req.user.id, date, req.body.reason || null);
    const r = reassignDriverTrips(db, req.user.id, date);
    res.redirect(`/driver/availability?ok=${encodeURIComponent(`Time off booked. ${r.moved} trips moved to backup drivers${r.unassigned ? `, ${r.unassigned} waiting for a driver` : ''}.`)}`);
  });

  app.post('/driver/time-off/:date/delete', only, (req, res) => {
    db.prepare('DELETE FROM driver_time_off WHERE driver_id = ? AND date = ?').run(req.user.id, req.params.date);
    res.redirect('/driver/availability?ok=Time off removed.');
  });

  app.get('/driver/earnings', only, (req, res) => {
    const month = nowLocal().date.slice(0, 7);
    const sum = db.prepare(`SELECT COUNT(*) AS trips, COALESCE(SUM(driver_payout), 0) AS earned, COALESCE(SUM(fare), 0) AS fares
      FROM trips WHERE driver_id = ? AND status = 'completed' AND substr(date, 1, 7) = ?`).get(req.user.id, month);
    const byMonth = db.prepare(`SELECT substr(date, 1, 7) AS month, COUNT(*) AS trips, SUM(driver_payout) AS earned FROM trips
      WHERE driver_id = ? AND status = 'completed' GROUP BY month ORDER BY month DESC LIMIT 12`).all(req.user.id);
    const reviews = db.prepare('SELECT stars, comment, created_at FROM ratings WHERE ratee_id = ? ORDER BY id DESC LIMIT 10').all(req.user.id);
    const r = driverRating(db, req.user.id);
    page(req, res, 'Earnings', html`
      <h1>Earnings</h1>
      <div class="grid-3">
        <div class="card stat"><span>This month</span><strong>${rand(sum.earned)}</strong></div>
        <div class="card stat"><span>Trips completed</span><strong>${sum.trips}</strong></div>
        <div class="card stat"><span>Rating</span><strong>${r.avg ?? '–'}</strong></div>
      </div>
      <p class="muted">You keep ${100 - Number(db.prepare("SELECT value FROM settings WHERE key = 'commission_pct'").get().value)}% of each fare. Plan trips pay the plan's per-trip value. In a shared car you are paid for every passenger, so a full car earns more than a solo trip.</p>
      <h2>By month</h2>
      ${byMonth.length ? html`<table class="table"><thead><tr><th>Month</th><th class="num">Trips</th><th class="num">Earned</th></tr></thead><tbody>
        ${byMonth.map(m => html`<tr><td>${m.month}</td><td class="num">${m.trips}</td><td class="num">${rand(m.earned)}</td></tr>`)}</tbody></table>` : empty('No completed trips yet.')}
      <h2>Recent feedback</h2>
      ${reviews.length ? reviews.map(v => html`<div class="card"><span class="stars">${'★'.repeat(v.stars)}</span> ${v.comment ?? ''}</div>`) : empty('No ratings yet.')}`);
  });
}
