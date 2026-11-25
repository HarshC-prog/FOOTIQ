'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
  console.error('\nFOOTIQ needs Node.js 22.13 or newer (it uses the built-in node:sqlite module).');
  console.error('You are running Node ' + process.version + '. Download a current LTS from https://nodejs.org\n');
  process.exit(1);
}

const DATA_DIR = process.env.FOOTIQ_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'footiq.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'fan' CHECK (role IN ('fan','operator','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  short TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#19d38b'
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  number INTEGER,
  position TEXT
);

CREATE TABLE IF NOT EXISTS stadiums (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stands (
  id INTEGER PRIMARY KEY,
  stadium_id INTEGER NOT NULL REFERENCES stadiums(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('west','east','north','south')),
  rows INTEGER NOT NULL CHECK (rows BETWEEN 1 AND 26),
  cols INTEGER NOT NULL CHECK (cols BETWEEN 1 AND 30),
  price INTEGER NOT NULL CHECK (price >= 0)
);
CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY,
  stand_id INTEGER NOT NULL REFERENCES stands(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  row_label TEXT NOT NULL,
  num INTEGER NOT NULL,
  UNIQUE (stand_id, label)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  competition TEXT NOT NULL DEFAULT 'ISL',
  home_id INTEGER NOT NULL REFERENCES teams(id),
  away_id INTEGER NOT NULL REFERENCES teams(id),
  stadium_id INTEGER NOT NULL REFERENCES stadiums(id),
  kickoff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','live','completed')),
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  clock_base INTEGER NOT NULL DEFAULT 0,
  clock_ref INTEGER NOT NULL DEFAULT 0,
  clock_running INTEGER NOT NULL DEFAULT 0,
  CHECK (home_id <> away_id)
);
CREATE TABLE IF NOT EXISTS match_stats (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  poss_home INTEGER NOT NULL DEFAULT 50, poss_away INTEGER NOT NULL DEFAULT 50,
  pass_home INTEGER NOT NULL DEFAULT 0,  pass_away INTEGER NOT NULL DEFAULT 0,
  shots_home INTEGER NOT NULL DEFAULT 0, shots_away INTEGER NOT NULL DEFAULT 0,
  sot_home INTEGER NOT NULL DEFAULT 0,   sot_away INTEGER NOT NULL DEFAULT 0,
  corners_home INTEGER NOT NULL DEFAULT 0, corners_away INTEGER NOT NULL DEFAULT 0,
  fouls_home INTEGER NOT NULL DEFAULT 0, fouls_away INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('goal','yellow','red','sub')),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player TEXT,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  checked_in INTEGER NOT NULL DEFAULT 0,
  checked_in_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Seat status lives here. The partial UNIQUE index guarantees one active booking per seat per match,
-- no matter how many users try at once.
CREATE TABLE IF NOT EXISTS booking_seats (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  price INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_seat ON booking_seats (match_id, seat_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_events_match ON events (match_id);
`);

// Additive migration for older local databases.
if (!db.prepare('PRAGMA table_info(events)').all().some((column) => column.name === 'assister')) {
  db.exec('ALTER TABLE events ADD COLUMN assister TEXT');
  db.exec(`UPDATE events SET assister=(
    SELECT p.name FROM players p
    WHERE p.team_id=events.team_id AND p.name<>events.player AND p.position IN ('FW','MF')
    ORDER BY RANDOM() LIMIT 1
  ) WHERE type='goal' AND EXISTS (
    SELECT 1 FROM players p WHERE p.team_id=events.team_id AND p.name<>events.player AND p.position IN ('FW','MF')
  )`);
}

// --- helpers -------------------------------------------------------------
const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pass_hash, 'hex'));
}

function getSecret() {
  let row = q.get("SELECT value FROM meta WHERE key='secret'");
  if (!row) {
    q.run("INSERT INTO meta (key, value) VALUES ('secret', ?)", crypto.randomBytes(32).toString('hex'));
    row = q.get("SELECT value FROM meta WHERE key='secret'");
  }
  return row.value;
}

function generateSeats(standId, rows, cols) {
  const ins = db.prepare('INSERT INTO seats (stand_id, label, row_label, num) VALUES (?,?,?,?)');
  for (let r = 0; r < rows; r++) {
    const letter = String.fromCharCode(65 + r);
    for (let c = 1; c <= cols; c++) ins.run(standId, `${letter}${c}`, letter, c);
  }
}

module.exports = { db, q, tx, hashPassword, checkPassword, getSecret, generateSeats, DB_FILE };
