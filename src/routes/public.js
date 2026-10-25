import { html } from '../views/html.js';
import { layout, csrf, field, statusPill } from '../views/layout.js';
import { hashPassword, verifyPassword, createSession, destroySession, homeFor, requireRole } from '../auth.js';
import { ZONES, CHANNELS } from '../config.js';
import { getSettings, tx } from '../db.js';
import { tripFare, planPrice, rand } from '../pricing.js';
import { payfastEnabled, payfastCheckout, handlePayfastNotify, markPaid } from '../payments.js';
import { formatDate } from '../time.js';

export const zoneSelect = (name, selected) => html`<select name="${name}" required>
  <option value="">Choose your area</option>
  ${ZONES.map(z => html`<option ${z === selected ? 'selected' : ''}>${z}</option>`)}</select>`;

export const channelBoxes = (chosen = 'whatsapp,email') => html`<fieldset class="field"><legend>Send me updates by</legend>
  <div class="checks">${CHANNELS.map(([v, l]) => html`<label class="check"><input type="checkbox" name="channels" value="${v}" ${chosen.split(',').includes(v) ? 'checked' : ''}> ${l}</label>`)}</div></fieldset>`;

export const shareBox = checked => html`<label class="check share-check"><input type="checkbox" name="share_rides" value="1" ${checked ? 'checked' : ''}>
  <span><strong>Share my rides and pay less.</strong> Neighbours who work in the same area and leave at about the same time may ride with me.</span></label>`;

export const list = v => (Array.isArray(v) ? v : v ? [v] : []);

function landing(req, db) {
  const s = getSettings(db);
  const km = Math.min(80, Math.max(1, Number(req.query.km) || 15));
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY trips_per_month DESC').all();
  return layout(req, { body: html`
  <section class="hero">
    <p class="eyebrow">Scheduled commuter transport</p>
    <h1>Your everyday commute, sorted.</h1>
    <p class="lead">Plan your trips to work and back once. Go Rides books them every week with a driver you know, and you pay one monthly price.</p>
    <div class="cta-row"><a class="btn" href="/register?as=passenger">Plan my commute</a><a class="btn btn-ghost" href="/register?as=driver">Drive with us</a></div>
    <p class="tagline">Your driver. Your schedule. Your ride.</p>
  </section>
  <section class="steps">
    <h2>How it works</h2>
    <ol class="grid-3">
      <li class="card"><strong>1. Tell us your route</strong><p>Home and work addresses, the days you travel and your pickup times.</p></li>
      <li class="card"><strong>2. Choose your driver</strong><p>Pick a verified driver to collect you every day. We line up approved backups in case they cannot make it.</p></li>
      <li class="card"><strong>3. Subscribe or prepay</strong><p>A monthly plan or a ride pack. No surge pricing and no searching for a ride every morning.</p></li>
    </ol>
  </section>
  <section>
    <h2>What will it cost?</h2>
    <form class="estimator" method="get" action="/#prices">
      <label>One-way distance <input type="number" name="km" min="1" max="80" value="${km}" inputmode="numeric"> km</label>
      <button class="btn btn-sm">Update</button>
    </form>
    <div id="prices" class="grid-3">
      ${plans.map(p => html`<div class="card plan"><h3>${p.name}</h3><p class="price">${rand(planPrice(p, km, s))}<small>/month</small></p>
        <p>${p.trips_per_month} trips. ${p.description}</p><p class="muted">${p.discount_pct}% off pay-as-you-go</p>
        <p class="share-price">Share your ride: <strong>${rand(planPrice(p, km, s, true))}</strong>/month</p></div>`)}
    </div>
    <p class="muted">Pay-as-you-go: ${rand(tripFare(km, s))} per trip, or ${rand(tripFare(km, s, true))} shared, from a prepaid ride balance.</p>
  </section>
  <section class="card share-promo">
    <h2>Share your ride, save ${s.shared_discount_pct}%</h2>
    <p>Neighbours who work in the same area and leave at about the same time can ride together. You keep your own pickup time and door-to-door service, and pay ${s.shared_discount_pct}% less, even on days when nobody joins you.</p>
  </section>
  <section class="grid-2">
    <div class="card"><h3>Safety built in</h3><p>Every driver is ID, licence and PrDP checked before their first trip. Share your live trip with family, and reach our team with one tap if something is wrong.</p></div>
    <div class="card"><h3>For employers</h3><p>Arrange dependable transport for your staff and get one monthly report and invoice. <a href="/register?as=business">Open a business account</a>.</p></div>
  </section>` });
}

const REGISTER_FIELDS = {
  passenger: ['home_address', 'work_address', 'zone', 'work_zone', 'distance_km'],
  driver: ['zone', 'vehicle', 'vehicle_reg', 'id_number', 'licence_no'],
  business: ['company']
};

function registerPage(req, as, values = {}, error = '') {
  const v = k => values[k] ?? '';
  const title = { passenger: 'Plan your commute', driver: 'Drive with Go Rides', business: 'Business account' }[as];
  return layout(req, { title, body: html`
  <section class="narrow">
    <h1>${title}</h1>
    <p class="switch">${['passenger', 'driver', 'business'].filter(r => r !== as).map(r => html`<a href="/register?as=${r}">Sign up as ${r === 'business' ? 'an employer' : `a ${r}`}</a> `)}</p>
    ${error ? html`<p class="flash err">${error}</p>` : ''}
    <form method="post" action="/register" class="form">
      <input type="hidden" name="as" value="${as}">
      ${as === 'business' ? field('Company name', html`<input name="company" required value="${v('company')}">`) : ''}
      ${field(as === 'business' ? 'Your name' : 'Full name', html`<input name="name" required autocomplete="name" value="${v('name')}">`)}
      ${field('Email', html`<input type="email" name="email" required autocomplete="email" value="${v('email')}">`)}
      ${field('Mobile number', html`<input type="tel" name="phone" required autocomplete="tel" placeholder="082 123 4567" value="${v('phone')}">`)}
      ${field('Password', html`<input type="password" name="password" required minlength="8" autocomplete="new-password">`, 'At least 8 characters')}
      ${as === 'passenger' ? html`
        ${field('Home address (pickup)', html`<input name="home_address" required value="${v('home_address')}">`)}
        ${field('Work address', html`<input name="work_address" required value="${v('work_address')}">`)}
        ${field('Home area', zoneSelect('zone', v('zone')))}
        ${field('Work area', zoneSelect('work_zone', v('work_zone')))}
        ${field('One-way distance (km)', html`<input type="number" name="distance_km" min="1" max="80" step="0.1" required value="${v('distance_km')}">`, 'An estimate is fine. We confirm it before your first trip.')}
        ${field('Emergency contact name', html`<input name="emergency_name" value="${v('emergency_name')}">`)}
        ${field('Emergency contact number', html`<input type="tel" name="emergency_phone" value="${v('emergency_phone')}">`)}
        ${shareBox(values.share_rides === undefined ? true : Boolean(values.share_rides))}
      ` : ''}
      ${as === 'driver' ? html`
        ${field('Area you drive in', zoneSelect('zone', v('zone')))}
        ${field('Vehicle make and model', html`<input name="vehicle" required placeholder="Toyota Corolla Quest" value="${v('vehicle')}">`)}
        ${field('Registration number', html`<input name="vehicle_reg" required value="${v('vehicle_reg')}">`)}
        ${field('Vehicle colour', html`<input name="vehicle_colour" value="${v('vehicle_colour')}">`)}
        ${field('Passenger seats', html`<input type="number" name="seats" min="1" max="14" value="${v('seats') || 4}">`)}
        ${field('SA ID number', html`<input name="id_number" required inputmode="numeric" value="${v('id_number')}">`)}
        ${field('Driver licence number', html`<input name="licence_no" required value="${v('licence_no')}">`)}
        ${field('PrDP number', html`<input name="prdp_no" value="${v('prdp_no')}">`, 'Professional Driving Permit. Required before you can take passengers.')}
      ` : ''}
      ${as !== 'business' ? channelBoxes(v('channels') || undefined) : ''}
      <label class="check"><input type="checkbox" name="consent" required> I agree that Go Rides may process my personal information to provide this service, as set out under POPIA.</label>
      <button class="btn">Create account</button>
    </form>
    <p>Already registered? <a href="/login">Log in</a></p>
  </section>` });
}

export default function publicRoutes(app, db) {
  app.get('/', (req, res) => res.send(String(landing(req, db))));
  app.get('/home', requireRole('passenger', 'driver', 'admin', 'business'), (req, res) => res.redirect(homeFor(req.user)));

  app.get('/register', (req, res) => {
    const as = ['passenger', 'driver', 'business'].includes(req.query.as) ? req.query.as : 'passenger';
    res.send(String(registerPage(req, as)));
  });

  app.post('/register', (req, res) => {
    const b = req.body;
    const as = ['passenger', 'driver', 'business'].includes(b.as) ? b.as : 'passenger';
    const fail = msg => res.status(400).send(String(registerPage(req, as, { ...b, channels: list(b.channels).join(','), share_rides: b.share_rides ? 1 : 0 }, msg)));
    const email = String(b.email ?? '').trim().toLowerCase();
    for (const k of ['name', 'email', 'phone', 'password', ...REGISTER_FIELDS[as]]) {
      if (!String(b[k] ?? '').trim()) return fail('Please fill in all the required fields.');
    }
    if (String(b.password).length < 8) return fail('Your password needs at least 8 characters.');
    if ((as === 'passenger' || as === 'driver') && !ZONES.includes(b.zone)) return fail('Please choose your area.');
    if (as === 'passenger' && !ZONES.includes(b.work_zone)) return fail('Please choose your work area.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail('There is already an account with that email. Log in instead.');
    const channels = list(b.channels).filter(c => CHANNELS.some(([v]) => v === c)).join(',') || 'email';

    const userId = tx(db, () => {
      let businessId = null;
      if (as === 'business') {
        businessId = db.prepare('INSERT INTO businesses (name, billing_email) VALUES (?, ?)').run(b.company.trim(), email).lastInsertRowid;
      }
      const id = Number(db.prepare('INSERT INTO users (role, name, email, phone, password_hash, channels, business_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(as, b.name.trim(), email, b.phone.trim(), hashPassword(b.password), channels, businessId).lastInsertRowid);
      if (as === 'passenger') {
        db.prepare(`INSERT INTO passengers (user_id, home_address, work_address, zone, work_zone, distance_km, share_rides, emergency_name, emergency_phone)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, b.home_address.trim(), b.work_address.trim(), b.zone, b.work_zone,
          Math.min(80, Math.max(1, Number(b.distance_km) || 10)), b.share_rides ? 1 : 0, b.emergency_name || null, b.emergency_phone || null);
      } else if (as === 'driver') {
        db.prepare(`INSERT INTO drivers (user_id, zone, vehicle, vehicle_reg, vehicle_colour, seats, id_number, licence_no, prdp_no)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, b.zone, b.vehicle.trim(), b.vehicle_reg.trim().toUpperCase(), b.vehicle_colour || null,
          Math.max(1, Number(b.seats) || 4), b.id_number.trim(), b.licence_no.trim(), b.prdp_no || null);
        // Sensible default: weekdays 05:00 to 20:00. Drivers adjust it on their availability page.
        const avail = db.prepare("INSERT INTO driver_availability (driver_id, weekday, start_time, end_time) VALUES (?, ?, '05:00', '20:00')");
        for (let d = 1; d <= 5; d++) avail.run(id, d);
      }
      return id;
    });
    createSession(db, res, userId);
    const next = { passenger: '/passenger/schedule?ok=Welcome to Go Rides! Set up your weekly trips.', driver: '/driver?ok=Thanks for registering. We will verify your documents and let you know.', business: '/business?ok=Your business account is ready. Add your employees.' }[as];
    res.redirect(next);
  });

  app.get('/login', (req, res) => {
    res.send(String(layout(req, { title: 'Log in', body: html`<section class="narrow">
      <h1>Welcome back</h1>
      ${req.query.failed ? html`<p class="flash err">That email and password do not match.</p>` : ''}
      <form method="post" action="/login" class="form">
        <input type="hidden" name="next" value="${req.query.next ?? ''}">
        ${field('Email', html`<input type="email" name="email" required autocomplete="email">`)}
        ${field('Password', html`<input type="password" name="password" required autocomplete="current-password">`)}
        <button class="btn">Log in</button>
      </form>
      <p>New to Go Rides? <a href="/register">Create an account</a></p></section>` })));
  });

  app.post('/login', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.email ?? '').trim().toLowerCase());
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
      return res.redirect(`/login?failed=1${req.body.next ? `&next=${encodeURIComponent(req.body.next)}` : ''}`);
    }
    createSession(db, res, user.id);
    const next = String(req.body.next ?? '');
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : homeFor(user));
  });

  app.post('/logout', (req, res) => { destroySession(db, req, res); res.redirect('/'); });

  app.get('/notifications', requireRole('passenger', 'driver', 'admin', 'business'), (req, res) => {
    const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    res.send(String(layout(req, { title: 'Notifications', body: html`<h1>Notifications</h1>
      ${items.length ? html`<ul class="list">${items.map(n => html`<li class="card ${n.read_at ? '' : 'unread'}">
        <strong>${n.title}</strong><p>${n.body}</p><small class="muted">${n.created_at} UTC${n.deliveries ? ` · ${n.deliveries}` : ''}</small></li>`)}</ul>`
        : html`<p class="empty">Nothing yet.</p>`}` })));
  });

  // Public, unguessable link a passenger can send to family to follow their ride.
  app.get('/t/:token', (req, res) => {
    const t = sharedTrip(db, req.params.token);
    if (!t) return res.status(404).send('This trip link is not valid.');
    res.send(String(layout(req, { title: 'Live trip', body: html`<section class="narrow">
      <h1>${t.passenger_first} is travelling with Go Rides</h1>
      <div class="card" data-track="/api/track/${req.params.token}">
        <p>${formatDate(t.date)} at ${t.pickup_time}: ${t.origin} → ${t.destination}</p>
        <p data-field="status">${statusPill(t.status)}</p>
        <p><strong>Driver:</strong> ${t.driver_name ?? 'being assigned'}${t.vehicle ? html`, ${t.vehicle_colour ?? ''} ${t.vehicle} <strong>${t.vehicle_reg}</strong>` : ''}</p>
        <div class="map" data-field="map"></div>
        <p class="muted" data-field="updated"></p>
      </div>
      <p class="muted">Worried? Call the Go Rides safety line or SAPS on 10111.</p></section>` })));
  });

  app.get('/api/track/:token', (req, res) => {
    const t = sharedTrip(db, req.params.token);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(trackPayload(t));
  });

  // Payments
  app.get('/payments/:id/checkout', requireRole('passenger'), (req, res) => {
    const p = db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").get(Number(req.params.id), req.user.id);
    if (!p) return res.status(404).send('Payment not found.');
    if (p.status === 'paid') return res.redirect('/passenger/billing?ok=Already paid.');
    if (payfastEnabled()) {
      const { action, fields } = payfastCheckout(p, req.user, req.app.locals.siteUrl);
      return res.send(String(layout(req, { title: 'Pay', body: html`<section class="narrow"><h1>Pay ${rand(p.amount)}</h1>
        <form method="post" action="${action}" class="form" data-autosubmit>
          ${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
          <button class="btn">Continue to PayFast</button></form></section>` })));
    }
    res.send(String(layout(req, { title: 'Pay', body: html`<section class="narrow">
      <h1>Pay ${rand(p.amount)}</h1><p>${p.item}</p>
      <div class="card notice"><strong>Test checkout.</strong> No payment gateway is connected yet, so this payment is simulated. Add PayFast credentials to take real payments.</div>
      <form method="post" action="/payments/${p.id}/simulate" class="form">${csrf(req)}<button class="btn">Pay ${rand(p.amount)}</button></form>
      <p><a href="/passenger/billing">Cancel</a></p></section>` })));
  });

  app.post('/payments/:id/simulate', requireRole('passenger'), (req, res) => {
    if (payfastEnabled()) return res.status(400).send('Simulated payments are switched off.');
    const p = db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").get(Number(req.params.id), req.user.id);
    if (!p) return res.status(404).send('Payment not found.');
    markPaid(db, p.id, `SIM-${p.id}`);
    req.app.locals.runBooking();
    res.redirect('/passenger/billing?ok=Payment received. Thank you!');
  });

  app.get('/payments/:id/done', requireRole('passenger'), (req, res) => {
    res.redirect('/passenger/billing?ok=Thanks! Your payment is being confirmed and will show here shortly.');
  });

  app.post('/payments/notify', async (req, res) => {
    const result = await handlePayfastNotify(db, req.body);
    if (result === 'ok') req.app.locals.runBooking();
    else console.warn(`[payfast] notification rejected: ${result}`);
    res.sendStatus(200);
  });
}

export function sharedTrip(db, token) {
  return db.prepare(`SELECT t.*, substr(pu.name, 1, instr(pu.name || ' ', ' ') - 1) AS passenger_first,
      du.name AS driver_name, d.vehicle, d.vehicle_reg, d.vehicle_colour, d.lat, d.lng, d.location_at
    FROM trips t JOIN users pu ON pu.id = t.passenger_id
    LEFT JOIN drivers d ON d.user_id = t.driver_id LEFT JOIN users du ON du.id = t.driver_id
    WHERE t.share_token = ?`).get(token);
}

// Driver location is only shared while the trip is under way.
export function trackPayload(t) {
  const live = ['en_route', 'arrived', 'in_progress'].includes(t.status);
  return {
    status: t.status, delay_minutes: t.delay_minutes,
    driver: t.driver_name ?? null,
    location: live && t.lat != null ? { lat: t.lat, lng: t.lng, at: t.location_at } : null
  };
}

