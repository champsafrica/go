import { html } from '../views/html.js';
import { layout, csrf, field, tripCard, stars, empty, statusPill } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { getSettings, tx } from '../db.js';
import { tripFare, planPrice, packPrice, RIDE_PACKS, rand } from '../pricing.js';
import { walletBalance, activeSubscription, driverRating, describeDriver, driverCanTake, tripPool, carMates, setSharing } from '../booking.js';
import { createPayment } from '../payments.js';
import { notify, notifyAdmins, sendDirect } from '../notify.js';
import { nowLocal, addDays, addMonths, WEEKDAYS, formatDate } from '../time.js';
import { COMPLAINT_CATEGORIES, CHANNELS, ZONES } from '../config.js';
import { zoneSelect, channelBoxes, shareBox, list } from './public.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function passengerRoutes(app, db) {
  const only = requireRole('passenger');
  const me = async req => await db.prepare('SELECT * FROM passengers WHERE user_id = ?').get(req.user.id);
  const page = (req, res, title, body) => res.send(String(layout(req, { title, body })));

  const approvedDrivers = async zone => await db.prepare(`SELECT d.*, u.name,
      (SELECT COUNT(*) FROM trips WHERE driver_id = d.user_id AND status = 'completed') AS trips_done
    FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.status = 'approved'
    ORDER BY (d.zone = ?) DESC, u.name`).all(zone);

  const sharing = p => Boolean(p.share_rides && p.work_zone);

  const sharingCard = (req, p, pct) => {
    return html`<div class="card ${sharing(p) ? '' : 'share-promo'}"><h3>Shared rides: ${sharing(p) ? 'on' : 'off'}</h3>
      ${sharing(p)
        ? html`<p>You pay ${pct}% less. We match you with neighbours from ${p.zone} who work in ${p.work_zone} and leave at about the same time. You still keep your own pickup time.</p>`
        : html`<p>Save ${pct}% on every ride by sharing the car with neighbours who work in the same area. You pay the shared price even on days when nobody joins you.</p>`}
      ${!p.work_zone ? html`<p><a href="/passenger/profile">Add your work area</a> to start sharing.</p>` : html`
      <form method="post" action="/passenger/sharing">${csrf(req)}<input type="hidden" name="share_rides" value="${sharing(p) ? '' : '1'}">
        <button class="btn btn-sm ${sharing(p) ? 'btn-ghost' : ''}" ${sharing(p) ? html`data-confirm="Stop sharing? Rides already booked in a shared car may move to another driver."` : ''}>${sharing(p) ? 'Stop sharing' : `Share my rides and save ${pct}%`}</button></form>`}
    </div>`;
  };

  const driverWho = t => t.driver_id
    ? html`<p class="who">${t.driver_name} · ${t.vehicle_colour ?? ''} ${t.vehicle} <strong>${t.vehicle_reg}</strong>${t.assignment === 'backup' ? html` <span class="pill pill-backup">Backup driver</span>` : ''}</p>`
    : html`<p class="who muted">We are finding you a driver.</p>`;

  const tripsQuery = where => db.prepare(`SELECT t.*, u.name AS driver_name, u.phone AS driver_phone, d.vehicle, d.vehicle_reg, d.vehicle_colour
    FROM trips t LEFT JOIN drivers d ON d.user_id = t.driver_id LEFT JOIN users u ON u.id = t.driver_id
    WHERE t.passenger_id = ? AND ${where}`);

  app.get('/passenger', only, async (req, res) => {
    const now = nowLocal();
    const p = await me(req);
    const { shared_discount_pct: pct } = await getSettings(db);
    const next = await tripsQuery(`t.status NOT IN ('completed','cancelled','no_show') AND (t.date > ? OR (t.date = ? AND t.pickup_time >= ?) OR t.status IN ('en_route','arrived','in_progress'))
      ORDER BY t.date, t.pickup_time LIMIT 3`).all(req.user.id, now.date, now.date, now.time);
    const sub = await activeSubscription(db, req.user.id, now.date);
    const hasSchedule = await db.prepare('SELECT 1 FROM schedules WHERE passenger_id = ? AND active = 1').get(req.user.id);
    const balance = await walletBalance(db, req.user.id);
    page(req, res, 'Home', html`
      <h1>Hi ${req.user.name.split(' ')[0]}</h1>
      <p class="muted">${p.home_address} → ${p.work_address} · <a href="/passenger/profile">Your details</a></p>
      ${!hasSchedule || (!sub && balance <= 0 && !p.sponsored) ? html`<div class="card notice"><strong>Finish setting up</strong><ol>
        <li class="${hasSchedule ? 'done' : ''}"><a href="/passenger/schedule">Set your weekly trips</a></li>
        <li class="${sub || balance > 0 || p.sponsored ? 'done' : ''}"><a href="/passenger/billing">Choose a plan or buy a ride pack</a></li>
      </ol></div>` : ''}
      <h2>Next rides</h2>
      ${next.length ? next.map(t => tripCard(t, { who: driverWho(t), actions: html`<a class="btn btn-sm" href="/passenger/trips/${t.id}">${['en_route', 'arrived', 'in_progress'].includes(t.status) ? 'Track ride' : 'Details'}</a>` }))
        : empty('No rides booked yet. Once your schedule and plan are set, rides are booked a week ahead.')}
      <div class="grid-2">
        <div class="card"><h3>Your plan</h3>${p.sponsored ? html`<p>Your rides are paid by your employer.</p>` : sub
          ? html`<p><strong>${sub.plan_name}</strong></p><p>${sub.trips_used} of ${sub.trips_included} trips used. Renews ${formatDate(addDays(sub.period_end, 1))}.</p>`
          : html`<p>No active plan.</p>`}<a href="/passenger/billing">Plans & payments</a></div>
        <div class="card"><h3>Ride balance</h3><p class="price">${rand(balance)}</p><p class="muted">Used for trips beyond your plan.</p><a href="/passenger/billing#packs">Buy a ride pack</a></div>
      </div>
      ${sharingCard(req, p, pct)}`);
  });

  // Schedules
  app.get('/passenger/schedule', only, async (req, res) => {
    const p = await me(req);
    const schedules = await db.prepare(`SELECT s.*, u.name AS driver_name FROM schedules s LEFT JOIN users u ON u.id = s.preferred_driver_id
      WHERE s.passenger_id = ? AND s.active = 1`).all(req.user.id);
    const drivers = await approvedDrivers(p.zone);
    const { booking_horizon_days, shared_discount_pct: pct } = await getSettings(db);
    page(req, res, 'Schedule', html`
      <h1>Your weekly trips</h1>
      <p>Rides are booked automatically ${booking_horizon_days} days ahead.</p>
      ${schedules.map(s => html`<article class="card">
        <p><strong>${s.weekdays.split(',').map(d => WEEKDAYS[d - 1]).join(', ')}</strong></p>
        <p>${s.morning_time ? html`To work at <strong>${s.morning_time}</strong>` : ''}${s.morning_time && s.evening_time ? ' · ' : ''}${s.evening_time ? html`Home at <strong>${s.evening_time}</strong>` : ''}</p>
        <p class="muted">Preferred driver: ${s.driver_name ?? 'any verified driver'}</p>
        <form method="post" action="/passenger/schedule/${s.id}/delete">${csrf(req)}<button class="link danger" data-confirm="Stop this schedule and cancel its upcoming rides?">Stop this schedule</button></form>
      </article>`)}
      ${sharingCard(req, p, pct)}
      <h2>${schedules.length ? 'Add another schedule' : 'Set up your schedule'}</h2>
      <form method="post" action="/passenger/schedule" class="form card">${csrf(req)}
        <fieldset class="field"><legend>Days</legend><div class="checks">${WEEKDAYS.map((d, i) => html`<label class="check"><input type="checkbox" name="weekdays" value="${i + 1}" ${i < 5 ? 'checked' : ''}> ${d}</label>`)}</div></fieldset>
        <div class="grid-2">
          ${field('Pickup from home', html`<input type="time" name="morning_time" value="07:00">`, 'Leave empty if you only need a ride home')}
          ${field('Pickup from work', html`<input type="time" name="evening_time" value="17:00">`, 'Leave empty if you only need a ride to work')}
        </div>
        ${field('Preferred driver', html`<select name="preferred_driver_id"><option value="">Any verified driver near me</option>
          ${drivers.map(d => html`<option value="${d.user_id}">${d.name} · ${d.vehicle} · ${d.zone}</option>`)}</select>`, html`<a href="/passenger/drivers">Compare drivers</a>`)}
        <p class="muted">From ${p.home_address} to ${p.work_address} (${p.distance_km} km). <a href="/passenger/profile">Change</a></p>
        <button class="btn">Save schedule</button>
      </form>`);
  });

  app.post('/passenger/schedule', only, async (req, res) => {
    const days = list(req.body.weekdays).map(Number).filter(d => d >= 1 && d <= 7);
    const morning = TIME.test(req.body.morning_time) ? req.body.morning_time : null;
    const evening = TIME.test(req.body.evening_time) ? req.body.evening_time : null;
    if (!days.length) return res.redirect('/passenger/schedule?err=Choose at least one day.');
    if (!morning && !evening) return res.redirect('/passenger/schedule?err=Add at least one pickup time.');
    if (morning && evening && evening <= morning) return res.redirect('/passenger/schedule?err=Your pickup from work must be after your pickup from home.');
    const driverId = Number(req.body.preferred_driver_id) || null;
    if (driverId && !await db.prepare("SELECT 1 FROM drivers WHERE user_id = ? AND status = 'approved'").get(driverId)) {
      return res.redirect('/passenger/schedule?err=That driver is not available.');
    }
    await db.prepare('INSERT INTO schedules (passenger_id, weekdays, morning_time, evening_time, preferred_driver_id) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, [...new Set(days)].sort().join(','), morning, evening, driverId);
    const result = await req.app.locals.runBooking();
    const msg = result.uncovered ? 'Schedule saved. Choose a plan or buy a ride pack so we can book your rides.' : 'Schedule saved. Your rides are being booked.';
    res.redirect(`/passenger${result.uncovered ? '/billing' : ''}?ok=${encodeURIComponent(msg)}`);
  });

  app.post('/passenger/schedule/:id/delete', only, async (req, res) => {
    const id = Number(req.params.id);
    const now = nowLocal();
    await tx(db, async db => {
      await db.prepare('UPDATE schedules SET active = 0 WHERE id = ? AND passenger_id = ?').run(id, req.user.id);
      await db.prepare(`UPDATE trips SET status = 'cancelled' WHERE schedule_id = ? AND passenger_id = ? AND status IN ('scheduled','unassigned')
        AND (date > ? OR (date = ? AND pickup_time > ?))`).run(id, req.user.id, now.date, now.date, now.time);
    });
    res.redirect('/passenger/schedule?ok=Schedule stopped and upcoming rides cancelled.');
  });

  // Drivers: choose a preferred driver and approve backups.
  app.get('/passenger/drivers', only, async (req, res) => {
    const p = await me(req);
    const drivers = await approvedDrivers(p.zone);
    const backups = new Set((await db.prepare('SELECT driver_id FROM backup_drivers WHERE passenger_id = ?').all(req.user.id)).map(r => r.driver_id));
    const preferred = (await db.prepare('SELECT preferred_driver_id AS id FROM schedules WHERE passenger_id = ? AND active = 1 AND preferred_driver_id IS NOT NULL LIMIT 1').get(req.user.id))?.id;
    for (const d of drivers) d.rating = await driverRating(db, d.user_id);
    page(req, res, 'Drivers', html`
      <h1>Verified drivers</h1>
      <p>Pick a regular driver and the backups you are happy to ride with. If nobody you chose is free, we assign the best-rated verified driver near you.</p>
      ${drivers.length ? html`<div class="grid-2">${drivers.map(d => {
        const r = d.rating;
        return html`<article class="card driver">
          <div class="avatar" aria-hidden="true">${d.name.split(' ').map(w => w[0]).slice(0, 2).join('')}</div>
          <div><h3>${d.name} ${d.user_id === preferred ? html`<span class="pill pill-scheduled">Your driver</span>` : ''}</h3>
          <p>${d.vehicle_colour ?? ''} ${d.vehicle} · ${d.seats} seats</p>
          <p>${stars(r.avg)} <span class="muted">${r.count} ratings · ${d.trips_done} trips · ${d.zone}</span></p>
          <div class="row">
            <form method="post" action="/passenger/drivers/${d.user_id}/preferred">${csrf(req)}<button class="btn btn-sm" ${d.user_id === preferred ? 'disabled' : ''}>Make my driver</button></form>
            <form method="post" action="/passenger/drivers/${d.user_id}/backup">${csrf(req)}<button class="btn btn-sm btn-ghost">${backups.has(d.user_id) ? 'Remove backup' : 'Add as backup'}</button></form>
          </div></div></article>`;
      })}</div>` : empty('No verified drivers yet in your area. We will assign one as soon as they are approved.')}`);
  });

  app.post('/passenger/drivers/:id/preferred', only, async (req, res) => {
    const driverId = Number(req.params.id);
    if (!await db.prepare("SELECT 1 FROM drivers WHERE user_id = ? AND status = 'approved'").get(driverId)) return res.redirect('/passenger/drivers?err=Driver not available.');
    const updated = (await db.prepare('UPDATE schedules SET preferred_driver_id = ? WHERE passenger_id = ? AND active = 1').run(driverId, req.user.id)).changes;
    if (!updated) return res.redirect('/passenger/schedule?err=Set up your schedule first, then choose your driver.');
    // Move upcoming trips to the new driver where they are free.
    const now = nowLocal();
    const trips = await db.prepare(`SELECT id, passenger_id, date, pickup_time, direction, shared FROM trips WHERE passenger_id = ? AND status IN ('scheduled','unassigned')
      AND (driver_id IS NULL OR driver_id != ?) AND (date > ? OR (date = ? AND pickup_time > ?))`).all(req.user.id, driverId, now.date, now.date, now.time);
    let moved = 0;
    for (const t of trips) {
      if (!await driverCanTake(db, driverId, t.date, t.pickup_time, t.id, await tripPool(db, t))) continue;
      await db.prepare("UPDATE trips SET driver_id = ?, assignment = 'preferred', status = 'scheduled', reminder_sent = 0 WHERE id = ?").run(driverId, t.id);
      moved++;
    }
    if (moved) await notify(db, driverId, 'New regular passenger', `${req.user.name} chose you as their regular driver. ${moved} trips added to your schedule.`);
    res.redirect(`/passenger/drivers?ok=${encodeURIComponent(`Driver updated. ${moved} upcoming rides moved to them.`)}`);
  });

  app.post('/passenger/drivers/:id/backup', only, async (req, res) => {
    const driverId = Number(req.params.id);
    const removed = (await db.prepare('DELETE FROM backup_drivers WHERE passenger_id = ? AND driver_id = ?').run(req.user.id, driverId)).changes;
    if (!removed && await db.prepare("SELECT 1 FROM drivers WHERE user_id = ? AND status = 'approved'").get(driverId)) {
      await db.prepare('INSERT INTO backup_drivers (passenger_id, driver_id) VALUES (?, ?)').run(req.user.id, driverId);
    }
    res.redirect('/passenger/drivers?ok=Backup drivers updated.');
  });

  // Trips
  app.get('/passenger/trips', only, async (req, res) => {
    const now = nowLocal();
    const upcoming = await tripsQuery(`t.status NOT IN ('completed','cancelled','no_show') ORDER BY t.date, t.pickup_time LIMIT 30`).all(req.user.id);
    const past = await tripsQuery(`t.status IN ('completed','cancelled','no_show') ORDER BY t.date DESC, t.pickup_time DESC LIMIT 50`).all(req.user.id);
    const rated = new Set((await db.prepare('SELECT trip_id FROM ratings WHERE rater_id = ?').all(req.user.id)).map(r => r.trip_id));
    const detail = t => html`<a class="btn btn-sm btn-ghost" href="/passenger/trips/${t.id}">Details</a>`;
    page(req, res, 'Trips', html`
      <h1>Upcoming rides</h1>
      ${upcoming.length ? upcoming.map(t => tripCard(t, { who: driverWho(t), actions: html`<div class="row">${detail(t)}
        ${['scheduled', 'unassigned'].includes(t.status) && (t.date > now.date || t.pickup_time > now.time) ? html`<form method="post" action="/passenger/trips/${t.id}/cancel">${csrf(req)}<button class="link danger" data-confirm="Cancel this ride?">Cancel ride</button></form>` : ''}</div>` }))
        : empty('No upcoming rides.')}
      <h2>History</h2>
      ${past.length ? past.map(t => tripCard(t, { who: t.driver_id ? driverWho(t) : '', actions: html`<div class="row">${detail(t)}
        ${t.status === 'completed' && !rated.has(t.id) ? html`<a class="btn btn-sm" href="/passenger/trips/${t.id}#rate">Rate driver</a>` : ''}</div>` }))
        : empty('Your completed rides will show here.')}`);
  });

  app.get('/passenger/trips/:id', only, async (req, res) => {
    const t = await tripsQuery('t.id = ?').get(req.user.id, Number(req.params.id));
    if (!t) return res.status(404).send('Trip not found.');
    const mates = t.shared ? await carMates(db, t) : [];
    const rating = await db.prepare('SELECT * FROM ratings WHERE trip_id = ? AND rater_id = ?').get(t.id, req.user.id);
    const live = ['scheduled', 'en_route', 'arrived', 'in_progress'].includes(t.status);
    const shareUrl = `${req.app.locals.siteUrl}/t/${t.share_token}`;
    page(req, res, 'Ride', html`
      <h1>${formatDate(t.date)} at ${t.pickup_time}</h1>
      <div class="card" ${live ? html`data-track="/api/track/${t.share_token}"` : ''}>
        <p class="trip-route"><span>${t.origin}</span><span class="arrow">→</span><span>${t.destination}</span></p>
        <p data-field="status">${statusPill(t.status)}</p>
        ${t.delay_minutes ? html`<p class="pill pill-late">Running ${t.delay_minutes} min late</p>` : ''}
        ${driverWho(t)}
        ${t.shared ? (() => {
          return mates.length
            ? html`<p class="who"><span class="pill pill-shared">Shared</span> With ${mates.map(m => m.name.split(' ')[0]).join(', ')} · ${mates.length + 1} passengers, pickups ${[t, ...mates].map(m => m.pickup_time).sort().join(', ')}</p>`
            : html`<p class="who"><span class="pill pill-shared">Shared</span> <span class="muted">Shared-ride price. Nobody else is booked in this car yet.</span></p>`;
        })() : ''}
        ${t.driver_phone && live ? html`<p><a class="btn btn-sm btn-ghost" href="tel:${t.driver_phone}">Call driver</a></p>` : ''}
        ${live ? html`<div class="map" data-field="map"></div><p class="muted" data-field="updated"></p>` : ''}
        <p class="muted">Fare ${rand(t.fare)}${t.payment_source ? ` · paid by ${t.payment_source}` : ''}</p>
      </div>
      ${live ? html`<div class="card"><h3>Safety</h3>
        <p>Share this link so family can follow your ride:</p>
        <div class="share"><input readonly value="${shareUrl}" aria-label="Trip link"><button class="btn btn-sm" type="button" data-share="${shareUrl}">Share</button></div>
        <form method="post" action="/passenger/trips/${t.id}/sos" data-geo>${csrf(req)}<input type="hidden" name="lat"><input type="hidden" name="lng">
          <button class="btn btn-danger" data-confirm="Send an emergency alert to Go Rides and your emergency contact?">SOS: I need help</button></form>
        <p class="muted">In immediate danger, call SAPS on 10111.</p></div>` : ''}
      ${t.status === 'completed' ? html`<div class="card" id="rate"><h3>Rate your ride</h3>${rating
        ? html`<p>You gave ${'★'.repeat(rating.stars)}${rating.comment ? html`: “${rating.comment}”` : ''}</p>`
        : html`<form method="post" action="/passenger/trips/${t.id}/rate" class="form">${csrf(req)}
          <div class="rating">${[5, 4, 3, 2, 1].map(n => html`<input type="radio" name="stars" value="${n}" id="s${n}" required><label for="s${n}" title="${n} stars">★</label>`)}</div>
          ${field('Comment (optional)', html`<textarea name="comment" rows="2"></textarea>`)}<button class="btn btn-sm">Submit rating</button></form>`}</div>` : ''}
      <div class="card"><h3>Report a problem</h3>
        <form method="post" action="/passenger/trips/${t.id}/complain" class="form">${csrf(req)}
          ${field('What happened?', html`<select name="category">${COMPLAINT_CATEGORIES.map(c => html`<option>${c}</option>`)}</select>`)}
          ${field('Details', html`<textarea name="message" rows="3" required></textarea>`)}
          <button class="btn btn-sm btn-ghost">Send to support</button></form></div>`);
  });

  const ownTrip = async req => await db.prepare('SELECT * FROM trips WHERE id = ? AND passenger_id = ?').get(Number(req.params.id), req.user.id);

  app.post('/passenger/trips/:id/cancel', only, async (req, res) => {
    const t = await ownTrip(req);
    if (!t || !['scheduled', 'unassigned'].includes(t.status)) return res.redirect('/passenger/trips?err=This ride can no longer be cancelled.');
    await db.prepare("UPDATE trips SET status = 'cancelled' WHERE id = ?").run(t.id);
    if (t.driver_id) await notify(db, t.driver_id, 'Ride cancelled', `${req.user.name} cancelled the ${formatDate(t.date)} ${t.pickup_time} pickup.`);
    res.redirect('/passenger/trips?ok=Ride cancelled.');
  });

  app.post('/passenger/trips/:id/rate', only, async (req, res) => {
    const t = await ownTrip(req);
    const n = Number(req.body.stars);
    if (!t || t.status !== 'completed' || !t.driver_id || !(n >= 1 && n <= 5)) return res.redirect('/passenger/trips?err=Could not save rating.');
    await db.prepare('INSERT OR IGNORE INTO ratings (trip_id, rater_id, ratee_id, stars, comment) VALUES (?, ?, ?, ?, ?)')
      .run(t.id, req.user.id, t.driver_id, n, String(req.body.comment ?? '').slice(0, 500) || null);
    res.redirect(`/passenger/trips/${t.id}?ok=Thanks for rating your ride.`);
  });

  app.post('/passenger/trips/:id/complain', only, async (req, res) => {
    const t = await ownTrip(req);
    const message = String(req.body.message ?? '').trim().slice(0, 2000);
    if (!t || !message) return res.redirect('/passenger/trips?err=Please describe the problem.');
    const category = COMPLAINT_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
    await db.prepare('INSERT INTO complaints (user_id, trip_id, category, message) VALUES (?, ?, ?, ?)').run(req.user.id, t.id, category, message);
    await notifyAdmins(db, `Complaint: ${category}`, `${req.user.name} on trip #${t.id}: ${message}`);
    res.redirect(`/passenger/trips/${t.id}?ok=Thanks. Our support team will get back to you.`);
  });

  app.post('/passenger/trips/:id/sos', only, async (req, res) => {
    const t = await ownTrip(req);
    if (!t) return res.status(404).send('Trip not found.');
    const lat = Number(req.body.lat) || null, lng = Number(req.body.lng) || null;
    await db.prepare('INSERT INTO sos_alerts (trip_id, user_id, lat, lng) VALUES (?, ?, ?, ?)').run(t.id, req.user.id, lat, lng);
    const where = lat ? ` Location: https://maps.google.com/?q=${lat},${lng}` : '';
    await notifyAdmins(db, 'SOS ALERT', `${req.user.name} (${req.user.phone}) raised an SOS on trip #${t.id} with ${t.driver_id ? await describeDriver(db, t.driver_id) : 'no driver'}.${where}`);
    const p = await me(req);
    if (p.emergency_phone) {
      sendDirect(p.emergency_phone, `Go Rides SOS: ${req.user.name} has asked for help during a ride. Follow it live: ${req.app.locals.siteUrl}/t/${t.share_token}`);
    }
    res.redirect(`/passenger/trips/${t.id}?ok=${encodeURIComponent('Alert sent. Our team is contacting you now. In immediate danger call 10111.')}`);
  });

  app.post('/passenger/sharing', only, async (req, res) => {
    const p = await me(req);
    if (req.body.share_rides && !p.work_zone) return res.redirect('/passenger/profile?err=Add your work area to start sharing.');
    const r = await setSharing(db, req.user.id, Boolean(req.body.share_rides));
    const { shared_discount_pct: pct } = await getSettings(db);
    const msg = r.shared
      ? `Shared rides are on. Your ${r.trips} upcoming rides are now ${pct}% cheaper, and we will match you with neighbours from your next bookings.`
      : `Shared rides are off. Your upcoming rides are back to the solo price${r.moved ? `, and ${r.moved} moved to a driver who can take you alone` : ''}. Plans you have already paid for keep their price.`;
    const waiting = r.unassigned ? ` ${r.unassigned} rides need a new driver; we will confirm as soon as one is free.` : '';
    res.redirect(`/passenger?${r.unassigned ? 'err' : 'ok'}=${encodeURIComponent(msg + waiting)}`);
  });

  // Plans, ride packs and payments
  app.get('/passenger/billing', only, async (req, res) => {
    const s = await getSettings(db);
    const p = await me(req);
    const today = nowLocal().date;
    const sub = await activeSubscription(db, req.user.id, today);
    const upcomingSub = await db.prepare("SELECT s.*, pl.name AS plan_name FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.passenger_id = ? AND s.status = 'active' AND s.period_start > ? ORDER BY s.period_start LIMIT 1").get(req.user.id, today);
    const plans = await db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY trips_per_month DESC').all();
    const pending = await db.prepare("SELECT * FROM payments WHERE user_id = ? AND status = 'pending' ORDER BY id DESC").all(req.user.id);
    const ledger = await db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id);
    const paid = await db.prepare("SELECT * FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 12").all(req.user.id);
    const shared = sharing(p);
    const fare = tripFare(p.distance_km, s, shared);
    page(req, res, 'Plans & payments', html`
      <h1>Plans & payments</h1>
      ${p.sponsored ? html`<div class="card notice">Your employer pays for your rides. You can still buy a ride pack for extra trips.</div>` : ''}
      ${pending.length ? html`<div class="card notice"><h3>Waiting for payment</h3>${pending.map(x => html`<p>${x.item}: <strong>${rand(x.amount)}</strong> <a class="btn btn-sm" href="/payments/${x.id}/checkout">Pay now</a></p>`)}</div>` : ''}
      ${sub ? html`<div class="card"><h3>Current plan: ${sub.plan_name}</h3>
        <p>${formatDate(sub.period_start)} to ${formatDate(sub.period_end)} · ${sub.trips_used}/${sub.trips_included} trips used · ${rand(sub.price)}/month</p>
        <div class="meter"><span style="width:${Math.min(100, Math.round(sub.trips_used / sub.trips_included * 100))}%"></span></div>
        <form method="post" action="/passenger/subscription/${sub.id}/auto-renew">${csrf(req)}<button class="link">${sub.auto_renew ? 'Turn off auto-renew' : 'Turn on auto-renew'}</button></form></div>` : ''}
      ${upcomingSub ? html`<p class="muted">Next plan (${upcomingSub.plan_name}) starts ${formatDate(upcomingSub.period_start)}.</p>` : ''}
      <h2>Monthly plans</h2>
      <p class="muted">Priced for your ${p.distance_km} km route${shared ? html`, <strong>including your ${s.shared_discount_pct}% shared-ride discount</strong>` : ''}. Pay-as-you-go is ${rand(fare)} per trip.</p>
      ${shared || !plans.length ? '' : html`<p class="muted">Sharing your rides would bring the ${plans[0].name} plan to ${rand(planPrice(plans[0], p.distance_km, s, true))}. <a href="/passenger/schedule">Find out more</a></p>`}
      <div class="grid-3">${plans.map(pl => html`<div class="card plan"><h3>${pl.name}</h3>
        <p class="price">${rand(planPrice(pl, p.distance_km, s, shared))}<small>/month</small></p>
        <p>${pl.trips_per_month} trips · save ${pl.discount_pct}%</p><p class="muted">${pl.description}</p>
        <form method="post" action="/passenger/subscribe">${csrf(req)}<input type="hidden" name="plan_id" value="${pl.id}"><button class="btn btn-sm">${sub ? 'Choose for next month' : 'Subscribe'}</button></form></div>`)}</div>
      <h2 id="packs">Prepaid ride packs</h2>
      <p class="muted">Credit for trips outside a plan. Your balance: <strong>${rand(await walletBalance(db, req.user.id))}</strong></p>
      <div class="grid-3">${RIDE_PACKS.map(pk => html`<div class="card plan"><h3>${pk.rides} rides</h3>
        <p class="price">${rand(packPrice(pk, p.distance_km, s, shared))}</p>${pk.discount_pct ? html`<p>Save ${pk.discount_pct}%</p>` : html`<p>&nbsp;</p>`}
        <form method="post" action="/passenger/topup">${csrf(req)}<input type="hidden" name="rides" value="${pk.rides}"><button class="btn btn-sm btn-ghost">Buy</button></form></div>`)}</div>
      <h2>Balance history</h2>
      ${ledger.length ? html`<table class="table"><tbody>${ledger.map(l => html`<tr><td>${l.created_at.slice(0, 10)}</td><td>${l.description}</td><td class="num ${l.amount < 0 ? 'neg' : ''}">${rand(l.amount)}</td></tr>`)}</tbody></table>` : empty('No balance activity yet.')}
      <h2>Payments</h2>
      ${paid.length ? html`<table class="table"><tbody>${paid.map(x => html`<tr><td>${x.paid_at?.slice(0, 10)}</td><td>${x.item}</td><td class="num">${rand(x.amount)}</td></tr>`)}</tbody></table>` : empty('No payments yet.')}`);
  });

  app.post('/passenger/subscribe', only, async (req, res) => {
    const plan = await db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(Number(req.body.plan_id));
    if (!plan) return res.redirect('/passenger/billing?err=Plan not found.');
    const s = await getSettings(db);
    const p = await me(req);
    const today = nowLocal().date;
    // A new plan starts the day after any current plan ends, so nobody pays twice for the same days.
    const current = (await db.prepare("SELECT MAX(period_end) AS end FROM subscriptions WHERE passenger_id = ? AND status = 'active' AND period_end >= ?").get(req.user.id, today)).end;
    const start = current ? addDays(current, 1) : today;
    const price = planPrice(plan, p.distance_km, s, sharing(p));
    const paymentId = await tx(db, async db => {
      await db.prepare("DELETE FROM payments WHERE user_id = ? AND status = 'pending' AND purpose = 'subscription'").run(req.user.id);
      await db.prepare("DELETE FROM subscriptions WHERE passenger_id = ? AND status = 'pending'").run(req.user.id);
      const subId = (await db.prepare('INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.id, plan.id, price, plan.trips_per_month, start, addDays(addMonths(start, 1), -1))).lastInsertRowid;
      return await createPayment(db, { userId: req.user.id, amount: price, purpose: 'subscription', subscriptionId: subId, item: `${plan.name} plan` });
    });
    res.redirect(`/payments/${paymentId}/checkout`);
  });

  app.post('/passenger/subscription/:id/auto-renew', only, async (req, res) => {
    await db.prepare('UPDATE subscriptions SET auto_renew = 1 - auto_renew WHERE id = ? AND passenger_id = ?').run(Number(req.params.id), req.user.id);
    res.redirect('/passenger/billing?ok=Auto-renew updated.');
  });

  app.post('/passenger/topup', only, async (req, res) => {
    const pack = RIDE_PACKS.find(pk => pk.rides === Number(req.body.rides));
    if (!pack) return res.redirect('/passenger/billing?err=Pack not found.');
    const p = await me(req);
    const amount = packPrice(pack, p.distance_km, await getSettings(db), sharing(p));
    const id = await createPayment(db, { userId: req.user.id, amount, purpose: 'topup', item: `${pack.rides}-ride pack` });
    res.redirect(`/payments/${id}/checkout`);
  });

  // Profile
  app.get('/passenger/profile', only, async (req, res) => {
    const p = await me(req);
    page(req, res, 'Profile', html`<h1>Your details</h1>
      <form method="post" action="/passenger/profile" class="form card">${csrf(req)}
        ${field('Mobile number', html`<input type="tel" name="phone" required value="${req.user.phone}">`)}
        ${field('Home address (pickup)', html`<input name="home_address" required value="${p.home_address}">`)}
        ${field('Work address', html`<input name="work_address" required value="${p.work_address}">`)}
        ${field('Home area', zoneSelect('zone', p.zone))}
        ${field('Work area', zoneSelect('work_zone', p.work_zone))}
        ${field('One-way distance (km)', html`<input type="number" name="distance_km" min="1" max="80" step="0.1" required value="${p.distance_km}">`, 'Changing it updates prices for new bookings and plans.')}
        ${field('Emergency contact name', html`<input name="emergency_name" value="${p.emergency_name ?? ''}">`)}
        ${field('Emergency contact number', html`<input type="tel" name="emergency_phone" value="${p.emergency_phone ?? ''}">`)}
        ${shareBox(sharing(p))}
        ${channelBoxes(req.user.channels)}
        <button class="btn">Save</button></form>`);
  });

  app.post('/passenger/profile', only, async (req, res) => {
    const b = req.body;
    if (!ZONES.includes(b.zone) || !ZONES.includes(b.work_zone) || !b.home_address?.trim() || !b.work_address?.trim()) return res.redirect('/passenger/profile?err=Please complete all fields.');
    const channels = list(b.channels).filter(c => CHANNELS.some(([v]) => v === c)).join(',') || 'email';
    await tx(db, async db => {
      await db.prepare('UPDATE users SET phone = ?, channels = ? WHERE id = ?').run(String(b.phone).trim(), channels, req.user.id);
      await db.prepare('UPDATE passengers SET home_address = ?, work_address = ?, zone = ?, work_zone = ?, distance_km = ?, emergency_name = ?, emergency_phone = ? WHERE user_id = ?')
        .run(b.home_address.trim(), b.work_address.trim(), b.zone, b.work_zone, Math.min(80, Math.max(1, Number(b.distance_km) || 10)), b.emergency_name || null, b.emergency_phone || null, req.user.id);
    });
    // Re-check upcoming rides: a new area or a sharing change can break up a shared car.
    await setSharing(db, req.user.id, Boolean(b.share_rides));
    res.redirect('/passenger/profile?ok=Details saved.');
  });
}

