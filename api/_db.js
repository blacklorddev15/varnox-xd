// Dynamic database layer for the VARNOX pairing portal.
// The site always keeps a CONTROL pool on the original DATABASE_URL env DB;
// the ACTIVE database can be switched at runtime from the admin panel by
// storing the desired connection string in the control DB settings row
// (key: active_database_url). No Vercel redeploy needed.
const { Pool } = require('pg');

const PREFIX = 'varnox_';
const CONTROL_URL = String(process.env.DATABASE_URL || '');

function makePool(url) {
  return new Pool({
    connectionString: String(url).split('?')[0],
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    max: 3,
  });
}

const controlPool = CONTROL_URL ? makePool(CONTROL_URL) : null;
const poolCache = new Map(); // activeUrl -> Pool

function poolFor(url) {
  if (!poolCache.has(url)) poolCache.set(url, makePool(url));
  return poolCache.get(url);
}

// Minimal schema to auto-create when switching to an empty database.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${PREFIX}pairing_requests (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pairing_code TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE TABLE IF NOT EXISTS ${PREFIX}sessions (
  id TEXT PRIMARY KEY,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}server_heartbeats (
  server_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}premium_keys (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  used_phone TEXT,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// Seed the three tracked servers. last_seen starts one hour in the past so a
// freshly created table never fakes "online" before a bot has actually pinged.
const SEED_SERVERS_SQL = `
INSERT INTO ${PREFIX}server_heartbeats (server_id, name, last_seen)
  SELECT gs, 'Server ' || gs, now() - interval '1 hour' FROM generate_series(1, 3) gs
  ON CONFLICT (server_id) DO NOTHING;
`;

async function readControl() {
  if (!controlPool) throw new Error('DATABASE_URL is not set on this deployment.');
  return controlPool;
}

// Ensure a database has the portal schema + control row, returns pool.
async function ensureTarget(url) {
  const pool = poolFor(url);
  await pool.query(SCHEMA_SQL);
  await pool.query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ('active_database_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [url]
  );
  // Seed the three tracked servers (1 = panel 1, etc.).
  await pool.query(SEED_SERVERS_SQL);
  return pool;
}

/**
 * Make sure the database the site is ACTUALLY reading has the full schema.
 *
 * ensureTarget() only runs when a database is switched from the admin panel, so a
 * database pointed at any other way (env var, or the settings row written
 * directly) could be missing tables — e.g. varnox_server_heartbeats. When that
 * happened /api/stats returned an EMPTY server list instead of three servers
 * marked offline, and every server tile stayed dead.
 *
 * This runs the same idempotent DDL against the active database, at most once
 * every five minutes, and never throws.
 */
let ensuredAt = 0;
let inFlight = null;

async function ensureActiveSchema(force = false) {
  if (!force && Date.now() - ensuredAt < 5 * 60 * 1000) return false;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const url = await activeUrl();
    const pool = poolFor(url);
    await pool.query(SCHEMA_SQL);
    await pool.query(SEED_SERVERS_SQL);
    ensuredAt = Date.now();
    return true;
  })()
    .catch((e) => {
      console.error('[db] ensureActiveSchema:', e && e.message);
      return false;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// Resolve the ACTIVE database URL (control DB settings row, fallback env).
async function activeUrl() {
  const control = await readControl();
  try {
    const { rows } = await control.query(
      `SELECT value FROM ${PREFIX}settings WHERE key = 'active_database_url'`
    );
    if (rows[0] && rows[0].value) return rows[0].value;
  } catch (e) {
    // control table missing -> try to self-heal on env DB
    try { await ensureTarget(CONTROL_URL); return CONTROL_URL; } catch (_) { /* ignore */ }
  }
  return CONTROL_URL;
}

async function query(text, params) {
  const pool = poolFor(await activeUrl());
  return pool.query(text, params);
}

async function getSetting(key) {
  const { rows } = await query(`SELECT value FROM ${PREFIX}settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

async function switchActiveDatabase(newUrl) {
  if (!/^postgres(ql)?:\/\//i.test(String(newUrl || ''))) {
    throw new Error('Invalid connection string.');
  }
  const url = String(newUrl).trim();
  await ensureTarget(url); // validate + create schema if empty
  const control = await readControl();
  await control.query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ('active_database_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [url]
  );
  return url;
}

module.exports = {
  pool: null,
  controlPool,
  query,
  getSetting,
  setSetting,
  switchActiveDatabase,
  activeUrl,
  ensureTarget,
  ensureActiveSchema,
};
