import { html, raw } from './html.js';
import { rand } from '../pricing.js';
import { formatDate } from '../time.js';

const NAV = {
  passenger: [['/passenger', 'Home'], ['/passenger/schedule', 'Schedule'], ['/passenger/trips', 'Trips'], ['/passenger/billing', 'Plans & pay'], ['/parcels', 'Parcels'], ['/passenger/drivers', 'Drivers']],
  driver: [['/driver', 'Today'], ['/driver/trips', 'Trips'], ['/driver/availability', 'Availability'], ['/driver/earnings', 'Earnings']],
  admin: [['/admin', 'Overview'], ['/admin/trips', 'Trips'], ['/admin/drivers', 'Drivers'], ['/admin/passengers', 'Passengers'], ['/admin/parcels', 'Parcels'], ['/admin/support', 'Support'], ['/admin/settings', 'Pricing']],
  business: [['/business', 'Employees'], ['/parcels', 'Parcels'], ['/business/report', 'Report']]
};

// Bottom navigation in the installed app and on phones: the main screens for each role,
// with simple line icons. Admin keeps the top tabs; it is mostly used on a computer.
const ICON = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  car: 'M5 16l1.5-6A2 2 0 0 1 8.4 8.5h7.2a2 2 0 0 1 1.9 1.5L19 16M4 16h16v3H4zM7 19v1.5M17 19v1.5',
  box: 'M4 8l8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  sun: 'M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7M22 21v-1a6 6 0 0 0-4-5.6'
};
const APP_NAV = {
  passenger: [['/passenger', 'Home', 'home'], ['/passenger/schedule', 'Schedule', 'calendar'], ['/passenger/trips', 'Trips', 'car'], ['/parcels', 'Parcels', 'box'], ['/passenger/billing', 'Pay', 'card']],
  driver: [['/driver', 'Today', 'sun'], ['/driver/trips', 'Trips', 'car'], ['/driver/availability', 'Hours', 'clock'], ['/driver/earnings', 'Earnings', 'chart']],
  business: [['/business', 'Team', 'users'], ['/parcels', 'Parcels', 'box'], ['/business/report', 'Report', 'chart']]
};
const icon = name => raw(`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="${ICON[name]}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`);

// The Go mark from the Go Ads logo (www.goads.co.za) with "rides" in place of "ads".
export const logo = html`<img class="logo" src="/brand/go-rides-logo.png" alt="Go Rides" width="814" height="191">`;

// Links for visitors, to sections of the landing page.
const PUBLIC_LINKS = [['/#pass', 'Go Pass'], ['/#parcels', 'Go Parcels'], ['/#drive', 'Drive'], ['/#business', 'Business'], ['/#safety', 'Safety']];

// landing: full-width sections that set their own containers, instead of one column.
export function layout(req, { title, body, wide = false, landing = false }) {
  const user = req.user;
  const unread = req.unread ?? 0;
  const ok = req.query?.ok, err = req.query?.err;
  const links = user ? NAV[user.role] : [];
  const appNav = user ? APP_NAV[user.role] : null;
  return html`<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff">
<title>${title ? `${title} | Go Rides` : 'Go Rides | Your everyday commute, sorted.'}</title>
<meta name="description" content="Scheduled, subscription-based commuter transport. Your driver. Your schedule. Your ride.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="preload" href="/fonts/poppins-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/poppins-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Go Rides">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="${appNav ? 'has-appnav' : ''}">
<header class="top">
  <div class="wrap top-inner">
    <a href="${user ? '/home' : '/'}" class="brand">${logo}</a>
    ${user ? '' : html`<nav class="top-links" aria-label="Go Rides">${PUBLIC_LINKS.map(([href, label]) => html`<a href="${href}">${label}</a>`)}</nav>`}
    ${user ? html`<nav class="top-actions">
      <a href="/notifications" class="bell" aria-label="Notifications">${raw('<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>')}${unread ? html`<span class="badge">${unread}</span>` : ''}</a>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${req.csrf}"><button class="link">Log out</button></form>
    </nav>` : html`<nav class="top-actions"><button type="button" class="link install-link" data-install hidden>Install app</button><a href="/login">Log in</a><a href="/register" class="btn btn-sm">Get a Go Pass</a>
      <details class="menu"><summary aria-label="Menu">${raw('<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>')}</summary>
        <div class="menu-panel">${PUBLIC_LINKS.map(([href, label]) => html`<a href="${href}">${label}</a>`)}<a href="/app">Get the app</a></div></details></nav>`}
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
    <div><h4>Ride</h4><ul><li><a href="/#promises">The Go promises</a></li><li><a href="/#pass">Go Pass prices</a></li><li><a href="/#ride">Planned vs on-demand</a></li><li><a href="/#safety">Safety</a></li></ul></div>
    <div><h4>Move &amp; earn</h4><ul><li><a href="/#parcels">Go Parcels</a></li><li><a href="/#drive">Drive with Go Rides</a></li><li><a href="/#business">Go for Business</a></li><li><a href="/register?as=driver">Driver sign-up</a></li></ul></div>
    <div><h4>Your account</h4><ul><li><a href="/login">Log in</a></li><li><a href="/register">Sign up</a></li><li><a href="/register?as=business">Employer sign-up</a></li><li><a href="/app">Get the app</a></li></ul></div>
    <div><h4>Go Ads</h4><ul><li><a href="https://www.goads.co.za">www.goads.co.za</a></li></ul></div>
  </div>
  <div class="foot-bottom"><span>© ${new Date().getFullYear()} Go Rides, a Go Ads service</span><span>Johannesburg · Pretoria · Cape Town · Durban</span></div>
</div></footer>
${appNav ? html`<nav class="appnav" aria-label="App">${appNav.map(([href, label, ic]) =>
  html`<a href="${href}" class="${req.path === href ? 'active' : ''}" ${req.path === href ? html`aria-current="page"` : ''}>${icon(ic)}<span>${label}</span></a>`)}</nav>` : ''}
<div class="install-sheet" data-install-sheet hidden>
  <div class="sheet-card" role="dialog" aria-labelledby="install-title">
    <img src="/brand/icon-192.png" alt="" width="56" height="56">
    <div><strong id="install-title">Install Go Rides</strong><p data-install-text>Add Go Rides to your home screen for one-tap access to your rides, parcels and pickups.</p></div>
    <div class="row"><button type="button" class="btn btn-sm" data-install-go>Install</button><button type="button" class="btn btn-sm btn-ghost" data-install-close>Not now</button></div>
  </div>
</div>
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
