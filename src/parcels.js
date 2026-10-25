import { randomInt } from 'node:crypto';
import { getSettings, tx } from './db.js';
import { driverPayout, rand } from './pricing.js';
import { notify, notifyAdmins, sendDirect } from './notify.js';
import { walletBalance, token } from './booking.js';
import { nowLocal, formatDate } from './time.js';

// Go Parcels: packages ride along on drivers' scheduled commuter runs. A parcel from
// Soweto to Sandton travels on a morning run that carries a Soweto passenger to work in
// Sandton (or an evening run the other way), so it costs little and arrives the same day.

export const SIZES = {
  small: 'Small: fits on a lap (documents, a phone, a small box)',
  medium: 'Medium: fits on a seat (a shoe box to a backpack)',
  large: 'Large: fits in the boot (up to a suitcase)'
};

const LIVE = "('booked','collected')";

export function parcelPrice(size, s) {
  return s[`parcel_${size}`];
}

// Finds a scheduled run on the parcel's date and route whose driver has room for it.
export async function matchParcel(db, parcel) {
  const { parcel_capacity } = await getSettings(db);
  const runs = await db.prepare(`SELECT t.id, t.driver_id, t.pickup_time FROM trips t JOIN passengers p ON p.user_id = t.passenger_id
    WHERE t.date = ? AND t.status = 'scheduled' AND t.driver_id IS NOT NULL AND (
      (t.direction = 'to_work' AND p.zone = ? AND p.work_zone = ?) OR (t.direction = 'to_home' AND p.work_zone = ? AND p.zone = ?))
    ORDER BY t.pickup_time`).all(parcel.date, parcel.from_zone, parcel.to_zone, parcel.from_zone, parcel.to_zone);
  for (const run of runs) {
    const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM parcels pa JOIN trips t ON t.id = pa.trip_id
      WHERE t.driver_id = ? AND pa.date = ? AND pa.status IN ${LIVE} AND pa.id != ?`).get(run.driver_id, parcel.date, parcel.id);
    if (n >= parcel_capacity) continue;
    await db.prepare("UPDATE parcels SET trip_id = ?, status = 'booked' WHERE id = ?").run(run.id, parcel.id);
    return run;
  }
  return null;
}

export async function bookParcel(db, sender, form, now = nowLocal()) {
  const s = await getSettings(db);
  const price = parcelPrice(form.size, s);
  const business = sender.role === 'business';
  return tx(db, async db => {
    if (!business && await walletBalance(db, sender.id) < price) {
      return { error: `Sending this parcel costs ${rand(price)}. Top up your ride balance first.` };
    }
    const { lastInsertRowid: id } = await db.prepare(`INSERT INTO parcels (sender_id, business_id, date, from_zone, to_zone, pickup_address,
      dropoff_address, recipient_name, recipient_phone, size, description, price, driver_payout, payment_source, code, token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sender.id, business ? sender.business_id : null, form.date,
      form.from_zone, form.to_zone, form.pickup_address, form.dropoff_address, form.recipient_name, form.recipient_phone, form.size,
      form.description || null, price, driverPayout(price, s), business ? 'business' : 'wallet', String(randomInt(1000, 10000)), token());
    if (!business) {
      await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, 'trip', ?)")
        .run(sender.id, -price, `Go Parcel #${id} to ${form.to_zone}`);
    }
    const parcel = await db.prepare('SELECT * FROM parcels WHERE id = ?').get(id);
    const run = await matchParcel(db, parcel);
    if (run) await notify(db, run.driver_id, 'Parcel added to your run', `${form.size} parcel on ${formatDate(form.date)}: collect at ${form.pickup_address}.`);
    else await notifyAdmins(db, 'Parcel waiting for a run', `Parcel #${id} from ${form.from_zone} to ${form.to_zone} on ${form.date} has no matching run yet.`);
    return { parcel: await db.prepare('SELECT * FROM parcels WHERE id = ?').get(id), matched: Boolean(run) };
  });
}

// Tells the recipient their delivery code once the parcel is on a run.
export async function sendRecipientCode(parcel, siteUrl) {
  sendDirect(parcel.recipient_phone, `Go Rides: a parcel is on its way to you on ${formatDate(parcel.date)}. Give the driver code ${parcel.code} when it arrives. Track it: ${siteUrl}/p/${parcel.token}`);
}

async function refund(db, parcel, reason) {
  await db.prepare("UPDATE parcels SET status = 'cancelled', trip_id = NULL WHERE id = ?").run(parcel.id);
  if (parcel.payment_source === 'wallet') {
    await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description) VALUES (?, ?, 'refund', ?)")
      .run(parcel.sender_id, parcel.price, `Go Parcel #${parcel.id} refund: ${reason}`);
  }
}

export async function cancelParcel(db, parcelId, senderId) {
  return tx(db, async db => {
    const p = await db.prepare("SELECT * FROM parcels WHERE id = ? AND sender_id = ? AND status IN ('unmatched','booked')").get(parcelId, senderId);
    if (!p) return false;
    await refund(db, p, 'cancelled by sender');
    return true;
  });
}

// Part of the booking run: parcels whose run was cancelled or lost its driver look for
// another run, and parcels still unmatched once their day has passed are refunded.
export async function runParcels(db, now = nowLocal()) {
  await db.prepare(`UPDATE parcels SET status = 'unmatched', trip_id = NULL WHERE status = 'booked' AND trip_id IN
    (SELECT id FROM trips WHERE status IN ('cancelled','no_show','unassigned') OR driver_id IS NULL)`).run();
  const open = await db.prepare("SELECT * FROM parcels WHERE status = 'unmatched'").all();
  let matched = 0, refunded = 0;
  for (const p of open) {
    if (p.date < now.date) {
      await tx(db, async db => refund(db, p, 'no run available'));
      await notify(db, p.sender_id, 'Parcel not sent', `We could not find a run for your parcel to ${p.recipient_name} on ${formatDate(p.date)}. ${p.payment_source === 'wallet' ? `${rand(p.price)} is back in your ride balance.` : 'Your company will not be charged.'}`);
      refunded++;
      continue;
    }
    const run = await matchParcel(db, p);
    if (run) {
      matched++;
      await notify(db, run.driver_id, 'Parcel added to your run', `${p.size} parcel on ${formatDate(p.date)}: collect at ${p.pickup_address}.`);
      await notify(db, p.sender_id, 'Parcel booked', `Your parcel to ${p.recipient_name} is booked on a ${formatDate(p.date)} run.`);
    }
  }
  return { matched, refunded };
}

export async function collectParcel(db, parcelId, driverId) {
  const p = await db.prepare(`SELECT pa.* FROM parcels pa JOIN trips t ON t.id = pa.trip_id
    WHERE pa.id = ? AND t.driver_id = ? AND pa.status = 'booked'`).get(parcelId, driverId);
  if (!p) return false;
  await db.prepare("UPDATE parcels SET status = 'collected' WHERE id = ?").run(p.id);
  await notify(db, p.sender_id, 'Parcel collected', `Your parcel to ${p.recipient_name} has been collected and is on its way.`);
  return true;
}

// Delivery needs the recipient's code, so a parcel cannot be marked delivered without
// reaching them.
export async function deliverParcel(db, parcelId, driverId, code) {
  const p = await db.prepare(`SELECT pa.* FROM parcels pa JOIN trips t ON t.id = pa.trip_id
    WHERE pa.id = ? AND t.driver_id = ? AND pa.status = 'collected'`).get(parcelId, driverId);
  if (!p) return { error: 'This parcel cannot be delivered now.' };
  if (String(code ?? '').trim() !== p.code) return { error: 'That code does not match. Ask the recipient for the 4-digit code we sent them.' };
  await db.prepare("UPDATE parcels SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(p.id);
  await notify(db, p.sender_id, 'Parcel delivered', `Your parcel was delivered to ${p.recipient_name}.`);
  return { ok: true };
}

// Parcels on a driver's runs, with the run each one rides on.
export function driverParcels(db, driverId, fromDate, toDate) {
  return db.prepare(`SELECT pa.*, t.pickup_time, t.direction, u.name AS sender_name FROM parcels pa
    JOIN trips t ON t.id = pa.trip_id JOIN users u ON u.id = pa.sender_id
    WHERE t.driver_id = ? AND pa.date BETWEEN ? AND ? AND pa.status IN ('booked','collected','delivered')
    ORDER BY pa.date, t.pickup_time`).all(driverId, fromDate, toDate);
}
