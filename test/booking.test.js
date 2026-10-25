import { test, beforeEach, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { openDb, getSettings } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const booking = await import('../src/booking.js');
const parcels = await import('../src/parcels.js');
const { tripFare, planPrice, driverPayout } = await import('../src/pricing.js');
const { createPayment, markPaid, payfastSignature } = await import('../src/payments.js');
const { addDays, weekday } = await import('../src/time.js');

// A fixed Monday so weekday logic is predictable.
const MONDAY = '2026-11-02';
const NOW = { date: MONDAY, time: '05:00' };
let db, pw;

async function user(role, name) {
  pw ??= hashPassword('x');
  return (await db.prepare('INSERT INTO users (role, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(role, name, `${name.toLowerCase()}@t.test`, '0820000000', pw)).lastInsertRowid;
}
async function driver(name, zone = 'Soweto', status = 'approved') {
  const id = await user('driver', name);
  await db.prepare("INSERT INTO drivers (user_id, zone, vehicle, vehicle_reg, id_number, licence_no, status) VALUES (?, ?, 'Car', 'REG', 'id', 'lic', ?)").run(id, zone, status);
  for (let d = 1; d <= 5; d++) await db.prepare("INSERT INTO driver_availability VALUES (?, ?, '05:00', '20:00')").run(id, d);
  return id;
}
async function passenger(name, { zone = 'Soweto', workZone = 'Sandton', km = 20, sponsored = 0, share = 0 } = {}) {
  const id = await user('passenger', name);
  await db.prepare("INSERT INTO passengers (user_id, home_address, work_address, zone, work_zone, distance_km, sponsored, share_rides) VALUES (?, 'Home', 'Work', ?, ?, ?, ?, ?)")
    .run(id, zone, workZone, km, sponsored, share);
  return id;
}
async function schedule(passengerId, preferred = null, days = '1,2,3,4,5', morning = '07:00', evening = '17:00') {
  return (await db.prepare("INSERT INTO schedules (passenger_id, weekdays, morning_time, evening_time, preferred_driver_id) VALUES (?, ?, ?, ?, ?)")
    .run(passengerId, days, morning, evening, preferred)).lastInsertRowid;
}
async function setSeats(driverId, seats) {
  await db.prepare('UPDATE drivers SET seats = ? WHERE user_id = ?').run(seats, driverId);
}
const mondayRun = async () => await trips("date = ? AND direction = 'to_work'", MONDAY);
async function credit(userId, amount) {
  await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, 'topup', 'test')").run(userId, amount);
}
const trips = async (where = '1=1', ...a) => db.prepare(`SELECT * FROM trips WHERE ${where} ORDER BY date, pickup_time`).all(...a);

// Each test gets a fresh database file: libSQL transactions use their own connection,
// which an in-memory database would not share.
const dir = mkdtempSync(join(tmpdir(), 'go-rides-test-'));
let n = 0;
beforeEach(async () => {
  db?.close();
  db = openDb({ url: `file:${join(dir, `t${n++}.db`)}` });
  await db.ready;
});
after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

test('pricing: fare, plan discount and driver share', async () => {
  const s = await getSettings(db);
  assert.equal(tripFare(20, s), 54);         // R10 + 20 km x R2.20
  assert.equal(tripFare(3, s), 25);          // minimum fare
  assert.equal(tripFare(20, s, true), 38);   // 30% off when sharing
  assert.ok(tripFare(3, s, true) < tripFare(3, s), 'short shared trips are cheaper too');
  const plan = { trips_per_month: 44, discount_pct: 15 };
  assert.equal(planPrice(plan, 20, s), Math.round(54 * 44 * 0.85));
  assert.equal(driverPayout(54, s), 43.2);   // 80% to the driver
});

test('weekday helper uses ISO numbering', async () => {
  assert.equal(weekday(MONDAY), 1);
  assert.equal(weekday(addDays(MONDAY, 6)), 7);
});

test('recurring schedule books weekday trips with the preferred driver', async () => {
  const d = await driver('Thabo');
  const p = await passenger('Zanele', { sponsored: 1 });
  await schedule(p, d);
  const r = await booking.generateTrips(db, NOW);
  assert.equal(r.trips, 10);                 // 5 weekdays x 2 legs within a 7-day horizon
  const all = await trips();
  assert.ok(all.every(t => t.driver_id === d && t.assignment === 'preferred'));
  assert.ok(all.every(t => weekday(t.date) <= 5));
  assert.equal((await booking.generateTrips(db, NOW)).trips, 0, 'running again books nothing twice');
});

test('passengers without a plan or balance are not booked', async () => {
  await driver('Thabo');
  const p = await passenger('Kagiso');
  await schedule(p);
  const r = await booking.generateTrips(db, NOW);
  assert.equal(r.trips, 0);
  assert.ok(r.uncovered > 0);
  assert.ok(await db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Top up%'").get(p));
});

test('wallet balance books only as many trips as it covers', async () => {
  await driver('Thabo');
  const p = await passenger('Kagiso');
  await credit(p, 54 * 3);
  await schedule(p);
  assert.equal((await booking.generateTrips(db, NOW)).trips, 3);
});

test('a backup driver is used when the preferred driver is busy or off', async () => {
  const preferred = await driver('Thabo');
  const backup = await driver('Sipho');
  const p = await passenger('Zanele', { sponsored: 1 });
  await db.prepare('INSERT INTO backup_drivers VALUES (?, ?)').run(p, backup);
  await db.prepare('INSERT INTO driver_time_off (driver_id, date) VALUES (?, ?)').run(preferred, MONDAY);
  await schedule(p, preferred);
  await booking.generateTrips(db, NOW);
  const monday = await trips('date = ?', MONDAY);
  assert.ok(monday.every(t => t.driver_id === backup && t.assignment === 'backup'));
  assert.ok((await trips('date = ?', addDays(MONDAY, 1))).every(t => t.driver_id === preferred));
  assert.ok(await db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Backup driver assigned'").get(p));
});

test('a driver is never double-booked inside the buffer window', async () => {
  const d = await driver('Thabo');
  const a = await passenger('Alpha', { sponsored: 1 });
  const b = await passenger('Bravo', { sponsored: 1 });
  await schedule(a, d, '1');
  await schedule(b, d, '1');
  await booking.generateTrips(db, NOW);
  const monday = await trips('date = ? AND direction = ?', MONDAY, 'to_work');
  assert.equal(monday.length, 2);
  assert.equal(monday.filter(t => t.driver_id === d).length, 1);
  assert.equal(monday.filter(t => t.status === 'unassigned').length, 1, 'no other driver, so it waits for one');
});

test('unassigned trips are picked up once a new driver is approved', async () => {
  const p = await passenger('Zanele', { sponsored: 1 });
  await schedule(p, null, '1');
  await booking.generateTrips(db, NOW);
  assert.ok((await trips()).every(t => t.status === 'unassigned'));
  const d = await driver('Late', 'Soweto', 'pending');
  assert.equal(await booking.retryUnassigned(db, NOW), 0, 'pending drivers get no trips');
  await db.prepare("UPDATE drivers SET status = 'approved' WHERE user_id = ?").run(d);
  assert.equal(await booking.retryUnassigned(db, NOW), 2);
});

test('time off moves trips to a backup and tells the passenger', async () => {
  const d = await driver('Thabo');
  const backup = await driver('Sipho');
  const p = await passenger('Zanele', { sponsored: 1 });
  await schedule(p, d, '1');
  await booking.generateTrips(db, NOW);
  await db.prepare('INSERT INTO driver_time_off (driver_id, date) VALUES (?, ?)').run(d, MONDAY);
  const r = await booking.reassignDriverTrips(db, d, MONDAY, NOW);
  assert.deepEqual(r, { moved: 2, unassigned: 0 });
  assert.ok((await trips()).every(t => t.driver_id === backup));
  assert.ok(await db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'Driver change'").get(p));
});

test('completed trips charge the plan first, then the wallet', async () => {
  const s = await getSettings(db);
  const d = await driver('Thabo');
  const p = await passenger('Zanele');
  await db.prepare("INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end, status) VALUES (?, 1, 880, 1, ?, ?, 'active')")
    .run(p, MONDAY, addDays(MONDAY, 29));
  await credit(p, 200);
  await schedule(p, d, '1');
  await booking.generateTrips(db, NOW);
  const [first, second] = await trips();
  assert.equal(await booking.settleTrip(db, first.id), 'subscription');
  assert.equal((await db.prepare('SELECT driver_payout FROM trips WHERE id = ?').get(first.id)).driver_payout, driverPayout(880, s));
  assert.equal(await booking.settleTrip(db, second.id), 'wallet', 'plan allowance used up');
  assert.equal(await booking.walletBalance(db, p), 200 - second.fare);
});

test('paying for a plan activates it; renewals create a new payment', async () => {
  const p = await passenger('Zanele');
  const subId = (await db.prepare('INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end) VALUES (?, 1, 1000, 44, ?, ?)')
    .run(p, '2020-01-01', '2020-01-31')).lastInsertRowid;
  const pay = await createPayment(db, { userId: p, amount: 1000, purpose: 'subscription', subscriptionId: subId, item: 'plan' });
  assert.ok(await markPaid(db, pay));
  assert.equal(await markPaid(db, pay), false, 'paying twice does nothing');
  const sub = await db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId);
  assert.equal(sub.status, 'active');
  // Simulate the month ending.
  const later = { date: addDays(sub.period_end, 1), time: '06:00' };
  const created = [];
  await booking.runSubscriptions(db, later, x => created.push(x));
  assert.equal((await db.prepare('SELECT status FROM subscriptions WHERE id = ?').get(subId)).status, 'expired');
  assert.equal(created.length, 1);
  assert.equal(created[0].amount, 1000);
});

test('top-ups credit the ride balance', async () => {
  const p = await passenger('Kagiso');
  await markPaid(db, await createPayment(db, { userId: p, amount: 500, purpose: 'topup', item: '10-ride pack' }));
  assert.equal(await booking.walletBalance(db, p), 500);
});

test('pickup reminders go out once inside the reminder window', async () => {
  const d = await driver('Thabo');
  const p = await passenger('Zanele', { sponsored: 1 });
  await schedule(p, d, '1');
  await booking.generateTrips(db, NOW);
  assert.equal(await booking.sendReminders(db, { date: MONDAY, time: '06:00' }), 0);
  assert.equal(await booking.sendReminders(db, { date: MONDAY, time: '06:40' }), 1);
  assert.equal(await booking.sendReminders(db, { date: MONDAY, time: '06:45' }), 0);
});

test('PayFast signature matches the documented algorithm', async () => {
  const sig = payfastSignature({ merchant_id: '10000100', merchant_key: '46f0cd694581a', amount: '100.00', item_name: 'Go Rides: test item' }, 'pass phrase');
  assert.match(sig, /^[0-9a-f]{32}$/);
  assert.notEqual(sig, payfastSignature({ merchant_id: '10000100', merchant_key: '46f0cd694581a', amount: '100.01', item_name: 'Go Rides: test item' }, 'pass phrase'));
});

test('sharers on the same route and time go in one car, up to its seats', async () => {
  const d = await driver('Thabo');
  await driver('Sipho');
  await setSeats(d, 3);
  for (const [i, name] of ['A', 'B', 'C', 'D'].entries()) {
    await schedule(await passenger(name, { sponsored: 1, share: 1 }), null, '1', `07:${String(i * 5).padStart(2, '0')}`, null);
  }
  await booking.generateTrips(db, NOW);
  const run = await mondayRun();
  assert.ok(run.every(t => t.shared === 1));
  const byDriver = Object.groupBy(run, t => t.driver_id);
  assert.deepEqual(Object.values(byDriver).map(g => g.length).sort(), [1, 3], 'three in the first car, the fourth in a second');
  const first = run[0];
  assert.equal((await booking.carMates(db, first)).length, 2);
});

test('sharers are not pooled across different routes or far-apart times', async () => {
  const d = await driver('Thabo');
  await setSeats(d, 4);
  const a = await passenger('A', { sponsored: 1, share: 1 });
  const b = await passenger('B', { sponsored: 1, share: 1, workZone: 'Midrand' });
  const c = await passenger('C', { sponsored: 1, share: 1 });
  await schedule(a, null, '1', '07:00', null);
  await schedule(b, null, '1', '07:05', null);   // different work area
  await schedule(c, null, '1', '07:40', null);   // outside the 20-minute pool window
  await booking.generateTrips(db, NOW);
  const run = await mondayRun();
  assert.equal(run.filter(t => t.driver_id === d).length, 1, 'only one of them fits in the car');
  assert.equal(run.filter(t => t.status === 'unassigned').length, 2);
});

test('a solo passenger never shares a car', async () => {
  const d = await driver('Thabo');
  await setSeats(d, 4);
  const sharer = await passenger('A', { sponsored: 1, share: 1 });
  const solo = await passenger('B', { sponsored: 1 });
  await schedule(sharer, null, '1', '07:00', null);
  await schedule(solo, null, '1', '07:05', null);
  await booking.generateTrips(db, NOW);
  const run = await mondayRun();
  assert.equal(run.filter(t => t.driver_id === d).length, 1);
  assert.equal(run.find(t => t.passenger_id === solo).shared, 0);
});

test('a preferred driver is kept, and other sharers join their car', async () => {
  const thabo = await driver('Thabo');
  await driver('Sipho');
  await setSeats(thabo, 4);
  const a = await passenger('A', { sponsored: 1, share: 1 });
  const b = await passenger('B', { sponsored: 1, share: 1 });
  await schedule(a, thabo, '1', '07:00', null);
  await schedule(b, null, '1', '07:10', null);
  await booking.generateTrips(db, NOW);
  assert.ok((await mondayRun()).every(t => t.driver_id === thabo), 'B joins Thabo rather than taking the free driver');
});

test('sharers without a work area book as solo rides', async () => {
  await driver('Thabo');
  const p = await passenger('A', { sponsored: 1, share: 1, workZone: null });
  await schedule(p, null, '1', '07:00', null);
  await booking.generateTrips(db, NOW);
  assert.equal((await mondayRun())[0].shared, 0);
});

test('turning sharing on reprices upcoming rides; turning it off moves the rider to their own car', async () => {
  const s = await getSettings(db);
  const thabo = await driver('Thabo');
  const sipho = await driver('Sipho');
  await setSeats(thabo, 4);
  const a = await passenger('A', { sponsored: 1, share: 1 });
  const b = await passenger('B', { sponsored: 1 });
  await schedule(a, thabo, '1', '07:00', null);
  await schedule(b, null, '1', '07:10', null);
  await booking.generateTrips(db, NOW);
  assert.equal((await mondayRun()).find(t => t.passenger_id === b).driver_id, sipho);

  await booking.setSharing(db, b, true, NOW);
  const tb = (await mondayRun()).find(t => t.passenger_id === b);
  assert.equal(tb.shared, 1);
  assert.equal(tb.fare, tripFare(20, s, true));

  // Put B in Thabo's car, then B stops sharing: Thabo cannot carry them alone next to A.
  await db.prepare('UPDATE trips SET driver_id = ? WHERE id = ?').run(thabo, tb.id);
  const r = await booking.setSharing(db, b, false, NOW);
  const after = (await mondayRun()).find(t => t.passenger_id === b);
  assert.equal(after.shared, 0);
  assert.equal(after.fare, tripFare(20, s));
  assert.equal(after.driver_id, sipho);
  assert.equal(r.moved, 1);
});

test('leaving a shared car with no other driver free reports it once, not per ride', async () => {
  const thabo = await driver('Thabo');
  await setSeats(thabo, 4);
  const a = await passenger('A', { sponsored: 1, share: 1 });
  const b = await passenger('B', { sponsored: 1, share: 1 });
  await schedule(a, thabo);
  await schedule(b, thabo, '1,2,3,4,5', '07:10', '17:10');
  await booking.generateTrips(db, NOW);
  assert.ok((await trips('passenger_id = ?', b)).every(t => t.driver_id === thabo));
  const r = await booking.setSharing(db, b, false, NOW);
  assert.equal(r.unassigned, 10);
  assert.ok((await trips('passenger_id = ?', b)).every(t => t.status === 'unassigned'));
  const notes = (await db.prepare('SELECT title FROM notifications WHERE user_id = ?').all(b)).map(n => n.title);
  assert.deepEqual(notes.filter(t => t === 'Finding you a driver'), ['Finding you a driver']);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'Trips moved'").get(thabo)).n, 1);
});

// ---- On-time Promise ----

test('a pickup at or beyond the promise limit is credited back', async () => {
  const d = await driver('Thabo');
  const p = await passenger('Kagiso');
  await credit(p, 500);
  await schedule(p, d, '1', '07:00', null);
  await booking.generateTrips(db, NOW);
  const [t] = await trips();
  await db.prepare('UPDATE trips SET delay_minutes = 12 WHERE id = ?').run(t.id);
  await booking.settleTrip(db, t.id);
  assert.equal(await booking.walletBalance(db, p), 500, 'charged the fare, then credited it back');
  assert.equal((await db.prepare('SELECT promise_credit FROM trips WHERE id = ?').get(t.id)).promise_credit, t.fare);
  assert.ok(await db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = 'On-time Promise'").get(p));
});

test('a small delay under the limit is not credited', async () => {
  const d = await driver('Thabo');
  const p = await passenger('Kagiso');
  await credit(p, 500);
  await schedule(p, d, '1', '07:00', null);
  await booking.generateTrips(db, NOW);
  const [t] = await trips();
  await db.prepare('UPDATE trips SET delay_minutes = 5 WHERE id = ?').run(t.id);
  await booking.settleTrip(db, t.id);
  assert.equal(await booking.walletBalance(db, p), 500 - t.fare);
});

test('a ride that never got a driver is cancelled and credited after pickup time', async () => {
  const p = await passenger('Zanele', { sponsored: 1 });
  await schedule(p, null, '1', '07:00', null);
  await booking.generateTrips(db, NOW);
  assert.equal(await booking.creditMissedTrips(db, { date: MONDAY, time: '06:59' }), 0);
  assert.equal(await booking.creditMissedTrips(db, { date: MONDAY, time: '07:05' }), 1);
  const [t] = await trips();
  assert.equal(t.status, 'cancelled');
  assert.equal(await booking.walletBalance(db, p), t.fare);
});

// ---- Go Parcels ----

const parcelForm = (over = {}) => ({ date: MONDAY, from_zone: 'Soweto', to_zone: 'Sandton', pickup_address: 'A', dropoff_address: 'B',
  recipient_name: 'Rec', recipient_phone: '0820000001', size: 'small', ...over });

let senders = 0;
async function sender(balance = 500) {
  const id = await passenger(`Sender${senders++}`, { zone: 'Durban CBD', workZone: 'Umlazi' });
  await credit(id, balance);
  return { id, role: 'passenger', business_id: null };
}

test('a parcel rides on a scheduled run along its route and is paid from the balance', async () => {
  const d = await driver('Thabo');
  const rider = await passenger('Zanele', { sponsored: 1 });
  await schedule(rider, d, '1', '07:00', '17:00');
  await booking.generateTrips(db, NOW);
  const s = await sender();
  const out = await parcels.bookParcel(db, s, parcelForm());
  assert.ok(out.matched);
  const morning = (await trips("direction = 'to_work'"))[0];
  assert.equal(out.parcel.trip_id, morning.id, 'Soweto to Sandton goes on the morning run');
  assert.equal(await booking.walletBalance(db, s.id), 455);
  const back = await parcels.bookParcel(db, s, parcelForm({ from_zone: 'Sandton', to_zone: 'Soweto' }));
  assert.equal(back.parcel.trip_id, (await trips("direction = 'to_home'"))[0].id, 'the reverse goes on the evening run');
});

test('parcels need enough balance and respect driver capacity', async () => {
  const d = await driver('Thabo');
  const rider = await passenger('Zanele', { sponsored: 1 });
  await schedule(rider, d, '1', '07:00', null);
  await booking.generateTrips(db, NOW);
  const poor = await sender(10);
  assert.match((await parcels.bookParcel(db, poor, parcelForm())).error, /Top up/);
  const s = await sender(1000);
  for (let i = 0; i < 3; i++) assert.ok((await parcels.bookParcel(db, s, parcelForm())).matched);
  assert.equal((await parcels.bookParcel(db, s, parcelForm())).matched, false, 'the fourth waits for room');
});

test('delivery needs the recipient code', async () => {
  const d = await driver('Thabo');
  const rider = await passenger('Zanele', { sponsored: 1 });
  await schedule(rider, d, '1', '07:00', null);
  await booking.generateTrips(db, NOW);
  const { parcel } = await parcels.bookParcel(db, await sender(), parcelForm());
  assert.equal((await parcels.deliverParcel(db, parcel.id, d, parcel.code)).error !== undefined, true, 'must be collected first');
  assert.ok(await parcels.collectParcel(db, parcel.id, d));
  assert.match((await parcels.deliverParcel(db, parcel.id, d, '0000')).error, /code/);
  assert.ok((await parcels.deliverParcel(db, parcel.id, d, parcel.code)).ok);
});

test('a parcel moves to another run if its run is cancelled, and is refunded if none is left', async () => {
  const d = await driver('Thabo');
  const a = await passenger('A', { sponsored: 1 });
  const b = await passenger('B', { sponsored: 1 });
  await schedule(a, d, '1', '07:00', null);
  await schedule(b, d, '1', '08:30', null);
  await booking.generateTrips(db, NOW);
  const s = await sender();
  const { parcel } = await parcels.bookParcel(db, s, parcelForm());
  await db.prepare("UPDATE trips SET status = 'cancelled' WHERE id = ?").run(parcel.trip_id);
  await parcels.runParcels(db, NOW);
  const moved = await db.prepare('SELECT * FROM parcels WHERE id = ?').get(parcel.id);
  assert.equal(moved.status, 'booked');
  assert.notEqual(moved.trip_id, parcel.trip_id);
  await db.prepare("UPDATE trips SET status = 'cancelled'").run();
  await parcels.runParcels(db, { date: addDays(MONDAY, 1), time: '06:00' });
  assert.equal((await db.prepare('SELECT status FROM parcels WHERE id = ?').get(parcel.id)).status, 'cancelled');
  assert.equal(await booking.walletBalance(db, s.id), 500, 'refunded');
});

test('drivers see booked trips and parcels in their earnings forecast', async () => {
  const d = await driver('Thabo');
  const rider = await passenger('Zanele', { sponsored: 1 });
  await schedule(rider, d, '1', '07:00', '17:00');
  await booking.generateTrips(db, NOW);
  await parcels.bookParcel(db, await sender(), parcelForm());
  const f = await booking.earningsForecast(db, d, NOW);
  const payouts = (await trips()).reduce((sum, t) => sum + t.driver_payout, 0);
  assert.equal(f.trips, 2);
  assert.equal(f.parcels, 1);
  assert.equal(f.amount, Math.round((payouts + 36) * 100) / 100, 'R45 parcel pays the driver R36');
});
