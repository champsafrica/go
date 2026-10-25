import { randomBytes } from 'node:crypto';
import { getSettings, tx } from './db.js';
import { tripFare, driverPayout, subscriptionTripValue, round2, rand } from './pricing.js';
import { notify, notifyAdmins } from './notify.js';
import { nowLocal, addDays, addMonths, weekday, toMinutes, formatDate } from './time.js';

// A driver is busy if another of their trips starts within this many minutes.
export const TRIP_BUFFER_MINUTES = 60;

const ACTIVE_STATUSES = "('scheduled','en_route','arrived','in_progress')";

export function walletBalance(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM wallet_transactions WHERE user_id = ?').get(userId).b;
}

export function activeSubscription(db, passengerId, date) {
  return db.prepare(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.passenger_id = ? AND s.status = 'active' AND s.period_start <= ? AND s.period_end >= ?
    ORDER BY s.period_end DESC LIMIT 1`).get(passengerId, date, date);
}

export function driverRating(db, driverId) {
  const r = db.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM ratings WHERE ratee_id = ?').get(driverId);
  return { avg: r.avg ? Math.round(r.avg * 10) / 10 : null, count: r.n };
}

export function driverCanTake(db, driverId, date, time, excludeTripId = 0) {
  const d = db.prepare("SELECT status FROM drivers WHERE user_id = ?").get(driverId);
  if (!d || d.status !== 'approved') return false;
  const window = db.prepare('SELECT start_time, end_time FROM driver_availability WHERE driver_id = ? AND weekday = ?')
    .get(driverId, weekday(date));
  if (!window || time < window.start_time || time > window.end_time) return false;
  if (db.prepare('SELECT 1 FROM driver_time_off WHERE driver_id = ? AND date = ?').get(driverId, date)) return false;
  const others = db.prepare(`SELECT pickup_time FROM trips WHERE driver_id = ? AND date = ? AND id != ?
    AND status IN ${ACTIVE_STATUSES}`).all(driverId, date, excludeTripId);
  return others.every(o => Math.abs(toMinutes(o.pickup_time) - toMinutes(time)) >= TRIP_BUFFER_MINUTES);
}

// Preferred driver first, then the passenger's approved backups, then the best-rated,
// least-busy approved driver in the passenger's zone, then anyone approved.
export function pickDriver(db, { passengerId, preferredDriverId, date, time, excludeDriverId = 0, tripId = 0 }) {
  const ok = id => id && id !== excludeDriverId && driverCanTake(db, id, date, time, tripId);
  if (ok(preferredDriverId)) return { driverId: preferredDriverId, assignment: 'preferred' };

  const backups = db.prepare('SELECT driver_id FROM backup_drivers WHERE passenger_id = ?').all(passengerId);
  for (const { driver_id } of backups) if (ok(driver_id)) return { driverId: driver_id, assignment: 'backup' };

  const zone = db.prepare('SELECT zone FROM passengers WHERE user_id = ?').get(passengerId)?.zone;
  const pool = db.prepare(`SELECT d.user_id AS id, d.zone,
      (SELECT AVG(stars) FROM ratings WHERE ratee_id = d.user_id) AS rating,
      (SELECT COUNT(*) FROM trips WHERE driver_id = d.user_id AND date = ? AND status IN ${ACTIVE_STATUSES}) AS load
    FROM drivers d WHERE d.status = 'approved'
    ORDER BY (d.zone = ?) DESC, COALESCE(rating, 4) DESC, load ASC, d.user_id ASC`).all(date, zone ?? '');
  for (const d of pool) if (ok(d.id)) return { driverId: d.id, assignment: 'backup' };
  return { driverId: null, assignment: null };
}

function driverSummary(db, driverId) {
  return db.prepare(`SELECT u.name, u.phone, d.vehicle, d.vehicle_reg, d.vehicle_colour FROM drivers d
    JOIN users u ON u.id = d.user_id WHERE d.user_id = ?`).get(driverId);
}

export function describeDriver(db, driverId) {
  const d = driverSummary(db, driverId);
  return d ? `${d.name}, ${d.vehicle_colour ?? ''} ${d.vehicle} (${d.vehicle_reg}), ${d.phone ?? ''}`.replace(/\s+/g, ' ') : 'to be confirmed';
}

// Can this passenger pay for a trip on this date? Sponsored employees, active
// subscriptions and enough wallet balance all count.
export function hasCoverage(db, passengerId, date, fare) {
  const p = db.prepare('SELECT sponsored FROM passengers WHERE user_id = ?').get(passengerId);
  if (p?.sponsored) return true;
  if (activeSubscription(db, passengerId, date)) return true;
  const committed = db.prepare(`SELECT COALESCE(SUM(fare), 0) AS f FROM trips WHERE passenger_id = ?
    AND status IN ('scheduled','unassigned') AND payment_source IS NULL`).get(passengerId).f;
  return walletBalance(db, passengerId) - committed >= fare;
}

function notifyOncePerDay(db, userId, title, body, today) {
  const sent = db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = ? AND date(created_at) = ?")
    .get(userId, title, today);
  if (!sent) notify(db, userId, title, body);
}

export function generateTrips(db, now = nowLocal()) {
  const s = getSettings(db);
  const schedules = db.prepare(`SELECT sc.*, p.home_address, p.work_address, p.distance_km FROM schedules sc
    JOIN passengers p ON p.user_id = sc.passenger_id WHERE sc.active = 1`).all();
  const exists = db.prepare('SELECT 1 FROM trips WHERE schedule_id = ? AND date = ? AND direction = ?');
  const insert = db.prepare(`INSERT INTO trips (passenger_id, schedule_id, driver_id, date, pickup_time, direction,
    origin, destination, distance_km, fare, driver_payout, status, assignment, share_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const created = { trips: 0, unassigned: 0, uncovered: 0 };
  const newTripsByDriver = new Map();

  for (const sc of schedules) {
    const days = sc.weekdays.split(',').map(Number);
    for (let i = 0; i < s.booking_horizon_days; i++) {
      const date = addDays(now.date, i);
      if (!days.includes(weekday(date))) continue;
      const legs = [
        ['to_work', sc.morning_time, sc.home_address, sc.work_address],
        ['to_home', sc.evening_time, sc.work_address, sc.home_address]
      ];
      for (const [direction, time, origin, destination] of legs) {
        if (!time || (date === now.date && time <= now.time)) continue;
        if (exists.get(sc.id, date, direction)) continue;
        const fare = tripFare(sc.distance_km, s);
        if (!hasCoverage(db, sc.passenger_id, date, fare)) {
          created.uncovered++;
          notifyOncePerDay(db, sc.passenger_id, 'Top up to keep your rides booked',
            `We could not book your ${formatDate(date)} ${time} ride because your plan has ended or your ride balance is low. Renew your plan or buy a ride pack in Go Rides.`, now.date);
          continue;
        }
        const pick = pickDriver(db, { passengerId: sc.passenger_id, preferredDriverId: sc.preferred_driver_id, date, time });
        insert.run(sc.passenger_id, sc.id, pick.driverId, date, time, direction, origin, destination, sc.distance_km,
          fare, driverPayout(fare, s), pick.driverId ? 'scheduled' : 'unassigned', pick.assignment, token());
        created.trips++;
        if (pick.driverId) {
          newTripsByDriver.set(pick.driverId, (newTripsByDriver.get(pick.driverId) ?? 0) + 1);
          if (pick.assignment === 'backup' && sc.preferred_driver_id) {
            notify(db, sc.passenger_id, 'Backup driver assigned',
              `Your usual driver is not available on ${formatDate(date)} at ${time}. ${describeDriver(db, pick.driverId)} will collect you.`);
          }
        } else {
          created.unassigned++;
          notifyAdmins(db, 'Trip needs a driver', `No driver available for passenger #${sc.passenger_id} on ${date} at ${time}.`);
        }
      }
    }
  }
  for (const [driverId, n] of newTripsByDriver) {
    notify(db, driverId, 'New trips booked', `${n} new trip${n === 1 ? '' : 's'} added to your schedule. Open Go Rides to see pickups.`);
  }
  return created;
}

// Try again to find drivers for trips nobody could take, e.g. after a new driver is approved.
export function retryUnassigned(db, now = nowLocal()) {
  const trips = db.prepare(`SELECT t.*, sc.preferred_driver_id FROM trips t LEFT JOIN schedules sc ON sc.id = t.schedule_id
    WHERE t.status = 'unassigned' AND (t.date > ? OR (t.date = ? AND t.pickup_time > ?))`).all(now.date, now.date, now.time);
  let fixed = 0;
  for (const t of trips) {
    const pick = pickDriver(db, { passengerId: t.passenger_id, preferredDriverId: t.preferred_driver_id, date: t.date, time: t.pickup_time, tripId: t.id });
    if (!pick.driverId) continue;
    assign(db, t.id, pick.driverId, pick.assignment);
    notify(db, t.passenger_id, 'Driver confirmed', `${describeDriver(db, pick.driverId)} will collect you on ${formatDate(t.date)} at ${t.pickup_time}.`);
    fixed++;
  }
  return fixed;
}

export function assign(db, tripId, driverId, assignment) {
  db.prepare("UPDATE trips SET driver_id = ?, assignment = ?, status = 'scheduled', reminder_sent = 0 WHERE id = ?")
    .run(driverId, assignment, tripId);
  const t = db.prepare('SELECT date, pickup_time, origin FROM trips WHERE id = ?').get(tripId);
  notify(db, driverId, 'Trip assigned', `Pickup ${formatDate(t.date)} at ${t.pickup_time} from ${t.origin}.`);
}

// Move a driver's upcoming trips on a date to backups, e.g. when they book time off.
export function reassignDriverTrips(db, driverId, date, now = nowLocal()) {
  const trips = db.prepare(`SELECT t.*, sc.preferred_driver_id FROM trips t LEFT JOIN schedules sc ON sc.id = t.schedule_id
    WHERE t.driver_id = ? AND t.date = ? AND t.status = 'scheduled' AND (t.date > ? OR t.pickup_time > ?)`)
    .all(driverId, date, now.date, now.time);
  const result = { moved: 0, unassigned: 0 };
  for (const t of trips) {
    const pick = pickDriver(db, { passengerId: t.passenger_id, preferredDriverId: t.preferred_driver_id, date, time: t.pickup_time, excludeDriverId: driverId, tripId: t.id });
    if (pick.driverId) {
      assign(db, t.id, pick.driverId, pick.assignment === 'preferred' ? 'preferred' : 'backup');
      notify(db, t.passenger_id, 'Driver change',
        `Your ${formatDate(date)} ${t.pickup_time} ride is now with ${describeDriver(db, pick.driverId)}.`);
      result.moved++;
    } else {
      db.prepare("UPDATE trips SET driver_id = NULL, assignment = NULL, status = 'unassigned' WHERE id = ?").run(t.id);
      notify(db, t.passenger_id, 'Finding you a driver',
        `Your driver is unavailable on ${formatDate(date)} at ${t.pickup_time}. We are finding a replacement and will confirm shortly.`);
      notifyAdmins(db, 'Trip needs a driver', `Trip #${t.id} on ${date} at ${t.pickup_time} lost its driver and has no backup.`);
      result.unassigned++;
    }
  }
  return result;
}

export function sendReminders(db, now = nowLocal()) {
  const { reminder_minutes } = getSettings(db);
  const trips = db.prepare(`SELECT * FROM trips WHERE date = ? AND status = 'scheduled' AND reminder_sent = 0
    AND driver_id IS NOT NULL`).all(now.date);
  let sent = 0;
  for (const t of trips) {
    const until = toMinutes(t.pickup_time) - toMinutes(now.time);
    if (until < 0 || until > reminder_minutes) continue;
    notify(db, t.passenger_id, `Pickup at ${t.pickup_time}`,
      `${describeDriver(db, t.driver_id)} will collect you from ${t.origin}. Track your ride in Go Rides.`);
    notify(db, t.driver_id, `Pickup at ${t.pickup_time}`, `Collect your passenger at ${t.origin}.`);
    db.prepare('UPDATE trips SET reminder_sent = 1 WHERE id = ?').run(t.id);
    sent++;
  }
  return sent;
}

// Charge a completed trip to the passenger's plan, employer or ride balance and fix the
// driver's payout for it.
export function settleTrip(db, tripId) {
  const s = getSettings(db);
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
    const p = db.prepare('SELECT sponsored FROM passengers WHERE user_id = ?').get(t.passenger_id);
    const sub = activeSubscription(db, t.passenger_id, t.date);
    let source, payout = t.driver_payout;
    if (sub && sub.trips_used < sub.trips_included) {
      source = 'subscription';
      db.prepare('UPDATE subscriptions SET trips_used = trips_used + 1 WHERE id = ?').run(sub.id);
      payout = driverPayout(subscriptionTripValue(sub), s);
    } else if (p?.sponsored) {
      source = 'business';
    } else {
      source = 'wallet';
      db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, trip_id, description) VALUES (?, ?, 'trip', ?, ?)")
        .run(t.passenger_id, -t.fare, t.id, `Ride ${t.date} ${t.pickup_time}`);
    }
    db.prepare("UPDATE trips SET status = 'completed', payment_source = ?, driver_payout = ?, completed_at = datetime('now') WHERE id = ?")
      .run(source, round2(payout), t.id);
    if (source === 'wallet') {
      const balance = walletBalance(db, t.passenger_id);
      if (balance < t.fare * 2) {
        notify(db, t.passenger_id, 'Ride balance running low', `Your balance is ${rand(balance)}. Buy a ride pack to keep your rides booked.`);
      }
    }
    return source;
  });
}

// Close finished plans, create renewals, and remind passengers a few days before renewal.
export function runSubscriptions(db, now = nowLocal(), createPayment) {
  const expired = db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND period_end < ?").all(now.date);
  for (const sub of expired) {
    db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").run(sub.id);
    if (!sub.auto_renew) continue;
    const start = addDays(sub.period_end, 1);
    const { lastInsertRowid } = db.prepare(`INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end, auto_renew)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(sub.passenger_id, sub.plan_id, sub.price, sub.trips_included, start, addDays(addMonths(start, 1), -1));
    createPayment?.({ userId: sub.passenger_id, amount: sub.price, purpose: 'subscription', subscriptionId: lastInsertRowid, item: 'Monthly plan renewal' });
    notify(db, sub.passenger_id, 'Your plan is ready to renew', `Pay ${rand(sub.price)} in Go Rides to keep your rides booked for the next month.`);
  }
  const due = db.prepare(`SELECT * FROM subscriptions WHERE status = 'active' AND renewal_reminded = 0 AND period_end <= ?`)
    .all(addDays(now.date, 3));
  for (const sub of due) {
    notify(db, sub.passenger_id, 'Plan renews soon',
      `Your plan ends on ${formatDate(sub.period_end)}. ${sub.auto_renew ? `It renews for ${rand(sub.price)}.` : 'Renew it to keep your rides booked.'}`);
    db.prepare('UPDATE subscriptions SET renewal_reminded = 1 WHERE id = ?').run(sub.id);
  }
  return { expired: expired.length, reminded: due.length };
}

export function runScheduler(db, now = nowLocal(), createPayment) {
  const subs = runSubscriptions(db, now, createPayment);
  const fixed = retryUnassigned(db, now);
  const created = generateTrips(db, now);
  const reminders = sendReminders(db, now);
  return { ...created, fixed, reminders, ...subs };
}

export function token() {
  return randomBytes(12).toString('base64url');
}
