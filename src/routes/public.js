import { html } from '../views/html.js';
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
const ill = (name, alt = '') => html`<img src="/illustrations/${name}.svg" alt="${alt}" width="160" height="120">`;
const stop = (n, label) => html`<p class="stop"><span>${String(n).padStart(2, '0')}</span>${label}</p>`;

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
  const sample = plans.find(p => p.trips_per_month === 44) ?? plans[0];
  return layout(req, { landing: true, body: html`
  <section class="go-hero">
    <div class="wrap page go-hero-grid">
      <div>
        <p class="kicker">The planned commute · Johannesburg · Pretoria · Cape Town · Durban</p>
        <h1>Own your <span class="mark">commute</span>.</h1>
        <p class="lede">One monthly Go Pass gets you your own driver, a price that never surges, and a promise to be on time. Share with neighbours to pay less, and send parcels on the same routes.</p>
        <div class="cta-row"><a class="btn btn-go" href="#pass">Build my Go Pass</a><a class="btn btn-line" href="#parcels">Send a parcel</a></div>
        <ul class="promise-strip">
          <li><strong>No surge.</strong> Ever.</li><li><strong>Same driver</strong> daily</li><li><strong>Late?</strong> Ride credit</li><li><strong>Parcels</strong> from ${rand(s.parcel_small)}</li>
        </ul>
      </div>
      <div class="pass-stage" aria-hidden="true">
        <div class="go-pass">
          <div class="gp-top"><img src="/brand/go-rides-logo.png" alt="" class="gp-logo"><span>GO PASS · MONTHLY</span></div>
          <div class="gp-route"><div><small>FROM</small><strong>Soweto</strong><span>06:30</span></div><div class="gp-line"></div><div><small>TO</small><strong>Sandton</strong><span>17:00</span></div></div>
          <div class="gp-days">${['M', 'T', 'W', 'T', 'F'].map(d => html`<span>${d}</span>`)}<span class="off">S</span><span class="off">S</span></div>
          <div class="gp-row"><div><small>PASSENGER</small><strong>Zanele M.</strong></div><div><small>YOUR DRIVER</small><strong>Thabo M. ★4.9</strong></div></div>
          <div class="gp-foot"><div><small>PRICE LOCKED</small><strong>${rand(planPrice(sample, 24, s, true))}<em>/month</em></strong></div><div class="gp-code"></div></div>
        </div>
        <div class="sticker sticker-promise">On-time<br>Promise</div>
        <div class="sticker sticker-parcel">${ill('parcel')}<span>Parcel on board</span></div>
      </div>
    </div>
  </section>

  <section class="go-section" id="promises">
    <div class="wrap page">
      ${stop(1, 'The Go promises')}
      <h2>Four promises on-demand apps don't make</h2>
      <div class="promises">
        <article class="promise"><div class="promise-art">${ill('calendar')}</div><h3>Price Lock</h3><p>Your monthly price is fixed when you buy your Go Pass. No surge at rush hour, in the rain or on month-end Friday.</p></article>
        <article class="promise"><div class="promise-art">${ill('commute')}</div><h3>Your driver</h3><p>The same verified driver collects you every day, with approved backups if they cannot make it. You always know who is coming.</p></article>
        <article class="promise"><div class="promise-art">${ill('safety')}</div><h3>On-time Promise</h3><p>If your driver is ${s.promise_minutes} minutes late or more, or we cannot find you a driver, the ride comes back to you as credit. Automatically.</p></article>
        <article class="promise"><div class="promise-art">${ill('shared')}</div><h3>Share &amp; save</h3><p>Ride with neighbours who work near you and pay ${pct}% less, with your own pickup time and door-to-door service.</p></article>
      </div>
    </div>
  </section>

  <section class="go-section go-cream-2" id="ride">
    <div class="wrap page">
      ${stop(2, 'Planned beats on-demand')}
      <h2>Stop hailing. Start going.</h2>
      <div class="versus" role="table" aria-label="On-demand apps compared with Go Rides">
        <div class="vs-head" role="row"><span role="columnheader"></span><span role="columnheader">On-demand apps</span><span role="columnheader" class="vs-go">Go Rides</span></div>
        ${[['Price', 'Changes with demand, by surge or bidding', 'Locked for the month on your Go Pass'],
           ['Driver', 'Whoever is closest at the time', 'Your own driver, every day'],
           ['Booking', 'Request every single trip', 'Booked a week ahead, automatically'],
           ['Running late', 'Your problem', 'Ride credit under the On-time Promise'],
           ['Parcels', 'A separate courier app', 'Ride along on the same routes'],
           ['Drivers', 'Income depends on each day\'s requests', 'Next week\'s trips booked in advance']]
          .map(([k, a, b]) => html`<div class="vs-row" role="row"><span role="rowheader">${k}</span><span role="cell">${a}</span><span role="cell" class="vs-go">${b}</span></div>`)}
      </div>
    </div>
  </section>

  <section class="go-section go-forest" id="pass">
    <div class="wrap page">
      ${stop(3, 'Build your Go Pass')}
      <h2>${home && work ? `${home} to ${work}` : 'What will your Go Pass cost?'}</h2>
      <form class="pass-builder" method="get" action="/#pass">
        <label>Home area<select name="home"><option value="">Choose</option>${zoneOptions(home)}</select></label>
        <label>Work area<select name="work"><option value="">Choose</option>${zoneOptions(work)}</select></label>
        <label>How often<select name="days">${DAY_OPTIONS.map(([d, l]) => html`<option value="${d}" ${d === days ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label>Distance (km, one way)<input type="number" name="km" min="1" max="80" value="${km}" inputmode="numeric"></label>
        <button class="btn btn-go">Update prices</button>
      </form>
      <div class="passes">
        ${plans.map(p => html`<div class="pass-card ${p === best ? 'best' : ''}">${p === best ? html`<span class="tag">Best fit</span>` : ''}
          <h3>${p.name}</h3><p class="pc-meta">${p.trips_per_month} trips a month · ${p.description}</p>
          <div class="pc-prices"><div><small>Shared</small><strong>${rand(planPrice(p, km, s, true))}</strong></div><div><small>Solo</small><strong>${rand(planPrice(p, km, s))}</strong></div></div>
          <p class="pc-note">per month, price locked</p>
          <a class="btn ${p === best ? 'btn-go' : 'btn-line'}" href="/register?as=passenger">Get this pass</a></div>`)}
      </div>
      <p class="pass-note">Rather pay as you go? Prepaid rides cost ${rand(tripFare(km, s))} a trip, or ${rand(tripFare(km, s, true))} shared.</p>
    </div>
  </section>

  <section class="go-section" id="parcels">
    <div class="wrap page split">
      <div>
        ${stop(4, 'Go Parcels')}
        <h2>Your parcel rides the commute</h2>
        <p class="lede">Every morning and evening, Go Rides drivers cover the same routes, such as Soweto to Sandton, with space to spare. Go Parcels puts your package on one of those runs, so it costs little and arrives the same day.</p>
        <ol class="route-steps">
          <li><strong>Book a route and size</strong>Pick the areas, the day and the size. The price is fixed.</li>
          <li><strong>A driver collects it</strong>It travels on a scheduled run, tracked from collection to delivery.</li>
          <li><strong>Hand-over with a code</strong>The recipient gets a code by SMS. No code, no delivery.</li>
        </ol>
        <div class="cta-row"><a class="btn btn-go" href="/register?as=passenger">Send a parcel</a><a class="btn btn-line" href="#business">For businesses</a></div>
      </div>
      <div class="parcel-prices">
        ${[['small', 'Small', 'Documents, a phone, a small box'], ['medium', 'Medium', 'A shoe box to a backpack'], ['large', 'Large', 'Up to a suitcase']]
          .map(([k, name, what]) => html`<div class="pp"><div><strong>${name}</strong><span>${what}</span></div><b>${rand(s[`parcel_${k}`])}</b></div>`)}
        <div class="pp-art">${ill('parcel')}</div>
      </div>
    </div>
  </section>

  <section class="go-section go-orange" id="drive">
    <div class="wrap page split">
      <div>
        ${stop(5, 'Drive with Go')}
        <h2>Know next week's pay today</h2>
        <p class="lede">Go Rides drivers see their booked trips and parcels a week ahead. They keep ${100 - s.commission_pct}% of every fare, a full shared car pays more than a solo trip, and parcels earn extra on runs they already make.</p>
        <a class="btn btn-ink" href="/register?as=driver">Sign up to drive</a>
      </div>
      <div class="forecast-card" aria-hidden="true">
        <small>Booked for the next 7 days</small><div class="big">R3 640</div><span>42 trips · 6 parcels · ★ 4.9</span>
        <div class="fc-bars">${[70, 85, 60, 95, 80, 18, 8].map((h, i) => html`<span class="${i > 4 ? 'dim' : ''}" style="height:${h}%"></span>`)}</div>
        <div class="fc-days"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
      </div>
    </div>
  </section>

  <section class="go-section" id="business">
    <div class="wrap page split flip">
      <div>
        ${stop(6, 'Go for Business')}
        <h2>Staff transport and deliveries on one invoice</h2>
        <p class="lede">Get your team to work on time and move documents and stock between sites on the same network. One monthly report, one invoice, and nothing charged for late pickups.</p>
        <ul class="ticks"><li>Add or remove employees in seconds</li><li>Courier runs between branches with Go Parcels</li><li>On-time reporting for every employee</li></ul>
        <a class="btn btn-ink" href="/register?as=business">Open a business account</a>
      </div>
      <div class="biz-art">${ill('business')}</div>
    </div>
  </section>

  <section class="go-section go-cream-2" id="safety">
    <div class="wrap page split">
      <div>
        ${stop(7, 'Safety')}
        <h2>Someone always knows where you are</h2>
        <p class="lede">Every driver is checked before their first trip, and you ride with the same people every day.</p>
        <ul class="ticks"><li>ID, driver's licence and PrDP checked</li><li>Live trip link for family</li><li>SOS reaches our team and your emergency contact</li></ul>
      </div>
      <div class="biz-art">${ill('safety')}</div>
    </div>
  </section>

  <section class="go-section">
    <div class="wrap page">
      <div class="final-cta">
        <h2>Your commute, sorted for the whole month.</h2>
        <p>Set it up in a few minutes. Your first ride can be tomorrow morning.</p>
        <div class="cta-row"><a class="btn btn-go" href="/register?as=passenger">Get my Go Pass</a><a class="btn btn-line-light" href="/register?as=driver">Drive with us</a><a class="btn btn-line-light" href="/app">Get the app</a></div>
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
  app.get('/app', async (req, res) => {
    res.send(String(layout(req, { title: 'Get the app', body: html`
      <section class="split" style="margin-top:32px">
        <div>
          <p class="stop"><span>App</span>Go Rides on your phone</p>
          <h1 style="font-size:clamp(2rem,6vw,3rem);font-weight:800;letter-spacing:-.04em">Your rides, one tap away</h1>
          <p class="lede">Install Go Rides on your home screen. It opens like an app, with your next pickup, live tracking, parcels and notifications. There is nothing to download from an app store, and it takes no space to speak of.</p>
          <p style="margin-top:20px"><button type="button" class="btn btn-go" data-install>Install Go Rides</button></p>
          <div class="app-steps" style="margin-top:28px">
            <div class="card"><h3>Android (Chrome)</h3><ol><li>Open this page in Chrome.</li><li>Tap <strong>Install Go Rides</strong>, or the menu ⋮ then <strong>Install app</strong>.</li></ol></div>
            <div class="card"><h3>iPhone (Safari)</h3><ol><li>Open this page in Safari.</li><li>Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</li></ol></div>
          </div>
        </div>
        <div class="phone" aria-hidden="true"><div class="phone-screen">
          <div class="phone-top"><img src="/brand/go-rides-logo.png" alt=""></div>
          <div class="phone-body">
            <div class="mini"><b>Tomorrow, 06:30</b>Thabo M. · White Corolla Quest</div>
            <div class="mini dark"><span>Booked this week</span><b>10 rides</b></div>
            <div class="mini"><b>Parcel to Sandton</b>On its way</div>
            <div class="mini"><b>Price locked</b>R1 646 / month</div>
          </div>
          <div class="phone-nav"><span></span><span></span><span></span><span></span><span></span></div>
        </div></div>
      </section>` })));
  });

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

