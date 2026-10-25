import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('passenger','driver','admin','business')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT 'whatsapp,email',
  business_id INTEGER REFERENCES businesses(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passengers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  home_address TEXT NOT NULL,
  work_address TEXT NOT NULL,
  zone TEXT NOT NULL,
  work_zone TEXT,
  distance_km REAL NOT NULL,
  share_rides INTEGER NOT NULL DEFAULT 0,
  emergency_name TEXT,
  emergency_phone TEXT,
  sponsored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS drivers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  zone TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  vehicle_reg TEXT NOT NULL,
  vehicle_colour TEXT,
  seats INTEGER NOT NULL DEFAULT 4,
  id_number TEXT NOT NULL,
  licence_no TEXT NOT NULL,
  prdp_no TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended')),
  verification_notes TEXT,
  lat REAL, lng REAL, location_at TEXT
);

-- One availability window per weekday (1 = Monday ... 7 = Sunday).
CREATE TABLE IF NOT EXISTS driver_availability (
  driver_id INTEGER NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  PRIMARY KEY (driver_id, weekday)
);

CREATE TABLE IF NOT EXISTS driver_time_off (
  driver_id INTEGER NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (driver_id, date)
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  passenger_id INTEGER NOT NULL REFERENCES passengers(user_id) ON DELETE CASCADE,
  weekdays TEXT NOT NULL,
  morning_time TEXT,
  evening_time TEXT,
  preferred_driver_id INTEGER REFERENCES drivers(user_id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backup_drivers (
  passenger_id INTEGER NOT NULL REFERENCES passengers(user_id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  PRIMARY KEY (passenger_id, driver_id)
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  passenger_id INTEGER NOT NULL REFERENCES passengers(user_id) ON DELETE CASCADE,
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  driver_id INTEGER REFERENCES drivers(user_id),
  date TEXT NOT NULL,
  pickup_time TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('to_work','to_home')),
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  distance_km REAL NOT NULL,
  fare REAL NOT NULL,
  driver_payout REAL NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','unassigned','en_route','arrived','in_progress','completed','cancelled','no_show')),
  assignment TEXT CHECK (assignment IN ('preferred','backup','manual')),
  payment_source TEXT CHECK (payment_source IN ('subscription','wallet','business')),
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  share_token TEXT NOT NULL UNIQUE,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, date, direction)
);
CREATE INDEX IF NOT EXISTS trips_driver_date ON trips (driver_id, date);
CREATE INDEX IF NOT EXISTS trips_passenger_date ON trips (passenger_id, date);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  trips_per_month INTEGER NOT NULL,
  discount_pct REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  passenger_id INTEGER NOT NULL REFERENCES passengers(user_id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  price REAL NOT NULL,
  trips_included INTEGER NOT NULL,
  trips_used INTEGER NOT NULL DEFAULT 0,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','cancelled','expired')),
  auto_renew INTEGER NOT NULL DEFAULT 1,
  renewal_reminded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topup','trip','refund','adjustment')),
  trip_id INTEGER REFERENCES trips(id),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('subscription','topup')),
  subscription_id INTEGER REFERENCES subscriptions(id),
  item TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  rater_id INTEGER NOT NULL REFERENCES users(id),
  ratee_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, rater_id)
);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  trip_id INTEGER REFERENCES trips(id),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER REFERENCES trips(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL, lng REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deliveries TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  billing_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  base_fare: '10',          // Rand per trip
  per_km: '2.20',           // Rand per km
  min_fare: '25',           // Rand
  commission_pct: '20',     // platform share of each fare
  reminder_minutes: '30',   // pickup reminder lead time
  booking_horizon_days: '7', // how far ahead recurring trips are booked
  shared_discount_pct: '30',  // discount for passengers who share their rides
  pool_window_minutes: '20'   // shared pickups in one car are at most this far apart
};

// Columns added after the first release. openDb adds any that an older database lacks.
const MIGRATIONS = [
  ['passengers', 'work_zone', 'TEXT'],
  ['passengers', 'share_rides', 'INTEGER NOT NULL DEFAULT 0'],
  ['trips', 'shared', 'INTEGER NOT NULL DEFAULT 0']
];

export const DEFAULT_PLANS = [
  ['Daily Commuter', 'Monday to Friday, to work and back. Best value.', 44, 15],
  ['Part-time', 'Three days a week, return trips.', 26, 10],
  ['Flexi', 'Two return trips a week, or one-way every weekday.', 18, 5]
];

export function openDb(path = process.env.DATABASE_PATH || './data/go-rides.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const [table, column, type] of MIGRATIONS) {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  const setting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setting.run(k, v);
  if (!db.prepare('SELECT 1 FROM plans LIMIT 1').get()) {
    const plan = db.prepare('INSERT INTO plans (name, description, trips_per_month, discount_pct) VALUES (?, ?, ?, ?)');
    for (const p of DEFAULT_PLANS) plan.run(...p);
  }
  return db;
}

export function getSettings(db) {
  const out = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) out[key] = Number(value);
  return out;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
