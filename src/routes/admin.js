import { html } from '../views/html.js';
import { layout, csrf, field, statusPill, stars, empty, STATUS_LABEL } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { getSettings, DEFAULT_SETTINGS, tx } from '../db.js';
import { walletBalance, activeSubscription, driverRating, driverCanTake, assign, describeDriver, tripPool } from '../booking.js';
import { notify } from '../notify.js';
import { rand, round2 } from '../pricing.js';
import { nowLocal, addDays, formatDate } from '../time.js';

const SETTING_LABELS = {
  base_fare: ['Base fare per trip (R)', 'Fixed part of every fare'],
  per_km: ['Price per km (R)', ''],
  min_fare: ['Minimum fare (R)', ''],
  commission_pct: ['Platform commission (%)', 'Share of each fare Go Rides keeps; drivers get the rest'],
  reminder_minutes: ['Pickup reminder (minutes before)', ''],
  booking_horizon_days: ['Book recurring trips this many days ahead', ''],
  shared_discount_pct: ['Shared-ride discount (%)', 'Off the solo fare for passengers who share'],
  pool_window_minutes: ['Shared pickups up to this many minutes apart', 'Wider fills more cars but means longer waits']
};

export default function adminRoutes(app, db) {
  const only = requireRole('admin');
  const page = (req, res, title, body) => res.send(String(layout(req, { title, body, wide: true })));
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  app.get('/admin', only, async (req, res) => {
    const now = nowLocal();
    const month = now.date.slice(0, 7);
    const today = Object.fromEntries((await db.prepare('SELECT status, COUNT(*) AS n FROM trips WHERE date = ? GROUP BY status').all(now.date)).map(r => [r.status, r.n]));
    const m = await one(`SELECT
        SUM(status = 'completed') AS completed, SUM(status = 'no_show') AS no_show, SUM(status = 'cancelled') AS cancelled,
        SUM(status = 'completed' AND delay_minutes = 0) AS on_time,
        SUM(status = 'completed' AND shared = 1) AS shared,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN driver_payout END), 0) AS payouts
      FROM trips WHERE substr(date, 1, 7) = ?`, month);
    const revenue = (await one("SELECT COALESCE(SUM(amount), 0) AS r FROM payments WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?", month)).r;
    const unassigned = (await one("SELECT COUNT(*) AS n FROM trips WHERE status = 'unassigned' AND date >= ?", now.date)).n;
    const counts = await one(`SELECT
      (SELECT COUNT(*) FROM passengers) AS passengers,
      (SELECT COUNT(*) FROM drivers WHERE status = 'approved') AS drivers,
      (SELECT COUNT(*) FROM drivers WHERE status = 'pending') AS pending,
      (SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND period_end >= ?) AS subs,
      (SELECT COUNT(*) FROM complaints WHERE status = 'open') AS complaints,
      (SELECT COUNT(*) FROM sos_alerts WHERE status = 'open') AS sos,
      (SELECT COUNT(*) FROM businesses) AS businesses`, now.date);
    const days = await db.prepare(`SELECT date, SUM(status = 'completed') AS done, COUNT(*) AS total FROM trips
      WHERE date BETWEEN ? AND ? AND status != 'cancelled' GROUP BY date ORDER BY date`).all(addDays(now.date, -13), addDays(now.date, 6));
    const maxDay = Math.max(1, ...days.map(d => d.total));
    // Morning demand per zone against drivers based there: where to recruit next.
    const demand = await db.prepare(`SELECT p.zone, COUNT(DISTINCT p.user_id) AS passengers,
        COUNT(DISTINCT CASE WHEN p.share_rides = 1 AND p.work_zone IS NOT NULL THEN p.user_id END) AS sharers,
        (SELECT COUNT(*) FROM drivers d WHERE d.zone = p.zone AND d.status = 'approved') AS drivers,
        GROUP_CONCAT(DISTINCT substr(s.morning_time, 1, 2) || ':00') AS hours
      FROM schedules s JOIN passengers p ON p.user_id = s.passenger_id WHERE s.active = 1
      GROUP BY p.zone ORDER BY passengers DESC`).all();
    const topDrivers = await db.prepare(`SELECT u.id, u.name, AVG(r.stars) AS avg, COUNT(r.id) AS n FROM ratings r JOIN users u ON u.id = r.ratee_id
      GROUP BY u.id HAVING n >= 1 ORDER BY avg DESC, n DESC LIMIT 5`).all();
    const settled = (m.completed ?? 0) + (m.no_show ?? 0);
    // Shared trips by the same driver, date, direction and hour approximate one car.
    const cars = await one(`SELECT COUNT(*) AS cars, COALESCE(SUM(n), 0) AS riders FROM (SELECT COUNT(*) AS n FROM trips
      WHERE status = 'completed' AND shared = 1 AND substr(date, 1, 7) = ? GROUP BY driver_id, date, direction, substr(pickup_time, 1, 2))`, month);
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
    page(req, res, 'Overview', html`
      <div class="row-between"><h1>Operations</h1>
        <form method="post" action="/admin/run">${csrf(req)}<button class="btn btn-sm">Run booking now</button></form></div>
      ${counts.sos ? html`<a href="/admin/support" class="card notice err"><strong>${counts.sos} open SOS alert${counts.sos > 1 ? 's' : ''}.</strong> Respond now.</a>` : ''}
      ${unassigned ? html`<a href="/admin/trips?status=unassigned" class="card notice"><strong>${unassigned} upcoming trip${unassigned > 1 ? 's' : ''} without a driver.</strong> Assign them.</a>` : ''}
      ${counts.pending ? html`<a href="/admin/drivers" class="card notice"><strong>${counts.pending} driver${counts.pending > 1 ? 's' : ''} waiting for verification.</strong></a>` : ''}
      <h2>Today</h2>
      <div class="grid-4">${['scheduled', 'en_route', 'in_progress', 'completed'].map(s => html`<div class="card stat"><span>${STATUS_LABEL[s]}</span><strong>${today[s] ?? 0}</strong></div>`)}</div>
      <h2>${new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })}</h2>
      <div class="grid-4">
        <div class="card stat"><span>Payments received</span><strong>${rand(revenue)}</strong></div>
        <div class="card stat"><span>Driver payouts owed</span><strong>${rand(m.payouts)}</strong></div>
        <div class="card stat"><span>Trips completed</span><strong>${m.completed ?? 0}</strong></div>
        <div class="card stat"><span>On time</span><strong>${pct(m.on_time ?? 0, m.completed ?? 0)}</strong></div>
        <div class="card stat"><span>Pickup success</span><strong>${pct(m.completed ?? 0, settled)}</strong></div>
        <div class="card stat"><span>Active plans</span><strong>${counts.subs}</strong></div>
        <div class="card stat"><span>Passengers / drivers</span><strong>${counts.passengers} / ${counts.drivers}</strong></div>
        <div class="card stat"><span>Open complaints</span><strong>${counts.complaints}</strong></div>
        <div class="card stat"><span>Shared trips</span><strong>${pct(m.shared ?? 0, m.completed ?? 0)}</strong></div>
        <div class="card stat"><span>Riders per shared car</span><strong>${cars.cars ? (cars.riders / cars.cars).toFixed(1) : '–'}</strong></div>
      </div>
      <h2>Trips per day</h2>
      ${days.length ? html`<div class="bars" role="img" aria-label="Trips per day for the last two weeks and the coming week">${days.map(d => html`<div class="bar ${d.date > now.date ? 'future' : ''} ${d.date === now.date ? 'today' : ''}" title="${d.date}: ${d.total} trips, ${d.done} completed">
        <span style="height:${Math.round(d.total / maxDay * 100)}%"></span><small>${d.date.slice(8)}</small></div>`)}</div>` : empty('No trips yet.')}
      <div class="grid-2">
        <div><h2>Demand by area</h2>
          ${demand.length ? html`<table class="table"><thead><tr><th>Area</th><th class="num">Passengers</th><th class="num">Sharing</th><th class="num">Drivers</th><th>Morning pickups</th></tr></thead><tbody>
            ${demand.map(d => html`<tr class="${d.drivers === 0 || d.passengers / d.drivers > 3 ? 'warn' : ''}"><td>${d.zone}</td><td class="num">${d.passengers}</td><td class="num">${d.sharers}</td><td class="num">${d.drivers}</td><td>${d.hours ?? ''}</td></tr>`)}</tbody></table>
            <p class="muted">Highlighted areas have no local driver, or more than three passengers per driver. Recruit drivers there next.</p>` : empty('No schedules yet.')}</div>
        <div><h2>Top rated drivers</h2>
          ${topDrivers.length ? html`<table class="table"><tbody>${topDrivers.map(d => html`<tr><td>${d.name}</td><td>${stars(Math.round(d.avg * 10) / 10)}</td><td class="num muted">${d.n}</td></tr>`)}</tbody></table>` : empty('No ratings yet.')}</div>
      </div>`);
  });

  app.post('/admin/run', only, async (req, res) => {
    const r = await req.app.locals.runBooking();
    res.redirect(`/admin?ok=${encodeURIComponent(`Booking run: ${r.trips} trips booked, ${r.fixed} reassigned, ${r.unassigned} without a driver, ${r.reminders} reminders sent.`)}`);
  });

  app.get('/admin/trips', only, async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : null;
    const status = STATUS_LABEL[req.query.status] ? req.query.status : null;
    const now = nowLocal();
    const where = [], args = [];
    if (date) { where.push('t.date = ?'); args.push(date); } else if (!status) { where.push('t.date = ?'); args.push(now.date); }
    if (status) { where.push('t.status = ?'); args.push(status); if (status === 'unassigned') { where.push('t.date >= ?'); args.push(now.date); } }
    const trips = await db.prepare(`SELECT t.*, pu.name AS passenger_name, pu.phone AS passenger_phone, du.name AS driver_name FROM trips t
      JOIN users pu ON pu.id = t.passenger_id LEFT JOIN users du ON du.id = t.driver_id
      WHERE ${where.join(' AND ')} ORDER BY t.date, t.pickup_time LIMIT 300`).all(...args);
    const drivers = await db.prepare("SELECT d.user_id, u.name, d.zone FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.status = 'approved' ORDER BY u.name").all();
    // Which drivers could take each open trip, to label the others as busy.
    const free = new Map();
    for (const t of trips.filter(t => ['scheduled', 'unassigned'].includes(t.status))) {
      const pool = await tripPool(db, t);
      const ids = new Set();
      for (const d of drivers) if (await driverCanTake(db, d.user_id, t.date, t.pickup_time, t.id, pool)) ids.add(d.user_id);
      free.set(t.id, ids);
    }
    page(req, res, 'Trips', html`
      <h1>Trips</h1>
      <form method="get" class="filters">
        <input type="date" name="date" value="${date ?? (status ? '' : now.date)}" aria-label="Date">
        <select name="status" aria-label="Status"><option value="">All statuses</option>${Object.entries(STATUS_LABEL).map(([k, v]) => html`<option value="${k}" ${k === status ? 'selected' : ''}>${v}</option>`)}</select>
        <button class="btn btn-sm">Filter</button></form>
      ${trips.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Passenger</th><th>Route</th><th>Driver</th><th>Status</th><th>Fare</th><th></th></tr></thead><tbody>
        ${trips.map(t => html`<tr>
          <td>${formatDate(t.date)}<br><strong>${t.pickup_time}</strong></td>
          <td>${t.passenger_name}<br><a href="tel:${t.passenger_phone}">${t.passenger_phone}</a></td>
          <td>${t.origin}<br>→ ${t.destination}</td>
          <td>${t.driver_name ?? html`<span class="muted">None</span>`}${t.assignment === 'backup' ? html`<br><small class="muted">backup</small>` : ''}</td>
          <td>${statusPill(t.status)}${t.shared ? html` <span class="pill pill-shared">Shared</span>` : ''}${t.delay_minutes ? html`<br><small>${t.delay_minutes} min late</small>` : ''}</td>
          <td class="num">${rand(t.fare)}</td>
          <td>${['scheduled', 'unassigned'].includes(t.status) ? html`
            <form method="post" action="/admin/trips/${t.id}/assign" class="inline">${csrf(req)}
              <select name="driver_id" aria-label="Driver">${drivers.map(d => html`<option value="${d.user_id}" ${d.user_id === t.driver_id ? 'selected' : ''}>${d.name} (${d.zone})${free.get(t.id).has(d.user_id) ? '' : ' – busy'}</option>`)}</select>
              <button class="btn btn-sm">Assign</button></form>
            <form method="post" action="/admin/trips/${t.id}/cancel" class="inline">${csrf(req)}<button class="link danger" data-confirm="Cancel this trip?">Cancel</button></form>` : ''}</td>
        </tr>`)}</tbody></table></div>` : empty('No trips match.')}`);
  });

  app.post('/admin/trips/:id/assign', only, async (req, res) => {
    const t = await one("SELECT * FROM trips WHERE id = ? AND status IN ('scheduled','unassigned')", Number(req.params.id));
    const driverId = Number(req.body.driver_id);
    if (!t || !await one("SELECT 1 FROM drivers WHERE user_id = ? AND status = 'approved'", driverId)) return res.redirect('/admin/trips?err=Could not assign that driver.');
    const previous = t.driver_id;
    await assign(db, t.id, driverId, 'manual');
    if (previous && previous !== driverId) await notify(db, previous, 'Trip moved', `Your ${formatDate(t.date)} ${t.pickup_time} pickup was moved to another driver.`);
    if (previous !== driverId) await notify(db, t.passenger_id, 'Driver confirmed', `${await describeDriver(db, driverId)} will collect you on ${formatDate(t.date)} at ${t.pickup_time}.`);
    res.redirect(`/admin/trips?date=${t.date}&ok=Driver assigned.`);
  });

  app.post('/admin/trips/:id/cancel', only, async (req, res) => {
    const t = await one('SELECT * FROM trips WHERE id = ?', Number(req.params.id));
    if (!t) return res.redirect('/admin/trips');
    await db.prepare("UPDATE trips SET status = 'cancelled' WHERE id = ?").run(t.id);
    await notify(db, t.passenger_id, 'Ride cancelled', `Your ${formatDate(t.date)} ${t.pickup_time} ride was cancelled by Go Rides. Contact support if you need help.`);
    if (t.driver_id) await notify(db, t.driver_id, 'Ride cancelled', `The ${formatDate(t.date)} ${t.pickup_time} pickup was cancelled.`);
    res.redirect(`/admin/trips?date=${t.date}&ok=Trip cancelled.`);
  });

  app.get('/admin/drivers', only, async (req, res) => {
    const drivers = await db.prepare(`SELECT d.*, u.name, u.email, u.phone, u.created_at,
        (SELECT COUNT(*) FROM trips WHERE driver_id = d.user_id AND status = 'completed') AS trips_done
      FROM drivers d JOIN users u ON u.id = d.user_id ORDER BY d.status = 'pending' DESC, u.name`).all();
    for (const d of drivers) d.rating = (await driverRating(db, d.user_id)).avg;
    page(req, res, 'Drivers', html`
      <h1>Drivers</h1>
      <p class="muted">Before approving, check the ID, driver's licence and PrDP against the originals, and run a criminal record check.</p>
      ${drivers.length ? html`<div class="grid-2">${drivers.map(d => html`<article class="card">
        <div class="row-between"><h3>${d.name}</h3><span class="pill pill-${d.status === 'approved' ? 'completed' : d.status === 'pending' ? 'scheduled' : 'cancelled'}">${d.status}</span></div>
        <p><a href="tel:${d.phone}">${d.phone}</a> · ${d.email}</p>
        <p>${d.vehicle_colour ?? ''} ${d.vehicle} · <strong>${d.vehicle_reg}</strong> · ${d.seats} seats · ${d.zone}</p>
        <p class="muted">ID ${d.id_number} · Licence ${d.licence_no} · PrDP ${d.prdp_no ?? html`<strong>missing</strong>`}</p>
        <p>${stars(d.rating)} <span class="muted">${d.trips_done} trips · joined ${d.created_at.slice(0, 10)}</span></p>
        <form method="post" action="/admin/drivers/${d.user_id}" class="form">${csrf(req)}
          ${field('Notes', html`<input name="notes" value="${d.verification_notes ?? ''}">`)}
          <div class="row">${d.status !== 'approved' ? html`<button class="btn btn-sm" name="status" value="approved">Approve</button>` : ''}
          ${d.status !== 'suspended' ? html`<button class="btn btn-sm btn-ghost" name="status" value="suspended" data-confirm="Suspend this driver? Their upcoming trips will be moved.">Suspend</button>` : ''}</div>
        </form></article>`)}</div>` : empty('No drivers have registered yet.')}`);
  });

  app.post('/admin/drivers/:id', only, async (req, res) => {
    const id = Number(req.params.id);
    const status = ['approved', 'suspended'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.redirect('/admin/drivers');
    await db.prepare('UPDATE drivers SET status = ?, verification_notes = ? WHERE user_id = ?').run(status, req.body.notes || null, id);
    if (status === 'approved') {
      await notify(db, id, 'You are approved', 'Welcome to Go Rides! Set your availability and trips will start coming in.');
    } else {
      // Suspended drivers' upcoming trips go back into the pool for backups.
      const now = nowLocal();
      await db.prepare(`UPDATE trips SET driver_id = NULL, assignment = NULL, status = 'unassigned' WHERE driver_id = ? AND status = 'scheduled'
        AND (date > ? OR (date = ? AND pickup_time > ?))`).run(id, now.date, now.date, now.time);
      await notify(db, id, 'Account suspended', req.body.notes || 'Contact Go Rides support for details.');
    }
    await req.app.locals.runBooking();
    res.redirect('/admin/drivers?ok=Driver updated.');
  });

  app.get('/admin/passengers', only, async (req, res) => {
    const today = nowLocal().date;
    const rows = await db.prepare(`SELECT u.id, u.name, u.email, u.phone, p.zone, p.distance_km, p.sponsored, b.name AS business
      FROM passengers p JOIN users u ON u.id = p.user_id LEFT JOIN businesses b ON b.id = u.business_id ORDER BY u.name`).all();
    const businesses = await db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM users WHERE business_id = b.id AND role = 'passenger') AS staff FROM businesses b ORDER BY b.name`).all();
    for (const p of rows) {
      p.sub = await activeSubscription(db, p.id, today);
      p.balance = await walletBalance(db, p.id);
    }
    page(req, res, 'Passengers', html`
      <h1>Passengers</h1>
      ${rows.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Area</th><th>Plan</th><th class="num">Balance</th><th>Adjust balance</th></tr></thead><tbody>
        ${rows.map(p => { const sub = p.sub; return html`<tr>
          <td><strong>${p.name}</strong><br><small>${p.email} · ${p.phone}</small></td>
          <td>${p.zone}<br><small>${p.distance_km} km</small></td>
          <td>${p.sponsored ? html`Employer: ${p.business}` : sub ? html`${sub.plan_name}<br><small>${sub.trips_used}/${sub.trips_included}, ends ${sub.period_end}</small>` : html`<span class="muted">None</span>`}</td>
          <td class="num">${rand(p.balance)}</td>
          <td><form method="post" action="/admin/passengers/${p.id}/credit" class="inline">${csrf(req)}
            <input type="number" name="amount" step="0.01" placeholder="±R" aria-label="Amount" class="short"><input name="reason" placeholder="Reason" aria-label="Reason" required class="short"><button class="btn btn-sm btn-ghost">Apply</button></form></td>
        </tr>`; })}</tbody></table></div>` : empty('No passengers yet.')}
      <h2>Business accounts</h2>
      ${businesses.length ? html`<table class="table"><tbody>${businesses.map(b => html`<tr><td><strong>${b.name}</strong></td><td>${b.billing_email}</td><td class="num">${b.staff} employees</td></tr>`)}</tbody></table>` : empty('No business accounts yet.')}`);
  });

  app.post('/admin/passengers/:id/credit', only, async (req, res) => {
    const amount = round2(Number(req.body.amount));
    const id = Number(req.params.id);
    if (!amount || !await one('SELECT 1 FROM passengers WHERE user_id = ?', id)) return res.redirect('/admin/passengers?err=Enter an amount.');
    await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)")
      .run(id, amount, amount > 0 ? 'refund' : 'adjustment', `Go Rides: ${String(req.body.reason).slice(0, 200)}`);
    await notify(db, id, amount > 0 ? 'Credit added' : 'Balance adjusted', `${rand(amount)} applied to your ride balance: ${req.body.reason}`);
    res.redirect('/admin/passengers?ok=Balance updated.');
  });

  app.get('/admin/support', only, async (req, res) => {
    const sos = await db.prepare(`SELECT a.*, u.name, u.phone, p.emergency_name, p.emergency_phone, t.driver_id AS trip_driver_id
      FROM sos_alerts a JOIN users u ON u.id = a.user_id LEFT JOIN passengers p ON p.user_id = a.user_id LEFT JOIN trips t ON t.id = a.trip_id
      ORDER BY a.status = 'open' DESC, a.id DESC LIMIT 50`).all();
    for (const a of sos) a.driver = a.trip_driver_id ? await describeDriver(db, a.trip_driver_id) : 'no driver';
    const complaints = await db.prepare(`SELECT c.*, u.name, u.phone, u.role, du.name AS driver_name FROM complaints c JOIN users u ON u.id = c.user_id
      LEFT JOIN trips t ON t.id = c.trip_id LEFT JOIN users du ON du.id = t.driver_id ORDER BY c.status = 'open' DESC, c.id DESC LIMIT 100`).all();
    page(req, res, 'Support', html`
      <h1>Safety alerts</h1>
      ${sos.length ? sos.map(a => html`<article class="card ${a.status === 'open' ? 'notice err' : ''}">
        <div class="row-between"><strong>SOS from ${a.name}</strong><span>${a.created_at} UTC</span></div>
        <p><a href="tel:${a.phone}">${a.phone}</a> · Trip #${a.trip_id}${a.trip_id ? html` · ${a.driver}` : ''}</p>
        ${a.lat ? html`<p><a href="https://maps.google.com/?q=${a.lat},${a.lng}" target="_blank" rel="noopener">Location when raised</a></p>` : ''}
        ${a.emergency_phone ? html`<p>Emergency contact: ${a.emergency_name ?? ''} <a href="tel:${a.emergency_phone}">${a.emergency_phone}</a></p>` : ''}
        ${a.status === 'open' ? html`<form method="post" action="/admin/sos/${a.id}/close">${csrf(req)}<button class="btn btn-sm">Mark handled</button></form>` : html`<p class="muted">Handled</p>`}
      </article>`) : empty('No alerts.')}
      <h2>Complaints</h2>
      ${complaints.length ? complaints.map(c => html`<article class="card">
        <div class="row-between"><strong>${c.category}</strong><span class="pill pill-${c.status === 'open' ? 'scheduled' : 'completed'}">${c.status}</span></div>
        <p>${c.message}</p>
        <p class="muted">${c.name} (${c.role}) · <a href="tel:${c.phone}">${c.phone}</a>${c.trip_id ? ` · trip #${c.trip_id}` : ''}${c.driver_name ? ` · driver ${c.driver_name}` : ''} · ${c.created_at.slice(0, 16)}</p>
        ${c.status === 'open' ? html`<form method="post" action="/admin/complaints/${c.id}/resolve" class="form">${csrf(req)}
          ${field('Resolution (sent to the customer)', html`<textarea name="resolution" rows="2" required></textarea>`)}<button class="btn btn-sm">Resolve</button></form>`
          : html`<p><strong>Resolution:</strong> ${c.resolution}</p>`}
      </article>`) : empty('No complaints.')}`);
  });

  app.post('/admin/sos/:id/close', only, async (req, res) => {
    await db.prepare("UPDATE sos_alerts SET status = 'closed' WHERE id = ?").run(Number(req.params.id));
    res.redirect('/admin/support?ok=Alert closed.');
  });

  app.post('/admin/complaints/:id/resolve', only, async (req, res) => {
    const c = await one('SELECT * FROM complaints WHERE id = ?', Number(req.params.id));
    const resolution = String(req.body.resolution ?? '').trim();
    if (!c || !resolution) return res.redirect('/admin/support');
    await db.prepare("UPDATE complaints SET status = 'resolved', resolution = ? WHERE id = ?").run(resolution, c.id);
    await notify(db, c.user_id, 'Your complaint was resolved', resolution);
    res.redirect('/admin/support?ok=Complaint resolved.');
  });

  app.get('/admin/settings', only, async (req, res) => {
    const s = await getSettings(db);
    const plans = await db.prepare('SELECT * FROM plans ORDER BY trips_per_month DESC').all();
    page(req, res, 'Pricing', html`
      <h1>Pricing and booking</h1>
      <form method="post" action="/admin/settings" class="form card">${csrf(req)}
        <div class="grid-2">${Object.keys(DEFAULT_SETTINGS).map(k => field(SETTING_LABELS[k][0], html`<input type="number" step="0.01" min="0" name="${k}" value="${s[k]}" required>`, SETTING_LABELS[k][1]))}</div>
        <p class="muted">Example: a 15 km trip costs ${rand(Math.max(s.min_fare, Math.round(s.base_fare + s.per_km * 15)))}. Changes apply to new bookings and new plans.</p>
        <button class="btn">Save pricing</button></form>
      <h2>Plans</h2>
      ${plans.map(p => html`<form method="post" action="/admin/plans/${p.id}" class="form card">${csrf(req)}
        <div class="grid-4">${field('Name', html`<input name="name" value="${p.name}" required>`)}
          ${field('Trips per month', html`<input type="number" name="trips_per_month" min="1" value="${p.trips_per_month}" required>`)}
          ${field('Discount %', html`<input type="number" name="discount_pct" min="0" max="60" step="0.5" value="${p.discount_pct}" required>`)}
          <label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> On sale</label></div>
        ${field('Description', html`<input name="description" value="${p.description}" required>`)}
        <button class="btn btn-sm btn-ghost">Save plan</button></form>`)}`);
  });

  app.post('/admin/settings', only, async (req, res) => {
    await tx(db, async db => {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        const v = Number(req.body[k]);
        if (Number.isFinite(v) && v >= 0) await db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(v), k);
      }
    });
    res.redirect('/admin/settings?ok=Pricing saved.');
  });

  app.post('/admin/plans/:id', only, async (req, res) => {
    const b = req.body;
    await db.prepare('UPDATE plans SET name = ?, description = ?, trips_per_month = ?, discount_pct = ?, active = ? WHERE id = ?')
      .run(String(b.name).trim(), String(b.description).trim(), Math.max(1, Number(b.trips_per_month) || 1),
        Math.min(60, Math.max(0, Number(b.discount_pct) || 0)), b.active ? 1 : 0, Number(req.params.id));
    res.redirect('/admin/settings?ok=Plan saved.');
  });
}
