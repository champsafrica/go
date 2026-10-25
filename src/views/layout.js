import { html, raw } from './html.js';
import { rand } from '../pricing.js';
import { formatDate } from '../time.js';

const NAV = {
  passenger: [['/passenger', 'Home'], ['/passenger/schedule', 'Schedule'], ['/passenger/trips', 'Trips'], ['/passenger/billing', 'Plans & pay'], ['/passenger/drivers', 'Drivers']],
  driver: [['/driver', 'Today'], ['/driver/trips', 'Trips'], ['/driver/availability', 'Availability'], ['/driver/earnings', 'Earnings']],
  admin: [['/admin', 'Overview'], ['/admin/trips', 'Trips'], ['/admin/drivers', 'Drivers'], ['/admin/passengers', 'Passengers'], ['/admin/support', 'Support'], ['/admin/settings', 'Pricing']],
  business: [['/business', 'Employees'], ['/business/report', 'Report']]
};

// The Go mark from the Go Ads logo (www.goads.co.za) with "rides" in place of "ads".
export const logo = html`<img class="logo" src="/brand/go-rides-logo.png" alt="Go Rides" width="814" height="191">`;

export function layout(req, { title, body, wide = false }) {
  const user = req.user;
  const unread = req.unread ?? 0;
  const ok = req.query?.ok, err = req.query?.err;
  const links = user ? NAV[user.role] : [];
  return html`<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0b0c">
<title>${title ? `${title} | Go Rides` : 'Go Rides | Your everyday commute, sorted.'}</title>
<meta name="description" content="Scheduled, subscription-based commuter transport. Your driver. Your schedule. Your ride.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="preload" href="/fonts/inter-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a href="${user ? '/home' : '/'}" class="brand">${logo}</a>
    ${user ? html`<nav class="top-actions">
      <a href="/notifications" class="bell" aria-label="Notifications">${raw('<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>')}${unread ? html`<span class="badge">${unread}</span>` : ''}</a>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${req.csrf}"><button class="link">Log out</button></form>
    </nav>` : html`<nav class="top-actions"><a href="/login">Log in</a><a href="/register" class="btn btn-sm">Get started</a></nav>`}
  </div>
  ${links.length ? html`<nav class="tabs"><div class="wrap tabs-inner">${links.map(([href, label]) =>
    html`<a href="${href}" class="${req.path === href ? 'active' : ''}">${label}</a>`)}</div></nav>` : ''}
</header>
<main class="wrap ${wide ? 'wide' : ''}">
  ${req.app.locals.db?.demo ? html`<p class="flash demo" role="note"><strong>Demo:</strong> this site runs on temporary sample data that resets from time to time. Try it with <code>zanele@gorides.test</code> (passenger), <code>thabo@gorides.test</code> (driver) or <code>admin@gorides.test</code>, password <code>gorides123</code>.</p>` : ''}
  ${ok ? html`<p class="flash ok" role="status">${ok}</p>` : ''}
  ${err ? html`<p class="flash err" role="alert">${err}</p>` : ''}
  ${body}
</main>
<footer class="foot"><div class="wrap">${logo}<p>Your driver. Your schedule. Your ride.</p>
  <p>A Go Ads service · <a href="https://www.goads.co.za">www.goads.co.za</a></p></div></footer>
<script src="/app.js" defer></script>
</body>
</html>`;
}

export const csrf = req => html`<input type="hidden" name="_csrf" value="${req.csrf}">`;

export const STATUS_LABEL = {
  scheduled: 'Scheduled', unassigned: 'Finding driver', en_route: 'Driver on the way', arrived: 'Driver arrived',
  in_progress: 'On the road', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show'
};

export const statusPill = s => html`<span class="pill pill-${s}">${STATUS_LABEL[s] ?? s}</span>`;

export const stars = n => n == null ? html`<span class="muted">New</span>` : html`<span class="stars" title="${n} out of 5">★ ${n}</span>`;

export function tripCard(t, { actions = '', who = '' } = {}) {
  return html`<article class="card trip">
    <div class="trip-when"><strong>${t.pickup_time}</strong><span>${formatDate(t.date)}</span></div>
    <div class="trip-body">
      <div class="trip-route"><span>${t.origin}</span><span class="arrow" aria-hidden="true">→</span><span>${t.destination}</span></div>
      ${who}
      <div class="trip-meta">${statusPill(t.status)} ${t.shared ? html`<span class="pill pill-shared">Shared</span>` : ''} ${t.delay_minutes ? html`<span class="pill pill-late">${t.delay_minutes} min late</span>` : ''} <span class="muted">${rand(t.fare)}</span></div>
      ${actions}
    </div>
  </article>`;
}

export const field = (label, input, hint = '') => html`<label class="field"><span>${label}</span>${input}${hint ? html`<small>${hint}</small>` : ''}</label>`;

export const empty = text => html`<p class="empty">${text}</p>`;
