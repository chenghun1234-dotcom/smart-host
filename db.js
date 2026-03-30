const { Pool } = require('pg');

let pool = null;

function readDatabaseUrl() {
  return (process.env.DATABASE_URL ?? '').toString().trim();
}

function shouldUseSsl(databaseUrl) {
  const url = (databaseUrl ?? '').toString();
  if (!url) return false;
  if (url.includes('sslmode=require')) return true;
  if (url.includes('neon.tech')) return true;
  return false;
}

function getPool() {
  if (pool) return pool;

  const databaseUrl = readDatabaseUrl();
  if (!databaseUrl) return null;

  const ssl = shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : undefined;
  pool = new Pool({ connectionString: databaseUrl, ssl });
  return pool;
}

function isEnabled() {
  return getPool() != null;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL_NOT_SET');
  return p.query(text, params);
}

module.exports = { isEnabled, query };

