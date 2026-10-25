import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { sessionMiddleware } from './auth.js';
import { runScheduler } from './booking.js';
import { createPayment } from './payments.js';
import { background } from './background.js';
import { seed } from './seed.js';
import { nowLocal } from './time.js';
import { layout } from './views/layout.js';
import { html } from './views/html.js';
import publicRoutes from './routes/public.js';
import passengerRoutes from './routes/passenger.js';
import driverRoutes from './routes/driver.js';
import adminRoutes from './routes/admin.js';
import businessRoutes from './routes/business.js';

// Booking, reminders and renewals run at most this often.
const BOOKING_INTERVAL_MS = 5 * 60 * 1000;

// Claims the next booking run if one is due. The conditional update means only one
// request (or server instance) wins each slot.
async function claimBookingRun(db) {
  const now = Date.now();
  const { changes } = await db.prepare(`UPDATE settings SET value = ? WHERE key = 'last_booking_run'
    AND CAST(value AS INTEGER) <= ?`).run(String(now), now - BOOKING_INTERVAL_MS);
  return changes === 1;
}

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.db = db;
  // Used in trip-sharing links and payment callbacks. On Vercel it defaults to the
  // project's production address.
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  app.locals.siteUrl = (process.env.SITE_URL || vercelUrl || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  app.locals.runBooking = () => runScheduler(db, nowLocal(), p => createPayment(db, p));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src https://www.openstreetmap.org; form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za; frame-ancestors 'none'"
    });
    next();
  });
  // On Vercel, files in public/ are served by its CDN before requests reach the app.
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '10kb' }));
  app.use(async (req, res, next) => { await db.ready; next(); });

  // Vercel Cron, or any scheduler that sends "Authorization: Bearer <CRON_SECRET>".
  app.get('/api/cron', async (req, res) => {
    if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'Set CRON_SECRET to enable this endpoint.' });
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorised' });
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'last_booking_run'").run(String(Date.now()));
    res.json(await app.locals.runBooking());
  });

  // Serverless hosts only run code while handling a request, so visits also trigger the
  // booking run when it is due. It finishes in the background after the response.
  app.use(async (req, res, next) => {
    if (await claimBookingRun(db)) background(app.locals.runBooking());
    next();
  });

  app.use(sessionMiddleware(db));
  for (const routes of [publicRoutes, passengerRoutes, driverRoutes, adminRoutes, businessRoutes]) routes(app, db);
  app.use((req, res) => res.status(404).send(String(layout(req, { title: 'Not found', body: html`<h1>Page not found</h1><p><a href="/">Back to Go Rides</a></p>` }))));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).send(String(layout(req, { title: 'Error', body: html`<h1>Something went wrong</h1><p>Please try again. If it keeps happening, contact support.</p>` })));
  });
  return app;
}

const db = openDb();
// The temporary demo database on Vercel starts empty each time; fill it with sample data.
if (db.demo) db.ready = db.ready.then(() => seed(db));

const app = createApp(db);
export default app;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Go Rides running on ${app.locals.siteUrl}`));
  // A long-running server books on a timer too, so quiet periods still get reminders.
  const tick = async () => {
    try { await db.ready; if (await claimBookingRun(db)) await app.locals.runBooking(); }
    catch (err) { console.error('[scheduler]', err); }
  };
  tick();
  setInterval(tick, BOOKING_INTERVAL_MS);
}
