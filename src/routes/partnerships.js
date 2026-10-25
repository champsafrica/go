import { html } from '../views/html.js';
import { layout, csrf, field, empty } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { notifyAdmins, sendDirectEmail } from '../notify.js';
import { ZONES } from '../config.js';

export const PARTNER_TYPES = {
  corporate: ['Corporate transport', 'Get your staff to work on time with Go for Business: scheduled rides, shared cars and one monthly invoice.'],
  fleet: ['Fleet owners and drivers', 'Bring your vehicles and vetted drivers onto the network and fill them with regular, booked-ahead passengers.'],
  logistics: ['Retail and logistics', 'Send parcels between your branches, stores and customers on Go Parcels commuter runs at fixed prices.'],
  education: ['Schools and campuses', 'Scheduled transport for students and staff, with the same vetted drivers every day.'],
  advertising: ['Advertising with Go Ads', 'Put your brand on Go Rides vehicles that cover the same busy routes every day, with Go Ads.'],
  other: ['Something else', 'Have another idea for working together? Tell us about it.']
};
const STATUS = { new: ['New', 'unassigned'], contacted: ['Contacted', 'scheduled'], active: ['Active partner', 'completed'], declined: ['Declined', 'cancelled'] };

export default function partnershipRoutes(app, db) {
  const page = (req, res, values = {}, error = '') => {
    const v = k => values[k] ?? '';
    res.status(error ? 400 : 200).send(String(layout(req, { title: 'Partnerships', body: html`
      <h1>Partner with Go Rides</h1>
      <p class="lede">Go Rides is a planned transport and logistics network: the same routes, the same drivers, every day. That makes it a strong base to build on together.</p>
      <div class="grid-2 partner-types">${Object.entries(PARTNER_TYPES).filter(([k]) => k !== 'other').map(([, [name, text]]) => html`<div class="card"><h3>${name}</h3><p class="muted">${text}</p></div>`)}</div>
      <h2 id="apply">Apply to partner</h2>
      ${error ? html`<p class="flash err">${error}</p>` : ''}
      <form method="post" action="/partnerships" class="form card">${csrf(req)}
        ${field('Type of partnership', html`<select name="type" required>${Object.entries(PARTNER_TYPES).map(([k, [name]]) => html`<option value="${k}" ${v('type') === k ? 'selected' : ''}>${name}</option>`)}</select>`)}
        <div class="grid-2">
          ${field('Organisation', html`<input name="organisation" required maxlength="120" value="${v('organisation')}">`)}
          ${field('Your name', html`<input name="contact_name" required maxlength="80" autocomplete="name" value="${v('contact_name')}">`)}
          ${field('Email', html`<input type="email" name="email" required autocomplete="email" value="${v('email')}">`)}
          ${field('Phone', html`<input type="tel" name="phone" required autocomplete="tel" value="${v('phone')}">`)}
        </div>
        ${field('City or area', html`<select name="city"><option value="">Choose</option>${ZONES.map(z => html`<option ${v('city') === z ? 'selected' : ''}>${z}</option>`)}</select>`)}
        ${field('Tell us what you have in mind', html`<textarea name="message" rows="4" required maxlength="2000">${v('message')}</textarea>`)}
        <label class="hp" aria-hidden="true">Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="consent" required> Go Rides may contact me about this partnership and keep these details for that purpose (POPIA).</label>
        <button class="btn">Send application</button>
      </form>` })));
  };

  app.get('/partnerships', (req, res) => page(req, res));

  app.post('/partnerships', async (req, res) => {
    const b = req.body;
    if (b.website) return res.redirect('/partnerships?ok=Thank you. We will be in touch.'); // a bot filled the hidden field
    const f = Object.fromEntries(['type', 'organisation', 'contact_name', 'email', 'phone', 'city', 'message'].map(k => [k, String(b[k] ?? '').trim()]));
    if (!PARTNER_TYPES[f.type]) return page(req, res, f, 'Choose a type of partnership.');
    if (!f.organisation || !f.contact_name || !f.phone || !f.message) return page(req, res, f, 'Please fill in all the required fields.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return page(req, res, f, 'That email address does not look right.');
    if (!b.consent) return page(req, res, f, 'Please agree that we may contact you.');
    await db.prepare('INSERT INTO partnership_requests (type, organisation, contact_name, email, phone, city, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.type, f.organisation.slice(0, 120), f.contact_name.slice(0, 80), f.email.slice(0, 120), f.phone.slice(0, 20), ZONES.includes(f.city) ? f.city : null, f.message.slice(0, 2000));
    await notifyAdmins(db, 'New partnership application', `${f.organisation} (${PARTNER_TYPES[f.type][0]}): ${f.contact_name}, ${f.phone}.`);
    sendDirectEmail(f.email, 'Thank you for your interest in partnering with Go Rides', `Hi ${f.contact_name}, thank you for applying to partner with Go Rides. Our team will contact you within two working days.`);
    res.redirect(`/partnerships?ok=${encodeURIComponent('Thank you. Our team will contact you within two working days.')}`);
  });

  const admin = requireRole('admin');
  app.get('/admin/partnerships', admin, async (req, res) => {
    const rows = await db.prepare("SELECT * FROM partnership_requests ORDER BY status = 'new' DESC, id DESC LIMIT 200").all();
    res.send(String(layout(req, { title: 'Partnerships', wide: true, body: html`
      <h1>Partnership applications</h1>
      ${rows.length ? html`<div class="grid-2">${rows.map(r => html`<article class="card">
        <div class="row-between"><strong>${r.organisation}</strong><span class="pill pill-${STATUS[r.status][1]}">${STATUS[r.status][0]}</span></div>
        <p class="muted">${PARTNER_TYPES[r.type]?.[0] ?? r.type}${r.city ? ` · ${r.city}` : ''} · ${r.created_at.slice(0, 10)}</p>
        <p>${r.contact_name} · <a href="tel:${r.phone}">${r.phone}</a> · <a href="mailto:${r.email}">${r.email}</a></p>
        <p>${r.message}</p>
        <form method="post" action="/admin/partnerships/${r.id}" class="form">${csrf(req)}
          <div class="grid-2">${field('Status', html`<select name="status">${Object.entries(STATUS).map(([k, [l]]) => html`<option value="${k}" ${k === r.status ? 'selected' : ''}>${l}</option>`)}</select>`)}
          ${field('Notes', html`<input name="notes" value="${r.notes ?? ''}">`)}</div>
          <button class="btn btn-sm btn-ghost">Save</button></form>
      </article>`)}</div>` : empty('No applications yet.')}` })));
  });

  app.post('/admin/partnerships/:id', admin, async (req, res) => {
    const status = STATUS[req.body.status] ? req.body.status : null;
    if (!status) return res.redirect('/admin/partnerships');
    await db.prepare('UPDATE partnership_requests SET status = ?, notes = ? WHERE id = ?').run(status, String(req.body.notes ?? '').slice(0, 500) || null, Number(req.params.id));
    res.redirect('/admin/partnerships?ok=Saved.');
  });
}
