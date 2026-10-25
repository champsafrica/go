// Fills an empty database with demo accounts and a couple of weeks of activity so every
// dashboard has something to show. Run with: npm run seed
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');

const { openDb, getSettings, tx } = await import('./db.js');
const { hashPassword } = await import('./auth.js');
const { runScheduler, token } = await import('./booking.js');
const { tripFare, driverPayout, planPrice } = await import('./pricing.js');
const { nowLocal, addDays, addMonths, weekday } = await import('./time.js');

export const DEMO_PASSWORD = 'gorides123';

export function seed(db) {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return false;
  const s = getSettings(db);
  const today = nowLocal().date;
  const pw = hashPassword(DEMO_PASSWORD);
  const user = (role, name, email, phone, businessId = null) => Number(db.prepare(
    'INSERT INTO users (role, name, email, phone, password_hash, business_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(role, name, email, phone, pw, businessId).lastInsertRowid);

  tx(db, () => {
    user('admin', 'Go Rides Operations', 'admin@gorides.test', '0110000000');

    const drivers = [
      ['Thabo Mokoena', 'thabo@gorides.test', '0721110001', 'Soweto', 'Toyota Corolla Quest', 'HJ 23 KL GP', 'White', 'approved'],
      ['Lindiwe Dube', 'lindiwe@gorides.test', '0721110002', 'Sandton', 'Suzuki Ertiga', 'BX 88 TT GP', 'Silver', 'approved'],
      ['Sipho Ndlovu', 'sipho@gorides.test', '0721110003', 'Soweto', 'VW Polo Vivo', 'KM 45 PL GP', 'Grey', 'approved'],
      ['Ayanda Khumalo', 'ayanda@gorides.test', '0721110004', 'Tembisa', 'Toyota Avanza', 'CF 12 RS GP', 'Blue', 'pending']
    ].map(([name, email, phone, zone, vehicle, reg, colour, status], i) => {
      const id = user('driver', name, email, phone);
      db.prepare(`INSERT INTO drivers (user_id, zone, vehicle, vehicle_reg, vehicle_colour, seats, id_number, licence_no, prdp_no, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, zone, vehicle, reg, colour, vehicle.includes('Ertiga') || vehicle.includes('Avanza') ? 6 : 4,
        `85010${i}5800083`, `L00${i}2345`, status === 'pending' ? null : `PD${i}7789`, status);
      for (let d = 1; d <= 5; d++) db.prepare("INSERT INTO driver_availability VALUES (?, ?, '05:00', '19:30')").run(id, d);
      return id;
    });
    const [thabo, lindiwe, sipho] = drivers;

    const businessId = Number(db.prepare("INSERT INTO businesses (name, billing_email) VALUES ('Ubuntu Logistics', 'accounts@ubuntu.test')").run().lastInsertRowid);
    user('business', 'Nomsa Zulu', 'hr@ubuntu.test', '0119990000', businessId);

    const passengers = [
      ['Zanele Mthembu', 'zanele@gorides.test', '0831230001', '12 Vilakazi St, Orlando West, Soweto', '1 Sandton Dr, Sandton', 'Soweto', 24, thabo, null],
      ['Kagiso Molefe', 'kagiso@gorides.test', '0831230002', '45 Rabie St, Randburg', 'Rosebank Mall, Rosebank', 'Randburg', 11, lindiwe, null],
      ['Precious Nkosi', 'precious@gorides.test', '0831230003', '8 Chris Hani Rd, Dobsonville, Soweto', '20 Anderson St, Johannesburg CBD', 'Soweto', 18, sipho, businessId]
    ].map(([name, email, phone, home, work, zone, km, driver, biz]) => {
      const id = user('passenger', name, email, phone, biz);
      db.prepare(`INSERT INTO passengers (user_id, home_address, work_address, zone, distance_km, emergency_name, emergency_phone, sponsored)
        VALUES (?, ?, ?, ?, ?, 'Family contact', '0820000000', ?)`).run(id, home, work, zone, km, biz ? 1 : 0);
      const schedule = Number(db.prepare("INSERT INTO schedules (passenger_id, weekdays, morning_time, evening_time, preferred_driver_id) VALUES (?, '1,2,3,4,5', ?, ?, ?)")
        .run(id, driver === thabo ? '06:30' : '07:00', driver === thabo ? '17:00' : '17:30', driver).lastInsertRowid);
      return { id, km, driver, schedule, home, work };
    });
    const [zanele, kagiso] = passengers;
    db.prepare('INSERT INTO backup_drivers VALUES (?, ?)').run(zanele.id, sipho);

    // Zanele: Daily Commuter plan, paid. Kagiso: prepaid ride balance.
    const plan = db.prepare("SELECT * FROM plans WHERE name = 'Daily Commuter'").get();
    const start = addDays(today, -14);
    const price = planPrice(plan, zanele.km, s);
    const subId = db.prepare("INSERT INTO subscriptions (passenger_id, plan_id, price, trips_included, period_start, period_end, status) VALUES (?, ?, ?, ?, ?, ?, 'active')")
      .run(zanele.id, plan.id, price, plan.trips_per_month, start, addDays(addMonths(start, 1), -1)).lastInsertRowid;
    db.prepare("INSERT INTO payments (user_id, amount, purpose, subscription_id, item, provider, status, paid_at) VALUES (?, ?, 'subscription', ?, 'Daily Commuter plan', 'simulated', 'paid', ?)")
      .run(zanele.id, price, subId, `${start} 08:00:00`);
    const pack = Math.round(tripFare(kagiso.km, s) * 40 * 0.92);
    db.prepare("INSERT INTO payments (user_id, amount, purpose, item, provider, status, paid_at) VALUES (?, ?, 'topup', '40-ride pack', 'simulated', 'paid', ?)").run(kagiso.id, pack, `${start} 09:00:00`);
    db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, description, created_at) VALUES (?, ?, 'topup', '40-ride pack', ?)").run(kagiso.id, pack, `${start} 09:00:00`);

    // Two weeks of completed history.
    const comments = ['Always on time, thank you!', 'Friendly and safe driver.', 'Clean car.', null, null];
    let n = 0;
    for (let i = 14; i >= 1; i--) {
      const date = addDays(today, -i);
      if (weekday(date) > 5) continue;
      for (const p of passengers) {
        for (const [dir, time, from, to] of [['to_work', '07:00', p.home, p.work], ['to_home', '17:30', p.work, p.home]]) {
          const fare = tripFare(p.km, s);
          const source = p === zanele ? 'subscription' : p === kagiso ? 'wallet' : 'business';
          const value = source === 'subscription' ? price / plan.trips_per_month : fare;
          const delay = n % 9 === 4 ? 10 : 0;
          const tripId = Number(db.prepare(`INSERT INTO trips (passenger_id, schedule_id, driver_id, date, pickup_time, direction, origin, destination,
            distance_km, fare, driver_payout, status, assignment, payment_source, delay_minutes, share_token, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'preferred', ?, ?, ?, ?)`)
            .run(p.id, p.schedule, p.driver, date, time, dir, from, to, p.km, fare, driverPayout(value, s), source, delay, token(), `${date} ${time}:00`).lastInsertRowid);
          if (source === 'subscription') db.prepare('UPDATE subscriptions SET trips_used = trips_used + 1 WHERE id = ?').run(subId);
          if (source === 'wallet') db.prepare("INSERT INTO wallet_transactions (user_id, amount, type, trip_id, description, created_at) VALUES (?, ?, 'trip', ?, ?, ?)")
            .run(p.id, -fare, tripId, `Ride ${date} ${time}`, `${date} 18:00:00`);
          if (n % 3 === 0) db.prepare('INSERT INTO ratings (trip_id, rater_id, ratee_id, stars, comment) VALUES (?, ?, ?, ?, ?)')
            .run(tripId, p.id, p.driver, n % 7 === 0 ? 4 : 5, comments[n % comments.length]);
          n++;
        }
      }
    }
    db.prepare("INSERT INTO complaints (user_id, trip_id, category, message) VALUES (?, (SELECT MAX(id) FROM trips WHERE passenger_id = ?), 'Late pickup', 'Driver was 10 minutes late and did not let me know.')")
      .run(kagiso.id, kagiso.id);
  });

  runScheduler(db);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  console.log(seed(db)
    ? `Demo data added. Log in with any of these (password "${DEMO_PASSWORD}"):
  admin@gorides.test      operations
  zanele@gorides.test     passenger on a monthly plan
  kagiso@gorides.test     passenger with prepaid rides
  precious@gorides.test   employee paid for by Ubuntu Logistics
  thabo@gorides.test      driver
  hr@ubuntu.test          employer`
    : 'The database already has users. Delete it to reseed.');
}
