import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');

const express = (await import('express')).default;
const { openDb } = await import('./db.js');
const { sessionMiddleware } = await import('./auth.js');
const { runScheduler } = await import('./booking.js');
const { createPayment } = await import('./payments.js');
const { nowLocal } = await import('./time.js');
const { layout } = await import('./views/layout.js');
const { html } = await import('./views/html.js');

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.db = db;
  app.locals.siteUrl = (process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  app.locals.runBooking = () => runScheduler(db, nowLocal(), p => createPayment(db, p));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src https://www.openstreetmap.org; form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za; frame-ancestors 'none'"
    });
    next();
  });
  app.use(express.static(new URL('../public', import.meta.url).pathname, { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '10kb' }));
  app.use(sessionMiddleware(db));

  return Promise.all(['public', 'passenger', 'driver', 'admin', 'business'].map(n => import(`./routes/${n}.js`)))
    .then(mods => {
      for (const m of mods) m.default(app, db);
      app.use((req, res) => res.status(404).send(String(layout(req, { title: 'Not found', body: html`<h1>Page not found</h1><p><a href="/">Back to Go Rides</a></p>` }))));
      app.use((err, req, res, _next) => {
        console.error(err);
        res.status(500).send(String(layout(req, { title: 'Error', body: html`<h1>Something went wrong</h1><p>Please try again. If it keeps happening, contact support.</p>` })));
      });
      return app;
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  const app = await createApp(db);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Go Rides running on ${app.locals.siteUrl}`));
  // Book upcoming trips, send pickup reminders and renew plans every five minutes.
  const tick = () => { try { app.locals.runBooking(); } catch (err) { console.error('[scheduler]', err); } };
  tick();
  setInterval(tick, 5 * 60 * 1000);
}
