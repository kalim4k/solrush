// Neon, reached with the ordinary pg driver.
//
// This process holds a WebSocket for every player, so it is long-lived and a
// plain connection pool is the right shape — Neon's serverless HTTP driver is
// built for functions that start and die per request, and would open a new
// connection per query here.
//
// Point DATABASE_URL at the POOLED host (…-pooler.…). Neon's direct endpoint
// caps connections low enough that a few dozen players exhaust it.

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  /* Verify the certificate. The usual snippet for Postgres-as-a-service is
     `rejectUnauthorized: false`, which turns TLS into encryption with nobody
     on the other end confirmed — anything that can get between this process
     and Neon can read every query and every password hash going past.
     Neon presents a publicly-valid certificate, so there is nothing to work
     around: Node's own CA bundle checks it. */
  ssl: { rejectUnauthorized: true },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Neon puts idle compute to sleep; the first query after that wakes it and can
// take a few seconds. An error here must not take the process down with it —
// a database blip should cost the leaderboard, not everybody's live game.
pool.on('error', (err) => console.error('pg pool error:', err.message));

export const q = (text, params) => pool.query(text, params);

// Single row or null, which is what almost every caller actually wants.
export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

export async function close() {
  await pool.end();
}
