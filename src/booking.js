import { randomBytes } from 'node:crypto';
import { getSettings, tx } from './db.js';
import { tripFare, driverPayout, subscriptionTripValue, round2, rand } from './pricing.js';
import { notify, notifyAdmins } from './notify.js';
import { nowLocal, addDays, addMonths, weekday, toMinutes, formatDate } from './time.js';
import { runParcels } from './parcels.js';
import { effectiveDelay, watchLateness } from './location.js';

// A driver is busy if another of their trips starts within this many minutes.
export const TRIP_BUFFER_MINUTES = 60;

const ACTIVE_STATUSES = "('scheduled','en_route','arrived','in_progress')";

export async function walletBalance(db, userId) {
  return (await db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM wallet_transactions WHERE user_id = ?').get(userId)).b;
}

export async function activeSubscription(db, passengerId, date) {
  return await db.prepare(`SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.passenger_id = ? AND s.status = 'active' AND s.period_start <= ? AND s.period_end >= ?
    ORDER BY s.period_end DESC LIMIT 1`).get(passengerId, date, date);
}

export async function driverRating(db, driverId) {
  const r = await db.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM ratings WHERE ratee_id = ?').get(driverId);
  return { avg: r.avg ? Math.round(r.avg * 10) / 10 : null, count: r.n };
}

// Shared trips can go in one car when they run in the same direction between the same
// home and work areas, with pickups no more than pool_window_minutes apart. A pool is
// null for a solo trip.
export async function tripPool(db, trip, shared = trip.shared) {
  if (!shared) return null;
  const p = await db.prepare('SELECT zone, work_zone FROM passengers WHERE user_id = ?').get(trip.passenger_id);
  return p?.work_zone ? { direction: trip.direction, zone: p.zone, work_zone: p.work_zone } : null;
}

const sameTrip = (o, pool) => o.shared && o.direction === pool.direction && o.zone === pool.zone && o.work_zone === pool.work_zone;

export async function driverCanTake(db, driverId, date, time, excludeTripId = 0, pool = null) {
  const d = await db.prepare("SELECT status, seats FROM drivers WHERE user_id = ?").get(driverId);
  if (!d || d.status !== 'approved') return false;
  const window = await db.prepare('SELECT start_time, end_time FROM driver_availability WHERE driver_id = ? AND weekday = ?')
    .get(driverId, weekday(date));
  if (!window || time < window.start_time || time > window.end_time) return false;
  if (await db.prepare('SELECT 1 FROM driver_time_off WHERE driver_id = ? AND date = ?').get(driverId, date)) return false;
  const near = (await db.prepare(`SELECT t.pickup_time, t.shared, t.direction, p.zone, p.work_zone FROM trips t
    JOIN passengers p ON p.user_id = t.passenger_id
    WHERE t.driver_id = ? AND t.date = ? AND t.id != ? AND t.status IN ${ACTIVE_STATUSES}`).all(driverId, date, excludeTripId))
    .filter(o => Math.abs(toMinutes(o.pickup_time) - toMinutes(time)) < TRIP_BUFFER_MINUTES);
  if (!near.length) return true;
  if (!pool) return false;
  const { pool_window_minutes } = await getSettings(db);
  return near.length < d.seats && near.every(o => sameTrip(o, pool)
    && Math.abs(toMinutes(o.pickup_time) - toMinutes(time)) <= pool_window_minutes);
}

// Preferred driver first. For a shared trip, next try drivers already carrying a
// matching shared car, fullest first, so cars fill up before new ones are used. Then
// the passenger's approved backups, then the best-rated, least-busy approved driver in
// the passenger's area, then anyone approved.
export async function pickDriver(db, { passengerId, preferredDriverId, date, time, excludeDriverId = 0, tripId = 0, pool = null }) {
  const ok = async id => Boolean(id) && id !== excludeDriverId && driverCanTake(db, id, date, time, tripId, pool);
  if (await ok(preferredDriverId)) return { driverId: preferredDriverId, assignment: 'preferred' };

  if (pool) {
    const { pool_window_minutes } = await getSettings(db);
    const cars = await db.prepare(`SELECT t.driver_id, COUNT(*) AS riders FROM trips t JOIN passengers p ON p.user_id = t.passenger_id
      WHERE t.date = ? AND t.direction = ? AND t.shared = 1 AND p.zone = ? AND p.work_zone = ? AND t.driver_id IS NOT NULL
        AND t.id != ? AND t.status IN ${ACTIVE_STATUSES} AND ABS(
          (CAST(substr(t.pickup_time, 1, 2) AS INTEGER) * 60 + CAST(substr(t.pickup_time, 4, 2) AS INTEGER)) - ?) <= ?
      GROUP BY t.driver_id ORDER BY riders DESC, t.driver_id`).all(date, pool.direction, pool.zone, pool.work_zone, tripId, toMinutes(time), pool_window_minutes);
    for (const { driver_id } of cars) if (await ok(driver_id)) return { driverId: driver_id, assignment: 'backup' };
  }

  const backups = await db.prepare('SELECT driver_id FROM backup_drivers WHERE passenger_id = ?').all(passengerId);
  for (const { driver_id } of backups) if (await ok(driver_id)) return { driverId: driver_id, assignment: 'backup' };

  const zone = (await db.prepare('SELECT zone FROM passengers WHERE user_id = ?').get(passengerId))?.zone;
  const pool_ = await db.prepare(`SELECT d.user_id AS id, d.zone,
      (SELECT AVG(stars) FROM ratings WHERE ratee_id = d.user_id) AS rating,
      (SELECT COUNT(*) FROM trips WHERE driver_id = d.user_id AND date = ? AND status IN ${ACTIVE_STATUSES}) AS load
    FROM drivers d WHERE d.status = 'approved'
    ORDER BY (d.zone = ?) DESC, COALESCE(rating, 4) DESC, load ASC, d.user_id ASC`).all(date, zone ?? '');
  for (const d of pool_) if (await ok(d.id)) return { driverId: d.id, assignment: 'backup' };
  return { driverId: null, assignment: null };
}

// Other passengers in the same car as this trip.
export async function carMates(db, trip) {
  if (!trip.shared || !trip.driver_id) return [];
  const pool = await tripPool(db, trip);
  if (!pool) return [];
  const { pool_window_minutes } = await getSettings(db);
  return (await db.prepare(`SELECT t.id, t.pickup_time, t.origin, u.name, p.zone, p.work_zone, t.shared, t.direction FROM trips t
    JOIN passengers p ON p.user_id = t.passenger_id JOIN users u ON u.id = t.passenger_id
    WHERE t.driver_id = ? AND t.date = ? AND t.id != ? AND t.status IN ${ACTIVE_STATUSES} ORDER BY t.pickup_time`)
    .all(trip.driver_id, trip.date, trip.id))
    .filter(o => sameTrip(o, pool) && Math.abs(toMinutes(o.pickup_time) - toMinutes(trip.pickup_time)) <= pool_window_minutes);
}

// Turn ride sharing on or off for a passenger. Upcoming rides are repriced, and any ride
// whose driver can no longer carry it (for example a passenger leaving a shared car) is
// given another driver.
export async function setSharing(db, passengerId, on, now = nowLocal()) {
  const s = await getSettings(db);
  const p = await db.prepare('SELECT * FROM passengers WHERE user_id = ?').get(passengerId);
  const shared = on && p.work_zone ? 1 : 0;
  return tx(db, async db => {
    await db.prepare('UPDATE passengers SET share_rides = ? WHERE user_id = ?').run(shared, passengerId);
    const trips = await db.prepare(`SELECT t.*, sc.preferred_driver_id FROM trips t LEFT JOIN schedules sc ON sc.id = t.schedule_id
      WHERE t.passenger_id = ? AND t.status IN ('scheduled','unassigned') AND (t.date > ? OR (t.date = ? AND t.pickup_time > ?))`)
      .all(passengerId, now.date, now.date, now.time);
    let moved = 0, unassigned = 0;
    const driversLost = new Map(), driversGained = new Map();
    const bump = (m, id) => m.set(id, (m.get(id) ?? 0) + 1);
    for (const t of trips) {
      const fare = tripFare(t.distance_km, s, Boolean(shared));
      await db.prepare('UPDATE trips SET shared = ?, fare = ?, driver_payout = ? WHERE id = ?').run(shared, fare, driverPayout(fare, s), t.id);
      const pool = await tripPool(db, t, shared);
      if (t.driver_id && await driverCanTake(db, t.driver_id, t.date, t.pickup_time, t.id, pool)) continue;
      const pick = await pickDriver(db, { passengerId, preferredDriverId: t.preferred_driver_id, date: t.date, time: t.pickup_time, tripId: t.id, pool });
      if (pick.driverId === t.driver_id) continue;
      if (t.driver_id) bump(driversLost, t.driver_id);
      if (pick.driverId) {
        await db.prepare("UPDATE trips SET driver_id = ?, assignment = ?, status = 'scheduled', reminder_sent = 0 WHERE id = ?").run(pick.driverId, pick.assignment, t.id);
        bump(driversGained, pick.driverId);
        moved++;
      } else {
        await db.prepare("UPDATE trips SET driver_id = NULL, assignment = NULL, status = 'unassigned' WHERE id = ?").run(t.id);
        unassigned++;
      }
    }
    // One message per person rather than one per ride.
    for (const [id, n] of driversLost) await notify(db, id, 'Trips moved', `${n} upcoming pickup${n === 1 ? '' : 's'} moved to another driver after a passenger changed their sharing setting.`);
    for (const [id, n] of driversGained) await notify(db, id, 'New trips booked', `${n} trip${n === 1 ? '' : 's'} added to your schedule. Open Go Rides to see pickups.`);
    if (moved) await notify(db, passengerId, 'Driver change', `${moved} upcoming ride${moved === 1 ? ' has' : 's have'} a new driver. Check your trips for details.`);
    if (unassigned) {
      await notify(db, passengerId, 'Finding you a driver', `${unassigned} upcoming ride${unassigned === 1 ? ' needs' : 's need'} a new driver. We will confirm as soon as one is free.`);
      await notifyAdmins(db, 'Trips need a driver', `${unassigned} trips for passenger #${passengerId} need a driver after a sharing change.`);
    }
    return { shared: Boolean(shared), trips: trips.length, moved, unassigned };
  });
}

async function driverSummary(db, driverId) {
  return await db.prepare(`SELECT u.name, u.phone, d.vehicle, d.vehicle_reg, d.vehicle_colour FROM drivers d
    JOIN users u ON u.id = d.user_id WHERE d.user_id = ?`).get(driverId);
}

export async function describeDriver(db, driverId) {
  const d = await driverSummary(db, driverId);
  return d ? `${d.name}, ${d.vehicle_colour ?? ''} ${d.vehicle} (${d.vehicle_reg}), ${d.phone ?? ''}`.replace(/\s+/g, ' ') : 'to be confirmed';
}

// Can this passenger pay for a trip on this date? Sponsored employees, active
// subscriptions and enough wallet balance all count.
export async function hasCoverage(db, passengerId, date, fare) {
  const p = await db.prepare('SELECT sponsored FROM passengers WHERE user_id = ?').get(passengerId);
  if (p?.sponsored) return true;
  if (await activeSubscription(db, passengerId, date)) return true;
  const committed = (await db.prepare(`SELECT COALESCE(SUM(fare), 0) AS f FROM trips WHERE passenger_id = ?
    AND status IN ('scheduled','unassigned') AND payment_source IS NULL`).get(passengerId)).f;
  return (await walletBalance(db, passengerId)) - committed >= fare;
}

async function notifyOncePerDay(db, userId, title, body, today) {
  const sent = await db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title = ? AND date(created_at) = ?")
    .get(userId, title, today);
  if (!sent) await notify(db, userId, title, body);
}

export async function generateTrips(db, now = nowLocal()) {
  const s = await getSettings(db);
  const schedules = await db.prepare(`SELECT sc.*, p.home_address, p.work_address, p.distance_km, p.zone, p.work_zone,
      (p.share_rides = 1 AND p.work_zone IS NOT NULL) AS shared FROM schedules sc
    JOIN passengers p ON p.user_id = sc.passenger_id WHERE sc.active = 1`).all();
  const exists = db.prepare('SELECT 1 FROM trips WHERE schedule_id = ? AND date = ? AND direction = ?');
  const insert = db.prepare(`INSERT INTO trips (passenger_id, schedule_id, driver_id, date, pickup_time, direction,
    origin, destination, distance_km, fare, driver_payout, shared, status, assignment, share_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
        if (await exists.get(sc.id, date, direction)) continue;
        const fare = tripFare(sc.distance_km, s, Boolean(sc.shared));
        if (!await hasCoverage(db, sc.passenger_id, date, fare)) {
          created.uncovered++;
          await notifyOncePerDay(db, sc.passenger_id, 'Top up to keep your rides booked',
            `We could not book your ${formatDate(date)} ${time} ride because your plan has ended or your ride balance is low. Renew your plan or buy a ride pack in Go Rides.`, now.date);
          continue;
        }
        const pool = sc.shared ? { direction, zone: sc.zone, work_zone: sc.work_zone } : null;
        const pick = await pickDriver(db, { passengerId: sc.passenger_id, preferredDriverId: sc.preferred_driver_id, date, time, pool });
        await insert.run(sc.passenger_id, sc.id, pick.driverId, date, time, direction, origin, destination, sc.distance_km,
          fare, driverPayout(fare, s), sc.shared ? 1 : 0, pick.driverId ? 'scheduled' : 'unassigned', pick.assignment, token());
        created.trips++;
        if (pick.driverId) {
          newTripsByDriver.set(pick.driverId, (newTripsByDriver.get(pick.driverId) ?? 0) + 1);
          if (pick.assignment === 'backup' && sc.preferred_driver_id) {
            await notify(db, sc.passenger_id, 'Backup driver assigned',
              `Your usual driver is not available on ${formatDate(date)} at ${time}. ${await describeDriver(db, pick.driverId)} will collect you.`);
          }
        } else {
          created.unassigned++;
          await notifyAdmins(db, 'Trip needs a driver', `No driver available for passenger #${sc.passenger_id} on ${date} at ${time}.`);
        }
      }
    }
  }
  for (const [driverId, n] of newTripsByDriver) {
    await notify(db, driverId, 'New trips booked', `${n} new trip${n === 1 ? '' : 's'} added to your schedule. Open Go Rides to see pickups.`);
  }
  return created;
}

// Try again to find drivers for trips nobody could take, e.g. after a new driver is approved.
export async function retryUnassigned(db, now = nowLocal()) {
  const trips = await db.prepare(`SELECT t.*, sc.preferred_driver_id FROM trips t LEFT JOIN schedules sc ON sc.id = t.schedule_id
    WHERE t.status = 'unassigned' AND (t.date > ? OR (t.date = ? AND t.pickup_time > ?))`).all(now.date, now.date, now.time);
  let fixed = 0;
  for (const t of trips) {
    const pick = await pickDriver(db, { passengerId: t.passenger_id, preferredDriverId: t.preferred_driver_id, date: t.date, time: t.pickup_time, tripId: t.id, pool: await tripPool(db, t) });
    if (!pick.driverId) continue;
    await assign(db, t.id, pick.driverId, pick.assignment);
    await notify(db, t.passenger_id, 'Driver confirmed', `${await describeDriver(db, pick.driverId)} will collect you on ${formatDate(t.date)} at ${t.pickup_time}.`);
    fixed++;
  }
  return fixed;
}

export async function assign(db, tripId, driverId, assignment) {
  await db.prepare("UPDATE trips SET driver_id = ?, assignment = ?, status = 'scheduled', reminder_sent = 0 WHERE id = ?")
    .run(driverId, assignment, tripId);
  const t = await db.prepare('SELECT date, pickup_time, origin FROM trips WHERE id = ?').get(tripId);
  await notify(db, driverId, 'Trip assigned', `Pickup ${formatDate(t.date)} at ${t.pickup_time} from ${t.origin}.`);
}

// Move a driver's upcoming trips on a date to backups, e.g. when they book time off.
export async function reassignDriverTrips(db, driverId, date, now = nowLocal()) {
  const trips = await db.prepare(`SELECT t.*, sc.preferred_driver_id FROM trips t LEFT JOIN schedules sc ON sc.id = t.schedule_id
    WHERE t.driver_id = ? AND t.date = ? AND t.status = 'scheduled' AND (t.date > ? OR t.pickup_time > ?)`)
    .all(driverId, date, now.date, now.time);
  const result = { moved: 0, unassigned: 0 };
  for (const t of trips) {
    const pick = await pickDriver(db, { passengerId: t.passenger_id, preferredDriverId: t.preferred_driver_id, date, time: t.pickup_time, excludeDriverId: driverId, tripId: t.id, pool: await tripPool(db, t) });
    if (pick.driverId) {
      await assign(db, t.id, pick.driverId, pick.assignment === 'preferred' ? 'preferred' : 'backup');
      await notify(db, t.passenger_id, 'Driver change',
        `Your ${formatDate(date)} ${t.pickup_time} ride is now with ${await describeDriver(db, pick.driverId)}.`);
      result.moved++;
    } else {
      await db.prepare("UPDATE trips SET driver_id = NULL, assignment = NULL, status = 'unassigned' WHERE id = ?").run(t.id);
      await notify(db, t.passenger_id, 'Finding you a driver',
        `Your driver is unavailable on ${formatDate(date)} at ${t.pickup_time}. We are finding a replacement and will confirm shortly.`);
      await notifyAdmins(db, 'Trip needs a driver', `Trip #${t.id} on ${date} at ${t.pickup_time} lost its driver and has no backup.`);
      result.unassigned++;
    }
  }
  return result;
}

export async function sendReminders(db, now = nowLocal()) {
  const { reminder_minutes } = await getSettings(db);
  const trips = await db.prepare(`SELECT * FROM trips WHERE date = ? AND status = 'scheduled' AND reminder_sent = 0
    AND driver_id IS NOT NULL`).all(now.date);
  let sent = 0;
  for (const t of trips) {
    const until = toMinutes(t.pickup_time) - toMinutes(now.time);
    if (until < 0 || until > reminder_minutes) continue;
    await notify(db, t.passenger_id, `Pickup at ${t.pickup_time}`,
      `${await describeDriver(db, t.driver_id)} will collect you from ${t.origin}. Track your ride in Go Rides.`);
    await notify(db, t.driver_id, `Pickup at ${t.pickup_time}`, `Collect your passenger at ${t.origin}.`);
    await db.prepare('UPDATE trips SET reminder_sent = 1 WHERE id = ?').run(t.id);
    sent++;
  }
  return sent;
}

// Charge a completed trip to the passenger's plan, employer or ride balance and fix the
// driver's payout for it.
export async function settleTrip(db, tripId) {
  const s = await getSettings(db);
  return tx(db, async db => {
    const t = await db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
    const p = await db.prepare('SELECT sponsored FROM passengers WHERE user_id = ?').get(t.passenger_id);
    const sub = await activeSubscription(db, t.passenger_id, t.date);
    let source, payout = t.driver_payout;
    if (sub && sub.trips_used < sub.trips_included) {
      source = 'subscription';
      await db.prepare('UPDATE subscriptions SET trips_used = trips_used + 1 WHERE id = ?').run(sub.id);
      payout = driverPayout(subscriptionTripValue(sub), s);
    } else if (p?.sponsored) {
      source = 'business';
    } else {
      source = 'wallet';
      await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, trip_id, description) VALUES (?, ?, 'trip', ?, ?)")
        .run(t.passenger_id, -t.fare, t.id, `Ride ${t.date} ${t.pickup_time}`);
    }
    await db.prepare("UPDATE trips SET status = 'completed', payment_source = ?, driver_payout = ?, completed_at = datetime('now') WHERE id = ?")
      .run(source, round2(payout), t.id);
    // On-time Promise: a late pickup is credited back. Lateness is measured from the
    // driver's arrival (live location or their arrival tap), and never counts as less than
    // the delay they reported. Go Rides carries the cost; the driver is still paid.
    // Employers are simply not charged for the trip.
    const late = effectiveDelay(t);
    if (late >= s.promise_minutes) {
      const value = round2(source === 'subscription' ? subscriptionTripValue(sub) : t.fare);
      await db.prepare('UPDATE trips SET promise_credit = ? WHERE id = ?').run(value, t.id);
      if (source === 'business') {
        await notify(db, t.passenger_id, 'On-time Promise', `Your driver was ${late} minutes late, so your employer is not charged for this ride.`);
      } else {
        await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, trip_id, description) VALUES (?, ?, 'refund', ?, ?)")
          .run(t.passenger_id, value, t.id, `On-time Promise: ${late} min late on ${t.date}`);
        await notify(db, t.passenger_id, 'On-time Promise', `Your driver was ${late} minutes late. We have added ${rand(value)} ride credit to your balance.`);
      }
    }
    if (source === 'wallet') {
      const balance = await walletBalance(db, t.passenger_id);
      if (balance < t.fare * 2) {
        await notify(db, t.passenger_id, 'Ride balance running low', `Your balance is ${rand(balance)}. Buy a ride pack to keep your rides booked.`);
      }
    }
    return source;
  });
}

// On-time Promise, part two: a booked ride that never got a driver is cancelled once its
// pickup time passes, and the passenger gets the fare as ride credit.
export async function creditMissedTrips(db, now = nowLocal()) {
  const missed = await db.prepare(`SELECT * FROM trips WHERE status = 'unassigned' AND (date < ? OR (date = ? AND pickup_time < ?))`)
    .all(now.date, now.date, now.time);
  for (const t of missed) {
    await tx(db, async db => {
      await db.prepare("UPDATE trips SET status = 'cancelled', promise_credit = fare WHERE id = ?").run(t.id);
      await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, trip_id, description) VALUES (?, ?, 'refund', ?, ?)")
        .run(t.passenger_id, t.fare, t.id, `On-time Promise: no driver on ${t.date} ${t.pickup_time}`);
      await notify(db, t.passenger_id, 'We are sorry',
        `We could not find a driver for your ${formatDate(t.date)} ${t.pickup_time} ride. Under our On-time Promise, ${rand(t.fare)} has been added to your ride balance.`);
    });
  }
  return missed.length;
}

// What a driver has booked for the coming days: trips and parcels already on their schedule.
export async function earningsForecast(db, driverId, now = nowLocal(), days = 7) {
  const end = addDays(now.date, days - 1);
  const trips = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(driver_payout), 0) AS amount FROM trips
    WHERE driver_id = ? AND status = 'scheduled' AND date BETWEEN ? AND ?`).get(driverId, now.date, end);
  const parcels = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(pa.driver_payout), 0) AS amount FROM parcels pa
    JOIN trips t ON t.id = pa.trip_id WHERE t.driver_id = ? AND pa.status = 'booked' AND pa.date BETWEEN ? AND ?`).get(driverId, now.date, end);
  return { trips: trips.n, parcels: parcels.n, amount: round2(trips.amount + parcels.amount) };
}

// Close finished plans, create renewals, and remind passengers a few days before renewal.
export async function runSubscriptions(db, now = nowLocal(), createPayment) {
  const expired = await db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND period_end < ?").all(now.date);
  for (const sub of expired) {
    await db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").run(sub.id);
    if (!sub.auto_renew) continue;
    const start = addDays(sub.period_end, 1);
    const { lastInsertRowid } = await db.prepare(`INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end, auto_renew)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(sub.passenger_id, sub.plan_id, sub.price, sub.trips_included, start, addDays(addMonths(start, 1), -1));
    await createPayment?.({ userId: sub.passenger_id, amount: sub.price, purpose: 'subscription', subscriptionId: lastInsertRowid, item: 'Monthly plan renewal' });
    await notify(db, sub.passenger_id, 'Your plan is ready to renew', `Pay ${rand(sub.price)} in Go Rides to keep your rides booked for the next month.`);
  }
  const due = await db.prepare(`SELECT * FROM subscriptions WHERE status = 'active' AND renewal_reminded = 0 AND period_end <= ?`)
    .all(addDays(now.date, 3));
  for (const sub of due) {
    await notify(db, sub.passenger_id, 'Plan renews soon',
      `Your plan ends on ${formatDate(sub.period_end)}. ${sub.auto_renew ? `It renews for ${rand(sub.price)}.` : 'Renew it to keep your rides booked.'}`);
    await db.prepare('UPDATE subscriptions SET renewal_reminded = 1 WHERE id = ?').run(sub.id);
  }
  return { expired: expired.length, reminded: due.length };
}

export async function runScheduler(db, now = nowLocal(), createPayment) {
  const subs = await runSubscriptions(db, now, createPayment);
  const fixed = await retryUnassigned(db, now);
  const missed = await creditMissedTrips(db, now);
  const created = await generateTrips(db, now);
  const reminders = await sendReminders(db, now);
  const parcels = await runParcels(db, now);
  const lateWarnings = await watchLateness(db);
  return { ...created, fixed, missed, reminders, ...subs, parcels, lateWarnings };
}

export function token() {
  return randomBytes(12).toString('base64url');
}
