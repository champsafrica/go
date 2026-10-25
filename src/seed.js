// Fills an empty database with demo accounts and a couple of weeks of activity so every
// dashboard has something to show. Run with: npm run seed. On Vercel without a Turso
// database, the server also runs it to fill the temporary demo database.
import './env.js';
import { openDb, getSettings, tx } from './db.js';
import { hashPassword } from './auth.js';
import { runScheduler, token } from './booking.js';
import { bookParcel } from './parcels.js';
import { tripFare, driverPayout, planPrice } from './pricing.js';
import { nowLocal, addDays, addMonths, weekday } from './time.js';

export const DEMO_PASSWORD = 'gorides123';

export async function seed(db) {
  if (await db.prepare('SELECT 1 FROM users LIMIT 1').get()) return false;
  const s = await getSettings(db);
  const today = nowLocal().date;
  const pw = hashPassword(DEMO_PASSWORD);
  let hr;

  await tx(db, async db => {
    const user = async (role, name, email, phone, businessId = null) => (await db.prepare(
      'INSERT INTO users (role, name, email, phone, password_hash, business_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(role, name, email, phone, pw, businessId)).lastInsertRowid;

    await user('admin', 'Go Rides Operations', 'admin@gorides.test', '0110000000');

    const drivers = [];
    for (const [i, [name, email, phone, zone, vehicle, reg, colour, status]] of [
      ['Thabo Mokoena', 'thabo@gorides.test', '0721110001', 'Soweto', 'Toyota Corolla Quest', 'HJ 23 KL GP', 'White', 'approved'],
      ['Lindiwe Dube', 'lindiwe@gorides.test', '0721110002', 'Sandton', 'Suzuki Ertiga', 'BX 88 TT GP', 'Silver', 'approved'],
      ['Sipho Ndlovu', 'sipho@gorides.test', '0721110003', 'Soweto', 'VW Polo Vivo', 'KM 45 PL GP', 'Grey', 'approved'],
      ['Ayanda Khumalo', 'ayanda@gorides.test', '0721110004', 'Tembisa', 'Toyota Avanza', 'CF 12 RS GP', 'Blue', 'pending']
    ].entries()) {
      const id = await user('driver', name, email, phone);
      await db.prepare(`INSERT INTO drivers (user_id, zone, vehicle, vehicle_reg, vehicle_colour, seats, id_number, licence_no, prdp_no, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, zone, vehicle, reg, colour, vehicle.includes('Ertiga') || vehicle.includes('Avanza') ? 6 : 4,
        `85010${i}5800083`, `L00${i}2345`, status === 'pending' ? null : `PD${i}7789`, status);
      for (let d = 1; d <= 5; d++) await db.prepare("INSERT INTO driver_availability VALUES (?, ?, '05:00', '19:30')").run(id, d);
      drivers.push(id);
    }
    const [thabo, lindiwe, sipho] = drivers;

    const businessId = (await db.prepare("INSERT INTO businesses (name, billing_email) VALUES ('Ubuntu Logistics', 'accounts@ubuntu.test')").run()).lastInsertRowid;
    hr = { id: await user('business', 'Nomsa Zulu', 'hr@ubuntu.test', '0119990000', businessId), role: 'business', business_id: businessId };

    const passengers = [];
    for (const [name, email, phone, home, work, zone, workZone, km, driver, biz, share, morning, evening] of [
      // name, email, phone, home, work, home area, work area, km, driver, employer, shares, morning, evening
      ['Zanele Mthembu', 'zanele@gorides.test', '0831230001', '12 Vilakazi St, Orlando West, Soweto', '1 Sandton Dr, Sandton', 'Soweto', 'Sandton', 24, thabo, null, 1, '06:30', '17:00'],
      ['Kagiso Molefe', 'kagiso@gorides.test', '0831230002', '45 Rabie St, Randburg', 'Rosebank Mall, Rosebank', 'Randburg', 'Sandton', 11, lindiwe, null, 0, '07:00', '17:30'],
      ['Precious Nkosi', 'precious@gorides.test', '0831230003', '8 Chris Hani Rd, Dobsonville, Soweto', '20 Anderson St, Johannesburg CBD', 'Soweto', 'Johannesburg CBD', 18, sipho, businessId, 0, '07:00', '17:30'],
      ['Bongani Sithole', 'bongani@gorides.test', '0831230004', '30 Klipspruit Valley Rd, Orlando East, Soweto', '5 Rivonia Rd, Sandton', 'Soweto', 'Sandton', 23, thabo, null, 1, '06:40', '17:10']
    ]) {
      const id = await user('passenger', name, email, phone, biz);
      await db.prepare(`INSERT INTO passengers (user_id, home_address, work_address, zone, work_zone, distance_km, share_rides, emergency_name, emergency_phone, sponsored)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Family contact', '0820000000', ?)`).run(id, home, work, zone, workZone, km, share, biz ? 1 : 0);
      const schedule = (await db.prepare("INSERT INTO schedules (passenger_id, weekdays, morning_time, evening_time, preferred_driver_id) VALUES (?, '1,2,3,4,5', ?, ?, ?)")
        .run(id, morning, evening, driver)).lastInsertRowid;
      passengers.push({ id, km, driver, schedule, home, work, share, morning, evening });
    }
    const [zanele, kagiso, , bongani] = passengers;
    await db.prepare('INSERT INTO backup_drivers VALUES (?, ?)').run(zanele.id, sipho);

    // Zanele: Daily Commuter plan, paid. Kagiso: prepaid ride balance.
    const plan = await db.prepare("SELECT * FROM plans WHERE name = 'Daily Commuter'").get();
    const start = addDays(today, -14);
    const price = planPrice(plan, zanele.km, s, true);
    const subId = (await db.prepare("INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end, status) VALUES (?, ?, ?, ?, ?, ?, 'active')")
      .run(zanele.id, plan.id, price, plan.trips_per_month, start, addDays(addMonths(start, 1), -1))).lastInsertRowid;
    await db.prepare("INSERT INTO payments (user_id, amount, purpose, subscription_id, item, provider, status, paid_at) VALUES (?, ?, 'subscription', ?, 'Daily Commuter plan', 'simulated', 'paid', ?)")
      .run(zanele.id, price, subId, `${start} 08:00:00`);
    const pack = Math.round(tripFare(kagiso.km, s) * 40 * 0.92);
    await db.prepare("INSERT INTO payments (user_id, amount, purpose, item, provider, status, paid_at) VALUES (?, ?, 'topup', '40-ride pack', 'simulated', 'paid', ?)").run(kagiso.id, pack, `${start} 09:00:00`);
    await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, 'topup', '40-ride pack', ?)").run(kagiso.id, pack, `${start} 09:00:00`);
    const sharedPack = Math.round(tripFare(bongani.km, s, true) * 40 * 0.92);
    await db.prepare("INSERT INTO payments (user_id, amount, purpose, item, provider, status, paid_at) VALUES (?, ?, 'topup', '40-ride pack', 'simulated', 'paid', ?)").run(bongani.id, sharedPack, `${start} 09:30:00`);
    await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, 'topup', '40-ride pack', ?)").run(bongani.id, sharedPack, `${start} 09:30:00`);

    // Two weeks of completed history.
    const comments = ['Always on time, thank you!', 'Friendly and safe driver.', 'Clean car.', null, null];
    let n = 0;
    for (let i = 14; i >= 1; i--) {
      const date = addDays(today, -i);
      if (weekday(date) > 5) continue;
      for (const p of passengers) {
        for (const [dir, time, from, to] of [['to_work', p.morning, p.home, p.work], ['to_home', p.evening, p.work, p.home]]) {
          const fare = tripFare(p.km, s, Boolean(p.share));
          const source = p === zanele ? 'subscription' : p === kagiso || p === bongani ? 'wallet' : 'business';
          const value = source === 'subscription' ? price / plan.trips_per_month : fare;
          const delay = n % 9 === 4 ? 6 : 0;
          const tripId = (await db.prepare(`INSERT INTO trips (passenger_id, schedule_id, driver_id, date, pickup_time, direction, origin, destination,
            distance_km, fare, driver_payout, shared, status, assignment, payment_source, delay_minutes, share_token, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'preferred', ?, ?, ?, ?)`)
            .run(p.id, p.schedule, p.driver, date, time, dir, from, to, p.km, fare, driverPayout(value, s), p.share, source, delay, token(), `${date} ${time}:00`)).lastInsertRowid;
          if (source === 'subscription') await db.prepare('UPDATE subscriptions SET trips_used = trips_used + 1 WHERE id = ?').run(subId);
          if (source === 'wallet') await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, trip_id, description, created_at) VALUES (?, ?, 'trip', ?, ?, ?)")
            .run(p.id, -fare, tripId, `Ride ${date} ${time}`, `${date} 18:00:00`);
          if (n % 3 === 0) await db.prepare('INSERT INTO ratings (trip_id, rater_id, ratee_id, stars, comment) VALUES (?, ?, ?, ?, ?)')
            .run(tripId, p.id, p.driver, n % 7 === 0 ? 4 : 5, comments[n % comments.length]);
          n++;
        }
      }
    }
    // One late pickup credited under the On-time Promise.
    const late = await db.prepare("SELECT * FROM trips WHERE passenger_id = ? ORDER BY date DESC, pickup_time DESC LIMIT 1").get(kagiso.id);
    await db.prepare('UPDATE trips SET delay_minutes = 14, promise_credit = fare WHERE id = ?').run(late.id);
    await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, trip_id, description, created_at) VALUES (?, ?, 'refund', ?, ?, ?)")
      .run(kagiso.id, late.fare, late.id, `On-time Promise: 14 min late on ${late.date}`, `${late.date} 18:05:00`);
    // A parcel delivered last week on Thabo's morning run.
    const run = await db.prepare("SELECT * FROM trips WHERE passenger_id = ? AND direction = 'to_work' ORDER BY date DESC LIMIT 1").get(zanele.id);
    await db.prepare(`INSERT INTO parcels (sender_id, trip_id, date, from_zone, to_zone, pickup_address, dropoff_address, recipient_name,
      recipient_phone, size, description, price, driver_payout, payment_source, status, code, token, delivered_at)
      VALUES (?, ?, ?, 'Soweto', 'Sandton', '14 Vilakazi St, Orlando West', '3 Rivonia Rd, Sandton', 'Lerato Mokoena', '0830000099',
      'small', 'Signed contract', ?, ?, 'wallet', 'delivered', '4821', ?, ?)`)
      .run(kagiso.id, run.id, run.date, s.parcel_small, driverPayout(s.parcel_small, s), token(), `${run.date} 07:40:00`);
    await db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, 'trip', 'Go Parcel to Sandton', ?)")
      .run(kagiso.id, -s.parcel_small, `${run.date} 06:00:00`);
    await db.prepare("INSERT INTO complaints (user_id, trip_id, category, message) VALUES (?, (SELECT MAX(id) FROM trips WHERE passenger_id = ?), 'Late pickup', 'Driver was 10 minutes late and did not let me know.')")
      .run(kagiso.id, kagiso.id);
  });

  await runScheduler(db);

  // Upcoming parcels on the next weekday's runs.
  let day = addDays(today, 1);
  while (weekday(day) > 5) day = addDays(day, 1);
  const kagisoUser = await db.prepare("SELECT * FROM users WHERE email = 'kagiso@gorides.test'").get();
  await bookParcel(db, kagisoUser, { date: day, from_zone: 'Soweto', to_zone: 'Sandton', pickup_address: '22 Vilakazi St, Orlando West',
    dropoff_address: '1 Sandton Dr, Sandton', recipient_name: 'Thandi Nkosi', recipient_phone: '0830000088', size: 'medium', description: 'Birthday gift' });
  await bookParcel(db, hr, { date: day, from_zone: 'Sandton', to_zone: 'Soweto', pickup_address: 'Ubuntu Logistics, 5 Rivonia Rd',
    dropoff_address: '30 Klipspruit Valley Rd, Orlando East', recipient_name: 'Sizwe Dlamini', recipient_phone: '0830000077', size: 'small', description: 'Staff access cards' });
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  await db.ready;
  console.log(await seed(db)
    ? `Demo data added. Log in with any of these (password "${DEMO_PASSWORD}"):
  admin@gorides.test      operations
  zanele@gorides.test     passenger on a monthly plan, sharing rides
  kagiso@gorides.test     passenger with prepaid rides
  bongani@gorides.test    passenger sharing Thabo's car with Zanele
  precious@gorides.test   employee paid for by Ubuntu Logistics
  thabo@gorides.test      driver
  hr@ubuntu.test          employer`
    : 'The database already has users. Delete it to reseed.');
}
