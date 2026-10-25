import { getSettings } from './db.js';
import { notify, notifyAdmins } from './notify.js';
import { nowLocal, formatDate } from './time.js';

// Live location for the On-time Promise. Pickup addresses are not geocoded, so Go Rides
// learns each passenger's pickup point: from where the driver stood when they arrived, or
// from a pin the passenger sets on their phone. With a known point, the driver's live
// location marks the arrival automatically and lateness is measured, not self-reported.

export const ARRIVAL_RADIUS_M = 150;      // within this distance the driver has arrived
export const ARRIVAL_TAP_LIMIT_M = 500;   // an "I have arrived" tap from further away is refused
export const FRESH_LOCATION_MS = 2 * 60 * 1000;

export function distanceM(a, b) {
  const R = 6371e3, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// South Africa has one time zone (UTC+2) and no daylight saving.
export const pickupInstant = t => Date.parse(`${t.date}T${t.pickup_time}:00+02:00`);

// Whole minutes between the booked pickup time and the actual arrival.
export function measuredLateness(trip) {
  if (!trip.arrived_at) return 0;
  return Math.max(0, Math.floor((Date.parse(trip.arrived_at) - pickupInstant(trip)) / 60000));
}

// The lateness the On-time Promise uses: measured when we have it, never less than what
// the driver reported.
export const effectiveDelay = trip => Math.max(trip.delay_minutes ?? 0, measuredLateness(trip));

const side = trip => (trip.direction === 'to_work' ? 'home' : 'work');

export async function pickupPoint(db, trip) {
  const p = await db.prepare('SELECT home_lat, home_lng, work_lat, work_lng FROM passengers WHERE user_id = ?').get(trip.passenger_id);
  const s = side(trip);
  return p && p[`${s}_lat`] != null ? { lat: p[`${s}_lat`], lng: p[`${s}_lng`] } : null;
}

export async function setPickupPoint(db, passengerId, which, lat, lng) {
  if (!['home', 'work'].includes(which)) throw new Error('which must be home or work');
  await db.prepare(`UPDATE passengers SET ${which}_lat = ?, ${which}_lng = ? WHERE user_id = ?`).run(lat, lng, passengerId);
}

async function driverFix(db, driverId, at) {
  const d = await db.prepare('SELECT lat, lng, location_at FROM drivers WHERE user_id = ?').get(driverId);
  if (!d || d.lat == null || !d.location_at) return null;
  const age = at.getTime() - Date.parse(`${d.location_at.replace(' ', 'T')}Z`);
  return age >= 0 && age <= FRESH_LOCATION_MS ? { lat: d.lat, lng: d.lng } : null;
}

// Checks an "I have arrived" tap. Refused only when both the pickup point and a fresh
// driver location are known and they are far apart; otherwise it is accepted, and the
// pickup point is learned from the driver's position if we did not know it yet.
export async function verifyArrivalTap(db, trip, at = new Date()) {
  const fix = await driverFix(db, trip.driver_id, at);
  const point = await pickupPoint(db, trip);
  if (fix && point) {
    const d = distanceM(fix, point);
    if (d > ARRIVAL_TAP_LIMIT_M) return { ok: false, distance: d };
  }
  if (fix && !point) await setPickupPoint(db, trip.passenger_id, side(trip), fix.lat, fix.lng);
  return { ok: true };
}

export async function markArrived(db, trip, at = new Date(), automatic = false) {
  await db.prepare("UPDATE trips SET status = 'arrived', arrived_at = ? WHERE id = ?").run(at.toISOString(), trip.id);
  const late = measuredLateness({ ...trip, arrived_at: at.toISOString() });
  const driver = await db.prepare('SELECT name FROM users WHERE id = ?').get(trip.driver_id);
  await notify(db, trip.passenger_id, 'Your driver has arrived',
    `${driver?.name ?? 'Your driver'} is at your pickup point${automatic ? ' (confirmed by live location)' : ''}.${late ? ` ${late} min after your booked time.` : ''}`);
  return late;
}

// Called on every location update from a driver: arrival within ARRIVAL_RADIUS_M of a known
// pickup point is recorded automatically. Returns the trips marked arrived.
export async function checkArrival(db, driverId, lat, lng, at = new Date(), now = nowLocal(at)) {
  const trips = await db.prepare("SELECT * FROM trips WHERE driver_id = ? AND date = ? AND status = 'en_route'").all(driverId, now.date);
  const arrived = [];
  for (const t of trips) {
    const point = await pickupPoint(db, t);
    if (point && distanceM({ lat, lng }, point) <= ARRIVAL_RADIUS_M) {
      await markArrived(db, t, at, true);
      arrived.push(t.id);
    }
  }
  return arrived;
}

// Part of the booking run: warns passengers once when their driver is past the promise
// limit and has not arrived, telling them the ride is covered; tells admins when a driver
// has not even set off.
export async function watchLateness(db, at = new Date(), now = nowLocal(at)) {
  const { promise_minutes } = await getSettings(db);
  const trips = await db.prepare(`SELECT t.*, u.name AS driver_name FROM trips t LEFT JOIN users u ON u.id = t.driver_id
    WHERE t.date = ? AND t.status IN ('scheduled','en_route') AND t.late_notified = 0 AND t.driver_id IS NOT NULL`).all(now.date);
  let warned = 0;
  for (const t of trips) {
    const lateBy = Math.floor((at.getTime() - pickupInstant(t)) / 60000);
    if (lateBy < promise_minutes) continue;
    await db.prepare('UPDATE trips SET late_notified = 1 WHERE id = ?').run(t.id);
    await notify(db, t.passenger_id, 'Your driver is running late',
      `${t.driver_name} has not reached you yet for your ${t.pickup_time} pickup. This ride is covered by the On-time Promise: you will get ride credit once it is done.`);
    if (t.status === 'scheduled') {
      await notifyAdmins(db, 'Driver has not set off', `Trip #${t.id} (${formatDate(t.date)} ${t.pickup_time}) is ${lateBy} min past pickup and ${t.driver_name} has not started it.`);
    }
    warned++;
  }
  return warned;
}
