import { html } from '../views/html.js';
import { layout, csrf, field, empty } from '../views/layout.js';
import { requireRole } from '../auth.js';
import { notify } from '../notify.js';
import { rand } from '../pricing.js';
import { nowLocal } from '../time.js';

export default function businessRoutes(app, db) {
  const only = requireRole('business');
  const page = (req, res, title, body) => res.send(String(layout(req, { title, body })));
  const company = async req => await db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.user.business_id);

  app.get('/business', only, async (req, res) => {
    const b = await company(req);
    const month = nowLocal().date.slice(0, 7);
    const staff = await db.prepare(`SELECT u.id, u.name, u.email, u.phone, p.zone, p.sponsored,
        (SELECT COUNT(*) FROM trips t WHERE t.passenger_id = u.id AND t.status = 'completed' AND t.payment_source = 'business' AND substr(t.date, 1, 7) = ?) AS trips,
        (SELECT COUNT(*) FROM schedules s WHERE s.passenger_id = u.id AND s.active = 1) AS schedules
      FROM users u JOIN passengers p ON p.user_id = u.id WHERE u.business_id = ? ORDER BY u.name`).all(month, b.id);
    page(req, res, 'Employees', html`
      <h1>${b.name}</h1>
      <p>Add employees whose commute you pay for. Their completed rides are billed to ${b.name} each month.</p>
      <form method="post" action="/business/employees" class="form card">${csrf(req)}
        ${field("Employee's email", html`<input type="email" name="email" required>`, html`They need a Go Rides passenger account first. Share this link: <strong>${req.app.locals.siteUrl}/register?as=passenger</strong>`)}
        <button class="btn btn-sm">Add employee</button></form>
      <h2>Employees (${staff.length})</h2>
      ${staff.length ? html`<table class="table"><thead><tr><th>Name</th><th>Area</th><th class="num">Rides this month</th><th></th></tr></thead><tbody>
        ${staff.map(s => html`<tr><td><strong>${s.name}</strong><br><small>${s.email} · ${s.phone}</small>${s.schedules ? '' : html`<br><small class="muted">No schedule set yet</small>`}</td><td>${s.zone}</td><td class="num">${s.trips}</td>
          <td><form method="post" action="/business/employees/${s.id}/remove">${csrf(req)}<button class="link danger" data-confirm="Stop paying for ${s.name}'s rides?">Remove</button></form></td></tr>`)}</tbody></table>`
        : empty('No employees added yet.')}`);
  });

  app.post('/business/employees', only, async (req, res) => {
    const b = await company(req);
    const emp = await db.prepare("SELECT u.* FROM users u JOIN passengers p ON p.user_id = u.id WHERE u.email = ?").get(String(req.body.email ?? '').trim().toLowerCase());
    if (!emp) return res.redirect('/business?err=No passenger account with that email. Ask them to sign up first.');
    if (emp.business_id && emp.business_id !== b.id) return res.redirect('/business?err=That person is already linked to another employer.');
    await db.prepare('UPDATE users SET business_id = ? WHERE id = ?').run(b.id, emp.id);
    await db.prepare('UPDATE passengers SET sponsored = 1 WHERE user_id = ?').run(emp.id);
    await notify(db, emp.id, `${b.name} is paying for your rides`, 'Set your weekly schedule in Go Rides and your rides will be booked automatically.');
    await req.app.locals.runBooking();
    res.redirect('/business?ok=Employee added.');
  });

  app.post('/business/employees/:id/remove', only, async (req, res) => {
    const b = await company(req);
    const id = Number(req.params.id);
    const changed = (await db.prepare('UPDATE users SET business_id = NULL WHERE id = ? AND business_id = ?').run(id, b.id)).changes;
    if (changed) {
      await db.prepare('UPDATE passengers SET sponsored = 0 WHERE user_id = ?').run(id);
      await notify(db, id, `${b.name} no longer pays for your rides`, 'Choose a plan or buy a ride pack to keep travelling with Go Rides.');
    }
    res.redirect('/business?ok=Employee removed.');
  });

  app.get('/business/report', only, async (req, res) => {
    const b = await company(req);
    const month = /^\d{4}-\d{2}$/.test(req.query.month ?? '') ? req.query.month : nowLocal().date.slice(0, 7);
    const rows = await db.prepare(`SELECT u.name, COUNT(t.id) AS trips, COALESCE(SUM(t.fare), 0) AS cost, SUM(t.delay_minutes > 0) AS late
      FROM trips t JOIN users u ON u.id = t.passenger_id
      WHERE u.business_id = ? AND t.payment_source = 'business' AND t.status = 'completed' AND substr(t.date, 1, 7) = ?
      GROUP BY u.id ORDER BY u.name`).all(b.id, month);
    const total = rows.reduce((a, r) => a + r.cost, 0);
    page(req, res, 'Report', html`
      <div class="row-between"><h1>Monthly report</h1>
        <form method="get" class="filters"><input type="month" name="month" value="${month}" aria-label="Month"><button class="btn btn-sm">Show</button></form></div>
      <div class="grid-3">
        <div class="card stat"><span>Rides</span><strong>${rows.reduce((a, r) => a + r.trips, 0)}</strong></div>
        <div class="card stat"><span>Amount due</span><strong>${rand(total)}</strong></div>
        <div class="card stat"><span>Employees travelling</span><strong>${rows.length}</strong></div>
      </div>
      ${rows.length ? html`<table class="table"><thead><tr><th>Employee</th><th class="num">Rides</th><th class="num">Late pickups</th><th class="num">Cost</th></tr></thead><tbody>
        ${rows.map(r => html`<tr><td>${r.name}</td><td class="num">${r.trips}</td><td class="num">${r.late}</td><td class="num">${rand(r.cost)}</td></tr>`)}
        <tr class="total"><td>Total</td><td></td><td></td><td class="num">${rand(total)}</td></tr></tbody></table>
        <p class="muted">Go Rides invoices ${b.billing_email} for this amount at the end of the month. <button class="link" type="button" data-print>Print or save as PDF</button></p>` : empty('No rides billed to your company this month.')}`);
  });
}
