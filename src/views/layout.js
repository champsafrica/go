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

// Links for visitors, to sections of the landing page.
const PUBLIC_LINKS = [['/#ride', 'Ride'], ['/#share', 'Shared rides'], ['/#drive', 'Drive'], ['/#business', 'Business'], ['/#safety', 'Safety']];

// landing: full-width sections that set their own containers, instead of one column.
export function layout(req, { title, body, wide = false, landing = false }) {
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
<link rel="preload" href="/fonts/poppins-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/poppins-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a href="${user ? '/home' : '/'}" class="brand">${logo}</a>
    ${user ? '' : html`<nav class="top-links" aria-label="Go Rides">${PUBLIC_LINKS.map(([href, label]) => html`<a href="${href}">${label}</a>`)}</nav>`}
    ${user ? html`<nav class="top-actions">
      <a href="/notifications" class="bell" aria-label="Notifications">${raw('<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>')}${unread ? html`<span class="badge">${unread}</span>` : ''}</a>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${req.csrf}"><button class="link">Log out</button></form>
    </nav>` : html`<nav class="top-actions"><a href="/login">Log in</a><a href="/register" class="btn btn-sm btn-light btn-pill">Sign up</a>
      <details class="menu"><summary aria-label="Menu">${raw('<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>')}</summary>
        <div class="menu-panel">${PUBLIC_LINKS.map(([href, label]) => html`<a href="${href}">${label}</a>`)}</div></details></nav>`}
  </div>
  ${links.length ? html`<nav class="tabs"><div class="wrap tabs-inner">${links.map(([href, label]) =>
    html`<a href="${href}" class="${req.path === href ? 'active' : ''}">${label}</a>`)}</div></nav>` : ''}
</header>
${req.app.locals.db?.demo ? html`<div class="demo-bar" role="note"><div class="wrap ${landing || wide ? 'page' : ''}"><strong>Demo:</strong> sample data that resets from time to time. Log in as <code>zanele@gorides.test</code> (passenger), <code>thabo@gorides.test</code> (driver) or <code>admin@gorides.test</code>, password <code>gorides123</code>.</div></div>` : ''}
<main class="${landing ? 'landing' : `wrap ${wide ? 'wide' : ''}`}">
  ${ok || err ? html`<div class="${landing ? 'wrap page' : ''}">
    ${ok ? html`<p class="flash ok" role="status">${ok}</p>` : ''}
    ${err ? html`<p class="flash err" role="alert">${err}</p>` : ''}</div>` : ''}
  ${body}
</main>
<footer class="foot"><div class="wrap">
  <div class="foot-top">${logo}<p class="tagline">Your driver. Your schedule. Your ride.</p></div>
  <div class="foot-cols">
    <div><h4>Ride</h4><ul><li><a href="/#ride">How it works</a></li><li><a href="/#prices">Prices</a></li><li><a href="/#share">Shared rides</a></li><li><a href="/#safety">Safety</a></li></ul></div>
    <div><h4>Work with us</h4><ul><li><a href="/#drive">Drive with Go Rides</a></li><li><a href="/#business">Business accounts</a></li><li><a href="/register?as=driver">Driver sign-up</a></li></ul></div>
    <div><h4>Your account</h4><ul><li><a href="/login">Log in</a></li><li><a href="/register">Sign up</a></li><li><a href="/register?as=business">Employer sign-up</a></li></ul></div>
    <div><h4>Go Ads</h4><ul><li><a href="https://www.goads.co.za">www.goads.co.za</a></li></ul></div>
  </div>
  <div class="foot-bottom"><span>© ${new Date().getFullYear()} Go Rides, a Go Ads service</span><span>Johannesburg · Pretoria · Cape Town · Durban</span></div>
</div></footer>
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
