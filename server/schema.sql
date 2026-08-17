-- SolRush schema for Neon (Postgres 16). Applied by `npm run db:push`,
-- which runs this file whole; every statement is written to be safe to re-run.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

/* ---------- accounts ---------- */
-- Replaces Supabase auth. The password hash is scrypt, produced in auth.js;
-- the column is text because it carries its own parameters and salt inline.
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  pass_hash     text NOT NULL,
  nick          text UNIQUE NOT NULL,
  points        integer NOT NULL DEFAULT 0,
  wins          integer NOT NULL DEFAULT 0,
  losses        integer NOT NULL DEFAULT 0,
  veteran       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS does nothing at all to a table that already
-- exists, so a column added to the block above would never appear on any
-- database that has been run before — which is every deployed one. New columns
-- go here instead, where they are applied on every boot and cost nothing when
-- they are already in place.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plus boolean NOT NULL DEFAULT false;

-- Cosmetics belong on the row, not just on the socket. They started life as
-- something sent at hello and held in memory, which meant a badge existed only
-- while its owner was connected — so the leaderboard, which is a list of people
-- who are mostly offline, could never show one. Storing them also means a
-- player who logs in on a new phone arrives wearing what they paid for.
ALTER TABLE users ADD COLUMN IF NOT EXISTS skin  text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS badge text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pixel text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pack  text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS finish text;

-- The leaderboard reads points DESC and nothing else; without this it is a
-- full scan on every open of the tab.
CREATE INDEX IF NOT EXISTS users_points_idx ON users (points DESC, wins DESC);

-- Case-insensitive nickname uniqueness. The UNIQUE above is case-SENSITIVE, so
-- "Karim" and "karim" would both be taken and the leaderboard shows two people
-- who believe they have the same name.
CREATE UNIQUE INDEX IF NOT EXISTS users_nick_lower_idx ON users (lower(nick));

/* ---------- password reset ---------- */
CREATE TABLE IF NOT EXISTS reset_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS reset_tokens_user_idx ON reset_tokens (user_id);

/* ---------- daily streak ---------- */
-- Kept apart from users because a guest has a streak too, keyed by device.
-- Exactly one of user_id / device_id is set.
CREATE TABLE IF NOT EXISTS streaks (
  id            bigserial PRIMARY KEY,
  user_id       uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  device_id     text UNIQUE,
  days          integer NOT NULL DEFAULT 0,
  best          integer NOT NULL DEFAULT 0,
  last_day      date,
  -- one free restore per calendar month, stored as the month it was spent in
  free_used_month date,
  CONSTRAINT streak_owner CHECK (num_nonnulls(user_id, device_id) = 1)
);

/* ---------- analytics ---------- */
CREATE TABLE IF NOT EXISTS devices (
  id          text PRIMARY KEY,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  -- first touch only: overwriting turns every returning player into "direct"
  src         text,
  lang        text,
  tz          text,
  installed   boolean NOT NULL DEFAULT false,
  visits      integer NOT NULL DEFAULT 0,
  games       integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS devices_src_idx ON devices (src);
CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices (last_seen DESC);

CREATE TABLE IF NOT EXISTS events (
  id       bigserial PRIMARY KEY,
  device   text,
  name     text NOT NULL,
  meta     jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_name_at_idx ON events (name, at DESC);

/* ---------- matches ---------- */
CREATE TABLE IF NOT EXISTS matches (
  id         bigserial PRIMARY KEY,
  mode       text NOT NULL,
  p0_user    uuid REFERENCES users(id) ON DELETE SET NULL,
  p1_user    uuid REFERENCES users(id) ON DELETE SET NULL,
  p0_nick    text NOT NULL,
  p1_nick    text NOT NULL,
  winner     smallint,                       -- 0, 1, or NULL if abandoned
  reason     text,                           -- goal | resign | timeout | disconnect
  moves      integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);
CREATE INDEX IF NOT EXISTS matches_ended_idx ON matches (ended_at DESC);

/* ---------- web push ---------- */
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   text PRIMARY KEY,
  device_id  text,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
