// One shared connection pool to Postgres (Supabase in production).
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' text (no timezone shifting)
types.setTypeParser(1082, (v) => v);
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL; local Postgres does not.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// Create tables/triggers on startup if missing.
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, migrate };
