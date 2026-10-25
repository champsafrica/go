import { html, raw } from '../views/html.js';
import { layout, csrf, field, statusPill } from '../views/layout.js';
import { timingSafeEqual } from 'node:crypto';
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

const DAY_OPTIONS = [[5, 'Every weekday'], [3, '3 days a week'], [2, '2 days a week']];
const ill = (name, alt = '') => html`<img src="/illustrations/${name}.svg" alt="${alt}" loading="lazy" width="160" height="120">`;
const pinIcon = raw('<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22s7-7.1 7-12.2A7 7 0 0 0 5 9.8C5 14.9 12 22 12 22Zm0-9.2a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z"/></svg>');

async function landing(req, db) {
  const s = await getSettings(db);
  const q = req.query;
  const km = Math.min(80, Math.max(1, Number(q.km) || 15));
  const days = DAY_OPTIONS.some(([d]) => d === Number(q.days)) ? Number(q.days) : 5;
  const home = ZONES.includes(q.home) ? q.home : '';
  const work = ZONES.includes(q.work) ? q.work : '';
  const plans = await db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY trips_per_month DESC').all();
  // The plan closest to the trips a month this pattern needs (two a day, about 4.3 weeks).
  const needed = days * 2 * 4.3;
  const best = plans.reduce((a, p) => (!a || Math.abs(p.trips_per_month - needed) < Math.abs(a.trips_per_month - needed) ? p : a), null);
  const zoneOptions = selected => ZONES.map(z => html`<option ${z === selected ? 'selected' : ''}>${z}</option>`);
  const pct = s.shared_discount_pct;
  return layout(req, { landing: true, body: html`
  <section class="lp-dark hero">
    <div class="wrap page hero-grid">
      <div>
        <p class="where">${pinIcon} Johannesburg · Pretoria · Cape Town · Durban</p>
        <h1>Your everyday commute, sorted.</h1>
        <p class="lede">Plan your trips to work and back once. Go Rides books them every week with a driver you know, for one monthly price.</p>
        <form class="trip-form" method="get" action="/#prices">
          <div class="pair">
            <div class="tf"><span class="dot round"></span><label class="sr" for="home">Home area</label>
              <select id="home" name="home"><option value="">Where do you live?</option>${zoneOptions(home)}</select></div>
            <div class="tf"><span class="dot square"></span><label class="sr" for="work">Work area</label>
              <select id="work" name="work"><option value="">Where do you work?</option>${zoneOptions(work)}</select></div>
          </div>
          <div class="tf-row">
            <div class="tf"><label class="sr" for="days">How often</label>
              <select id="days" name="days">${DAY_OPTIONS.map(([d, l]) => html`<option value="${d}" ${d === days ? 'selected' : ''}>${l}</option>`)}</select></div>
            <div class="tf"><label class="sr" for="km">One-way distance in km</label>
              <input id="km" type="number" name="km" min="1" max="80" value="${km}" inputmode="numeric" aria-describedby="km-hint"></div>
          </div>
          <small id="km-hint" class="muted">One-way distance in km. An estimate is fine.</small>
          <div class="actions"><button class="btn btn-light">See prices</button><a href="/login">Log in to see your rides</a></div>
        </form>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <img src="/illustrations/hero-map.svg" alt="">
        <div class="float float-week"><strong>This week</strong>10 rides booked
          <div class="days"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span class="off">S</span></div></div>
        <div class="float float-share">Shared ride · save ${pct}%</div>
        <div class="float float-driver"><div class="avatar">TM</div><div><strong>Thabo M.</strong>White Corolla Quest<br>★ 4.9</div>
          <div class="eta">06:30<small>pickup</small></div></div>
      </div>
    </div>
  </section>

  <section class="lp-dark lp" style="padding-top:0">
    <div class="wrap page">
      <h2>Explore what you can do with Go Rides</h2>
      <div class="explore">
        <a class="xcard" href="#ride"><div><h3>Daily commute</h3><p>The same trusted driver, to work and back, every day you travel.</p><span class="details">Details</span></div>${ill('commute')}</a>
        <a class="xcard" href="#share"><div><h3>Shared rides</h3><p>Ride with neighbours going your way and pay ${pct}% less.</p><span class="details">Details</span></div>${ill('shared')}</a>
        <a class="xcard" href="#prices"><div><h3>Ride packs</h3><p>Prepay 10, 20 or 40 rides and use them when you need them.</p><span class="details">Details</span></div>${ill('packs')}</a>
        <a class="xcard" href="#business"><div><h3>For employers</h3><p>Dependable transport for your staff, on one monthly invoice.</p><span class="details">Details</span></div>${ill('business')}</a>
        <a class="xcard" href="#drive"><div><h3>Drive with us</h3><p>Regular passengers and steady, scheduled earnings.</p><span class="details">Details</span></div>${ill('drive')}</a>
        <a class="xcard" href="#safety"><div><h3>Safety</h3><p>Vetted drivers, live trip sharing and help at one tap.</p><span class="details">Details</span></div>${ill('safety')}</a>
      </div>
    </div>
  </section>

  <section class="lp lp-white" id="ride">
    <div class="wrap page">
      <h2>How Go Rides works</h2>
      <div class="steps3">
        <div class="step">${ill('route')}<h3>Tell us your route</h3><p>Your home and work addresses, the days you travel and your pickup times.</p></div>
        <div class="step">${ill('commute')}<h3>Meet your driver</h3><p>Choose a verified driver to collect you every day. Approved backups stand by if they cannot make it.</p></div>
        <div class="step">${ill('calendar')}<h3>Ride all month</h3><p>Every ride is booked a week ahead. Pay one monthly price, with no surge pricing and no searching each morning.</p></div>
      </div>
    </div>
  </section>

  <section class="lp" id="prices">
    <div class="wrap page">
      <h2>${home && work ? `${home} to ${work}` : 'Simple monthly prices'}</h2>
      <p class="lede">Priced for a ${km} km trip each way, ${DAY_OPTIONS.find(([d]) => d === days)[1].toLowerCase()}. Change it in the trip planner above.</p>
      <div class="plans" style="margin-top:28px">
        ${plans.map(p => html`<div class="plan-card ${p === best ? 'best' : ''}">${p === best ? html`<span class="tag">Best match</span>` : ''}
          <h3>${p.name}</h3><p class="muted">${p.trips_per_month} trips a month · ${p.description}</p>
          <p class="price">${rand(planPrice(p, km, s))}<small> /month</small></p>
          <div class="shared-line"><span>Shared ride</span><strong>${rand(planPrice(p, km, s, true))} /month</strong></div>
          <a class="btn ${p === best ? '' : 'btn-ghost'}" href="/register?as=passenger">Choose ${p.name}</a></div>`)}
      </div>
      <p class="muted" style="margin-top:18px">Pay as you go from a prepaid ride balance: ${rand(tripFare(km, s))} a trip, or ${rand(tripFare(km, s, true))} shared.</p>
    </div>
  </section>

  <section class="lp lp-white" id="share">
    <div class="wrap page feature">
      <div>
        <h2>Share the ride. Pay ${pct}% less.</h2>
        <p class="lede">Neighbours who work in the same area and leave at about the same time ride together. You keep door-to-door service and your own pickup time.</p>
        <ul class="ticks">
          <li>Matched by home area, work area and pickup time</li>
          <li>Never more people than the car has seats</li>
          <li>The shared price applies even when nobody joins you</li>
        </ul>
        <a class="btn" href="/register?as=passenger">Start sharing</a>
      </div>
      <div class="feature-visual">${ill('shared')}</div>
    </div>
  </section>

  <section class="lp lp-white" style="padding-top:0">
    <div class="wrap page feature flip">
      <div>
        <h2>Know who is coming, every day</h2>
        <p class="lede">See your driver's name, car and registration before every ride. Get a reminder before pickup, and a message straight away if anything changes.</p>
        <ul class="ticks"><li>Pickup reminders on WhatsApp, SMS or email</li><li>Live location once your driver is on the way</li><li>Backup drivers you have approved</li></ul>
      </div>
      <div class="feature-visual light" aria-hidden="true">
        <div>
          <div class="mock"><div class="row-between"><strong>Tomorrow, 06:30</strong><span class="pill pill-scheduled">Scheduled</span></div>
            <div class="driver" style="margin-top:12px"><div class="avatar">TM</div><div><strong>Thabo Mokoena</strong><br><span class="muted">White Toyota Corolla Quest · HJ 23 KL GP</span><br><span class="stars">★ 4.9</span></div></div></div>
          <div class="mock"><div class="row-between"><strong>Your driver is on the way</strong><span class="pill pill-en_route">4 min</span></div><p class="muted">Orlando West → Sandton</p></div>
        </div>
      </div>
    </div>
  </section>

  <section class="lp lp-dark" id="drive">
    <div class="wrap page">
      <div class="feature">
        <div>
          <h2>Drive with Go Rides</h2>
          <p class="lede">Regular passengers on routes you know, booked a week ahead. You keep ${100 - s.commission_pct}% of every fare, and a full shared car earns more than a solo trip.</p>
          <a class="btn btn-light" href="/register?as=driver">Sign up to drive</a>
        </div>
        <div class="feature-visual" style="background:#141416" aria-hidden="true">
          <div class="mock"><span class="muted">This week</span><div class="big">R3 240</div><span class="muted">42 trips · ★ 4.9</span>
            <div class="mock-bars"><span style="height:70%"></span><span style="height:85%"></span><span style="height:60%"></span><span style="height:95%"></span><span style="height:80%"></span><span class="dim" style="height:20%"></span><span class="dim" style="height:10%"></span></div></div>
        </div>
      </div>
      <div class="cols3" style="margin-top:56px">
        <div><h3>Know your week in advance</h3><p>Trips are booked seven days ahead, so you can plan your days and your income.</p><a class="text-link" href="/register?as=driver">Sign up to drive</a></div>
        <div><h3>Regular passengers</h3><p>Commuters choose you as their driver and ride with you every day.</p><a class="text-link" href="/register?as=driver">Get started</a></div>
        <div><h3>Set your hours</h3><p>Choose the days and times you drive, and book time off whenever you need it.</p><a class="text-link" href="/register?as=driver">Learn more</a></div>
      </div>
    </div>
  </section>

  <section class="lp lp-white" id="business">
    <div class="wrap page feature flip">
      <div>
        <h2>Go Rides for Business</h2>
        <p class="lede">Get your team to work on time. Add employees, and their rides are billed to you on one monthly invoice with a report of every trip.</p>
        <ul class="ticks"><li>Add or remove employees in seconds</li><li>Monthly report of rides, costs and late pickups</li><li>Shared rides to cut transport costs</li></ul>
        <a class="btn" href="/register?as=business">Open a business account</a>
      </div>
      <div class="feature-visual orange" aria-hidden="true">
        <div class="mock"><div class="row-between"><strong>October report</strong><span class="muted">42 employees</span></div>
          <div class="row-between"><span class="muted">Rides</span><strong>1 764</strong></div>
          <div class="row-between"><span class="muted">On time</span><strong>97%</strong></div>
          <div class="row-between"><span class="muted">Amount due</span><strong>R61 740</strong></div></div>
      </div>
    </div>
  </section>

  <section class="lp lp-white" id="safety" style="padding-top:0">
    <div class="wrap page feature">
      <div>
        <h2>Safety in every ride</h2>
        <p class="lede">Every driver is checked before their first trip, and help is one tap away during every ride.</p>
        <ul class="ticks"><li>ID, driver's licence and PrDP checked</li><li>Share your live trip with family</li><li>SOS alerts reach our team and your emergency contact</li></ul>
      </div>
      <div class="feature-visual">${ill('safety')}</div>
    </div>
  </section>

  <section class="lp lp-white" style="padding-top:0">
    <div class="wrap page">
      <div class="banner">
        <div><h2>Ready for an easier commute?</h2><p>Set up your weekly trips in a few minutes. Your first ride can be booked tomorrow.</p>
          <div class="row" style="margin-top:20px"><a class="btn" href="/register?as=passenger">Plan my commute</a><a class="btn btn-light" href="/register?as=driver">Drive with us</a></div></div>
        ${ill('calendar')}
      </div>
    </div>
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
  app.get('/', async (req, res) => res.send(String(await landing(req, db))));
  app.get('/home', requireRole('passenger', 'driver', 'admin', 'business'), async (req, res) => res.redirect(homeFor(req.user)));

  app.get('/register', async (req, res) => {
    const as = ['passenger', 'driver', 'business'].includes(req.query.as) ? req.query.as : 'passenger';
    res.send(String(registerPage(req, as)));
  });

  app.post('/register', async (req, res) => {
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
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail('There is already an account with that email. Log in instead.');
    const channels = list(b.channels).filter(c => CHANNELS.some(([v]) => v === c)).join(',') || 'email';

    const userId = await tx(db, async db => {
      let businessId = null;
      if (as === 'business') {
        businessId = (await db.prepare('INSERT INTO businesses (name, billing_email) VALUES (?, ?)').run(b.company.trim(), email)).lastInsertRowid;
      }
      const id = (await db.prepare('INSERT INTO users (role, name, email, phone, password_hash, channels, business_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(as, b.name.trim(), email, b.phone.trim(), hashPassword(b.password), channels, businessId)).lastInsertRowid;
      if (as === 'passenger') {
        await db.prepare(`INSERT INTO passengers (user_id, home_address, work_address, zone, work_zone, distance_km, share_rides, emergency_name, emergency_phone)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, b.home_address.trim(), b.work_address.trim(), b.zone, b.work_zone,
          Math.min(80, Math.max(1, Number(b.distance_km) || 10)), b.share_rides ? 1 : 0, b.emergency_name || null, b.emergency_phone || null);
      } else if (as === 'driver') {
        await db.prepare(`INSERT INTO drivers (user_id, zone, vehicle, vehicle_reg, vehicle_colour, seats, id_number, licence_no, prdp_no)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, b.zone, b.vehicle.trim(), b.vehicle_reg.trim().toUpperCase(), b.vehicle_colour || null,
          Math.max(1, Number(b.seats) || 4), b.id_number.trim(), b.licence_no.trim(), b.prdp_no || null);
        // Sensible default: weekdays 05:00 to 20:00. Drivers adjust it on their availability page.
        const avail = db.prepare("INSERT INTO driver_availability (driver_id, weekday, start_time, end_time) VALUES (?, ?, '05:00', '20:00')");
        for (let d = 1; d <= 5; d++) await avail.run(id, d);
      }
      return id;
    });
    await createSession(db, res, userId);
    const next = { passenger: '/passenger/schedule?ok=Welcome to Go Rides! Set up your weekly trips.', driver: '/driver?ok=Thanks for registering. We will verify your documents and let you know.', business: '/business?ok=Your business account is ready. Add your employees.' }[as];
    res.redirect(next);
  });

  // One-time creation of the first admin account on a new database. It works only while
  // no admin exists, and only for someone who knows SETUP_CODE from the host's settings.
  const setupOpen = async () => Boolean(process.env.SETUP_CODE) && !await db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
  const setupPage = (req, error = '') => layout(req, { title: 'Set up Go Rides', body: html`<section class="narrow">
    <h1>Create the admin account</h1>
    <p>This page works once, while Go Rides has no admin. Enter the setup code from your hosting settings.</p>
    ${error ? html`<p class="flash err">${error}</p>` : ''}
    <form method="post" action="/setup" class="form">
      ${field('Setup code', html`<input name="code" required autocomplete="off">`)}
      ${field('Your name', html`<input name="name" required autocomplete="name">`)}
      ${field('Email', html`<input type="email" name="email" required autocomplete="email">`)}
      ${field('Mobile number', html`<input type="tel" name="phone" required autocomplete="tel">`)}
      ${field('Password', html`<input type="password" name="password" required minlength="10" autocomplete="new-password">`, 'At least 10 characters')}
      <button class="btn">Create admin account</button>
    </form></section>` });

  app.get('/setup', async (req, res) => {
    if (!await setupOpen()) return res.status(404).send(String(layout(req, { title: 'Not found', body: html`<h1>Page not found</h1><p><a href="/">Back to Go Rides</a></p>` })));
    res.send(String(setupPage(req)));
  });

  app.post('/setup', async (req, res) => {
    if (!await setupOpen()) return res.status(404).send('Setup is closed.');
    const b = req.body;
    const fail = msg => res.status(400).send(String(setupPage(req, msg)));
    const given = Buffer.from(String(b.code ?? '')), expected = Buffer.from(process.env.SETUP_CODE);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail('That setup code is not right.');
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!b.name?.trim() || !email || !b.phone?.trim()) return fail('Please fill in all the fields.');
    if (String(b.password ?? '').length < 10) return fail('Your password needs at least 10 characters.');
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail('There is already an account with that email.');
    const { lastInsertRowid } = await db.prepare("INSERT INTO users (role, name, email, phone, password_hash, channels) VALUES ('admin', ?, ?, ?, ?, 'email')")
      .run(b.name.trim(), email, b.phone.trim(), hashPassword(b.password));
    await createSession(db, res, lastInsertRowid);
    res.redirect('/admin?ok=Admin account created. You can now remove SETUP_CODE from your hosting settings.');
  });

  app.get('/login', async (req, res) => {
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

  app.post('/login', async (req, res) => {
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.email ?? '').trim().toLowerCase());
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
      return res.redirect(`/login?failed=1${req.body.next ? `&next=${encodeURIComponent(req.body.next)}` : ''}`);
    }
    await createSession(db, res, user.id);
    const next = String(req.body.next ?? '');
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : homeFor(user));
  });

  app.post('/logout', async (req, res) => { await destroySession(db, req, res); res.redirect('/'); });

  app.get('/notifications', requireRole('passenger', 'driver', 'admin', 'business'), async (req, res) => {
    const items = await db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    await db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    res.send(String(layout(req, { title: 'Notifications', body: html`<h1>Notifications</h1>
      ${items.length ? html`<ul class="list">${items.map(n => html`<li class="card ${n.read_at ? '' : 'unread'}">
        <strong>${n.title}</strong><p>${n.body}</p><small class="muted">${n.created_at} UTC${n.deliveries ? ` · ${n.deliveries}` : ''}</small></li>`)}</ul>`
        : html`<p class="empty">Nothing yet.</p>`}` })));
  });

  // Public, unguessable link a passenger can send to family to follow their ride.
  app.get('/t/:token', async (req, res) => {
    const t = await sharedTrip(db, req.params.token);
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

  app.get('/api/track/:token', async (req, res) => {
    const t = await sharedTrip(db, req.params.token);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(trackPayload(t));
  });

  // Payments
  app.get('/payments/:id/checkout', requireRole('passenger'), async (req, res) => {
    const p = await db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").get(Number(req.params.id), req.user.id);
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

  app.post('/payments/:id/simulate', requireRole('passenger'), async (req, res) => {
    if (payfastEnabled()) return res.status(400).send('Simulated payments are switched off.');
    const p = await db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").get(Number(req.params.id), req.user.id);
    if (!p) return res.status(404).send('Payment not found.');
    await markPaid(db, p.id, `SIM-${p.id}`);
    await req.app.locals.runBooking();
    res.redirect('/passenger/billing?ok=Payment received. Thank you!');
  });

  app.get('/payments/:id/done', requireRole('passenger'), async (req, res) => {
    res.redirect('/passenger/billing?ok=Thanks! Your payment is being confirmed and will show here shortly.');
  });

  app.post('/payments/notify', async (req, res) => {
    const result = await handlePayfastNotify(db, req.body);
    if (result === 'ok') await req.app.locals.runBooking();
    else console.warn(`[payfast] notification rejected: ${result}`);
    res.sendStatus(200);
  });
}

export async function sharedTrip(db, token) {
  return await db.prepare(`SELECT t.*, substr(pu.name, 1, instr(pu.name || ' ', ' ') - 1) AS passenger_first,
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

