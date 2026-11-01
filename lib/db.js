// Database setup. SQLite is a single file, so there is nothing to install.
// Later you can move to PostgreSQL (for example AWS RDS) with the same tables.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'parcelhub.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS societies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  hub_address TEXT,
  hold_days INTEGER NOT NULL DEFAULT 7,
  value_limit INTEGER NOT NULL DEFAULT 10000,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('resident', 'staff', 'admin')),
  society_id INTEGER NOT NULL REFERENCES societies(id),
  flat TEXT,
  notify_opt_in INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trusted_persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resident_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parcels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id INTEGER NOT NULL REFERENCES societies(id),
  resident_id INTEGER NOT NULL REFERENCES users(id),
  tracking_id TEXT NOT NULL,
  courier TEXT,
  value INTEGER NOT NULL DEFAULT 0,
  -- open_box = 1 means the live video check is required (open-box or high-value parcel)
  open_box INTEGER NOT NULL DEFAULT 0,
  check_status TEXT NOT NULL DEFAULT 'none'
    CHECK (check_status IN ('none', 'pending', 'approved', 'rejected')),
  video_link TEXT,
  status TEXT NOT NULL DEFAULT 'expected'
    CHECK (status IN ('expected', 'received', 'handed_over', 'refused', 'returned')),
  photo_file TEXT,
  slot_start TEXT,
  slot_end TEXT,
  collector TEXT NOT NULL DEFAULT 'self' CHECK (collector IN ('self', 'trusted')),
  trusted_person_id INTEGER REFERENCES trusted_persons(id) ON DELETE SET NULL,
  handover_code TEXT,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  reminded INTEGER NOT NULL DEFAULT 0,
  unclaimed_reminded INTEGER NOT NULL DEFAULT 0,
  received_at TEXT,
  handed_over_at TEXT,
  handed_over_to TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (society_id, tracking_id)
);
CREATE INDEX IF NOT EXISTS idx_parcels_resident ON parcels (resident_id);
CREATE INDEX IF NOT EXISTS idx_parcels_society_status ON parcels (society_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  society_id INTEGER,
  phone TEXT NOT NULL,
  channel TEXT NOT NULL,
  template TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Audit trail: who did what to which parcel, and when.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parcel_id INTEGER NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
`);

module.exports = db;
