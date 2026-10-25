import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { openDb, getSettings } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const booking = await import('../src/booking.js');
const { tripFare, planPrice, driverPayout } = await import('../src/pricing.js');
const { createPayment, markPaid, payfastSignature } = await import('../src/payments.js');
const { addDays, weekday } = await import('../src/time.js');

// A fixed Monday so weekday logic is predictable.
const MONDAY = '2026-11-02';
const NOW = { date: MONDAY, time: '05:00' };
let db, pw;

function user(role, name) {
  pw ??= hashPassword('x');
  return Number(db.prepare('INSERT INTO users (role, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(role, name, `${name.toLowerCase()}@t.test`, '0820000000', pw).lastInsertRowid);
}
function driver(name, zone = 'Soweto', status = 'approved') {
  const id = user('driver', name);
  db.prepare("INSERT INTO drivers (user_id, zone, vehicle, vehicle_reg, id_number, licence_no, status) VALUES (?, ?, 'Car', 'REG', 'id', 'lic', ?)").run(id, zone, status);
  for (let d = 1; d <= 5; d++) db.prepare("INSERT INTO driver_availability VALUES (?, ?, '05:00', '20:00')").run(id, d);
  return id;
}
function passenger(name, { zone = 'Soweto', workZone = 'Sandton', km = 20, sponsored = 0, share = 0 } = {}) {
  const id = user('passenger', name);
  db.prepare("INSERT INTO passengers (user_id, home_address, work_address, zone, work_zone, distance_km, sponsored, share_rides) VALUES (?, 'Home', 'Work', ?, ?, ?, ?, ?)")
    .run(id, zone, workZone, km, sponsored, share);
  return id;
}
function schedule(passengerId, preferred = null, days = '1,2,3,4,5', morning = '07:00', evening = '17:00') {
  return Number(db.prepare("INSERT INTO schedules (passenger_id, weekdays, morning_time, evening_time, preferred_driver_id) VALUES (?, ?, ?, ?, ?)")
    .run(passengerId, days, morning, evening, preferred).lastInsertRowid);
}
function setSeats(driverId, seats) {
  db.prepare('UPDATE drivers SET seats = ? WHERE user_id = ?').run(seats, driverId);
}
const mondayRun = () => trips("date = ? AND direction = 'to_work'", MONDAY);
function credit(userId, amount) {
  db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, 'topup', 'test')").run(userId, amount);
}
const trips = (where = '1=1', ...a) => db.prepare(`SELECT * FROM trips WHERE ${where} ORDER BY date, pickup_time`).all(...a);

beforeEach(() => { db = openDb(':memory:'); });

test('pricing: fare, plan discount and driver share', () => {
  const s = getSettings(db);
  assert.equal(tripFare(20, s), 54);         // R10 + 20 km x R2.20
  assert.equal(tripFare(3, s), 25);          // minimum fare
  assert.equal(tripFare(20, s, true), 38);   // 30% off when sharing
  assert.ok(tripFare(3, s, true) < tripFare(3, s), 'short shared trips are cheaper too');
  const plan = { trips_per_month: 44, discount_pct: 15 };
  assert.equal(planPrice(plan, 20, s), Math.round(54 * 44 * 0.85));
  assert.equal(driverPayout(54, s), 43.2);   // 80% to the driver
});

test('weekday helper uses ISO numbering', () => {
  assert.equal(weekday(MONDAY), 1);
  assert.equal(weekday(addDays(MONDAY, 6)), 7);
});

test('recurring schedule books weekday trips with the preferred driver', () => {
  const d = driver('Thabo');
  const p = passenger('Zanele', { sponsored: 1 });
  schedule(p, d);
  const r = booking.generateTrips(db, NOW);
  assert.equal(r.trips, 10);                 // 5 weekdays x 2 legs within a 7-day horizon
  const all = trips();
  assert.ok(all.every(t => t.driver_id === d && t.assignment === 'preferred'));
  assert.ok(all.every(t => weekday(t.date) <= 5));
  assert.equal(booking.generateTrips(db, NOW).trips, 0, 'running again books nothing twice');
});

test('passengers without a plan or balance are not booked', () => {
  driver('Thabo');
  const p = passenger('Kagiso');
  schedule(p);
  const r = booking.generateTrips(db, NOW);
  assert.equal(r.trips, 0);
  assert.ok(r.uncovered > 0);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Top up%'").get(p));
});

test('wallet balance books only as many trips as it covers', () => {
  driver('Thabo');
  const p = passenger('Kagiso');
  credit(p, 54 * 3);
  schedule(p);
  assert.equal(booking.generateTrips(db, NOW).trips, 3);
});

test('a backup driver is used when the preferred driver is busy or off', () => {
  const preferred = driver('Thabo');
  const backup = driver('Sipho');
  const p = passenger('Zanele', { sponsored: 1 });
  db.prepare('INSERT INTO backup_drivers VALUES (?, ?)').run(p, backup);
  db.prepare('INSERT INTO driver_time_off (driver_id, date) VALUES (?, ?)').run(preferred, MONDAY);
  schedule(p, preferred);
  booking.generateTrips(db, NOW);
  const monday = trips('date = ?', MONDAY);
  assert.ok(monday.every(t => t.driver_id === backup && t.assignment === 'backup'));
  assert.ok(trips('date = ?', addDays(MONDAY, 1)).every(t => t.driver_id === preferred));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Backup driver assigned'").get(p));
});

test('a driver is never double-booked inside the buffer window', () => {
  const d = driver('Thabo');
  const a = passenger('Alpha', { sponsored: 1 });
  const b = passenger('Bravo', { sponsored: 1 });
  schedule(a, d, '1');
  schedule(b, d, '1');
  booking.generateTrips(db, NOW);
  const monday = trips('date = ? AND direction = ?', MONDAY, 'to_work');
  assert.equal(monday.length, 2);
  assert.equal(monday.filter(t => t.driver_id === d).length, 1);
  assert.equal(monday.filter(t => t.status === 'unassigned').length, 1, 'no other driver, so it waits for one');
});

test('unassigned trips are picked up once a new driver is approved', () => {
  const p = passenger('Zanele', { sponsored: 1 });
  schedule(p, null, '1');
  booking.generateTrips(db, NOW);
  assert.ok(trips().every(t => t.status === 'unassigned'));
  const d = driver('Late', 'Soweto', 'pending');
  assert.equal(booking.retryUnassigned(db, NOW), 0, 'pending drivers get no trips');
  db.prepare("UPDATE drivers SET status = 'approved' WHERE user_id = ?").run(d);
  assert.equal(booking.retryUnassigned(db, NOW), 2);
});

test('time off moves trips to a backup and tells the passenger', () => {
  const d = driver('Thabo');
  const backup = driver('Sipho');
  const p = passenger('Zanele', { sponsored: 1 });
  schedule(p, d, '1');
  booking.generateTrips(db, NOW);
  db.prepare('INSERT INTO driver_time_off (driver_id, date) VALUES (?, ?)').run(d, MONDAY);
  const r = booking.reassignDriverTrips(db, d, MONDAY, NOW);
  assert.deepEqual(r, { moved: 2, unassigned: 0 });
  assert.ok(trips().every(t => t.driver_id === backup));
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Driver change'").get(p));
});

test('completed trips charge the plan first, then the wallet', () => {
  const s = getSettings(db);
  const d = driver('Thabo');
  const p = passenger('Zanele');
  db.prepare("INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end, status) VALUES (?, 1, 880, 1, ?, ?, 'active')")
    .run(p, MONDAY, addDays(MONDAY, 29));
  credit(p, 200);
  schedule(p, d, '1');
  booking.generateTrips(db, NOW);
  const [first, second] = trips();
  assert.equal(booking.settleTrip(db, first.id), 'subscription');
  assert.equal(db.prepare('SELECT driver_payout FROM trips WHERE id = ?').get(first.id).driver_payout, driverPayout(880, s));
  assert.equal(booking.settleTrip(db, second.id), 'wallet', 'plan allowance used up');
  assert.equal(booking.walletBalance(db, p), 200 - second.fare);
});

test('paying for a plan activates it; renewals create a new payment', () => {
  const p = passenger('Zanele');
  const subId = Number(db.prepare('INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end) VALUES (?, 1, 1000, 44, ?, ?)')
    .run(p, '2020-01-01', '2020-01-31').lastInsertRowid);
  const pay = createPayment(db, { userId: p, amount: 1000, purpose: 'subscription', subscriptionId: subId, item: 'plan' });
  assert.ok(markPaid(db, pay));
  assert.equal(markPaid(db, pay), false, 'paying twice does nothing');
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId);
  assert.equal(sub.status, 'active');
  // Simulate the month ending.
  const later = { date: addDays(sub.period_end, 1), time: '06:00' };
  const created = [];
  booking.runSubscriptions(db, later, x => created.push(x));
  assert.equal(db.prepare('SELECT status FROM subscriptions WHERE id = ?').get(subId).status, 'expired');
  assert.equal(created.length, 1);
  assert.equal(created[0].amount, 1000);
});

test('top-ups credit the ride balance', () => {
  const p = passenger('Kagiso');
  markPaid(db, createPayment(db, { userId: p, amount: 500, purpose: 'topup', item: '10-ride pack' }));
  assert.equal(booking.walletBalance(db, p), 500);
});

test('pickup reminders go out once inside the reminder window', () => {
  const d = driver('Thabo');
  const p = passenger('Zanele', { sponsored: 1 });
  schedule(p, d, '1');
  booking.generateTrips(db, NOW);
  assert.equal(booking.sendReminders(db, { date: MONDAY, time: '06:00' }), 0);
  assert.equal(booking.sendReminders(db, { date: MONDAY, time: '06:40' }), 1);
  assert.equal(booking.sendReminders(db, { date: MONDAY, time: '06:45' }), 0);
});

test('PayFast signature matches the documented algorithm', () => {
  const sig = payfastSignature({ merchant_id: '10000100', merchant_key: '46f0cd694581a', amount: '100.00', item_name: 'Go Rides: test item' }, 'pass phrase');
  assert.match(sig, /^[0-9a-f]{32}$/);
  assert.notEqual(sig, payfastSignature({ merchant_id: '10000100', merchant_key: '46f0cd694581a', amount: '100.01', item_name: 'Go Rides: test item' }, 'pass phrase'));
});

test('sharers on the same route and time go in one car, up to its seats', () => {
  const d = driver('Thabo');
  driver('Sipho');
  setSeats(d, 3);
  const riders = ['A', 'B', 'C', 'D'].map((n, i) => passenger(n, { sponsored: 1, share: 1 }));
  riders.forEach((p, i) => schedule(p, null, '1', `07:${String(i * 5).padStart(2, '0')}`, null));
  booking.generateTrips(db, NOW);
  const run = mondayRun();
  assert.ok(run.every(t => t.shared === 1));
  const byDriver = Object.groupBy(run, t => t.driver_id);
  assert.deepEqual(Object.values(byDriver).map(g => g.length).sort(), [1, 3], 'three in the first car, the fourth in a second');
  const first = run[0];
  assert.equal(booking.carMates(db, first).length, 2);
});

test('sharers are not pooled across different routes or far-apart times', () => {
  const d = driver('Thabo');
  setSeats(d, 4);
  const a = passenger('A', { sponsored: 1, share: 1 });
  const b = passenger('B', { sponsored: 1, share: 1, workZone: 'Midrand' });
  const c = passenger('C', { sponsored: 1, share: 1 });
  schedule(a, null, '1', '07:00', null);
  schedule(b, null, '1', '07:05', null);   // different work area
  schedule(c, null, '1', '07:40', null);   // outside the 20-minute pool window
  booking.generateTrips(db, NOW);
  const run = mondayRun();
  assert.equal(run.filter(t => t.driver_id === d).length, 1, 'only one of them fits in the car');
  assert.equal(run.filter(t => t.status === 'unassigned').length, 2);
});

test('a solo passenger never shares a car', () => {
  const d = driver('Thabo');
  setSeats(d, 4);
  const sharer = passenger('A', { sponsored: 1, share: 1 });
  const solo = passenger('B', { sponsored: 1 });
  schedule(sharer, null, '1', '07:00', null);
  schedule(solo, null, '1', '07:05', null);
  booking.generateTrips(db, NOW);
  const run = mondayRun();
  assert.equal(run.filter(t => t.driver_id === d).length, 1);
  assert.equal(run.find(t => t.passenger_id === solo).shared, 0);
});

test('a preferred driver is kept, and other sharers join their car', () => {
  const thabo = driver('Thabo');
  driver('Sipho');
  setSeats(thabo, 4);
  const a = passenger('A', { sponsored: 1, share: 1 });
  const b = passenger('B', { sponsored: 1, share: 1 });
  schedule(a, thabo, '1', '07:00', null);
  schedule(b, null, '1', '07:10', null);
  booking.generateTrips(db, NOW);
  assert.ok(mondayRun().every(t => t.driver_id === thabo), 'B joins Thabo rather than taking the free driver');
});

test('sharers without a work area book as solo rides', () => {
  driver('Thabo');
  const p = passenger('A', { sponsored: 1, share: 1, workZone: null });
  schedule(p, null, '1', '07:00', null);
  booking.generateTrips(db, NOW);
  assert.equal(mondayRun()[0].shared, 0);
});

test('turning sharing on reprices upcoming rides; turning it off moves the rider to their own car', () => {
  const s = getSettings(db);
  const thabo = driver('Thabo');
  const sipho = driver('Sipho');
  setSeats(thabo, 4);
  const a = passenger('A', { sponsored: 1, share: 1 });
  const b = passenger('B', { sponsored: 1 });
  schedule(a, thabo, '1', '07:00', null);
  schedule(b, null, '1', '07:10', null);
  booking.generateTrips(db, NOW);
  assert.equal(mondayRun().find(t => t.passenger_id === b).driver_id, sipho);

  booking.setSharing(db, b, true, NOW);
  const tb = mondayRun().find(t => t.passenger_id === b);
  assert.equal(tb.shared, 1);
  assert.equal(tb.fare, tripFare(20, s, true));

  // Put B in Thabo's car, then B stops sharing: Thabo cannot carry them alone next to A.
  db.prepare('UPDATE trips SET driver_id = ? WHERE id = ?').run(thabo, tb.id);
  const r = booking.setSharing(db, b, false, NOW);
  const after = mondayRun().find(t => t.passenger_id === b);
  assert.equal(after.shared, 0);
  assert.equal(after.fare, tripFare(20, s));
  assert.equal(after.driver_id, sipho);
  assert.equal(r.moved, 1);
});

test('leaving a shared car with no other driver free reports it once, not per ride', () => {
  const thabo = driver('Thabo');
  setSeats(thabo, 4);
  const a = passenger('A', { sponsored: 1, share: 1 });
  const b = passenger('B', { sponsored: 1, share: 1 });
  schedule(a, thabo);
  schedule(b, thabo, '1,2,3,4,5', '07:10', '17:10');
  booking.generateTrips(db, NOW);
  assert.ok(trips('passenger_id = ?', b).every(t => t.driver_id === thabo));
  const r = booking.setSharing(db, b, false, NOW);
  assert.equal(r.unassigned, 10);
  assert.ok(trips('passenger_id = ?', b).every(t => t.status === 'unassigned'));
  const notes = db.prepare('SELECT title FROM notifications WHERE user_id = ?').all(b).map(n => n.title);
  assert.deepEqual(notes.filter(t => t === 'Finding you a driver'), ['Finding you a driver']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'Trips moved'").get(thabo).n, 1);
});
