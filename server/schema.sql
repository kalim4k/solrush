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

-- Replays. The row already recorded that a game happened and how it ended; it
-- did not record the game. move_log is the ordered list of moves as the engine
-- accepted them, which together with `mode` is enough to rebuild every
-- position — the board is a pure function of its moves, so storing positions
-- would be storing the same thing many times over.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS move_log jsonb;

-- The share link. Random and unguessable rather than the row id: /r/7 invites
-- anybody to read /r/6, and a replay carries both players' nicknames.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS token text;
CREATE UNIQUE INDEX IF NOT EXISTS matches_token_idx ON matches (token);

-- "My games", read as "this user's finished matches, newest first". Without
-- these it is a full scan of every match ever played, on every open.
CREATE INDEX IF NOT EXISTS matches_p0_idx ON matches (p0_user, ended_at DESC);
CREATE INDEX IF NOT EXISTS matches_p1_idx ON matches (p1_user, ended_at DESC);

/* ---------- payments ---------- */
-- One row per attempt to buy Plus.
--
-- This table exists because Maketou has no webhooks: nothing will ever call us
-- to say a payment landed. The redirect back from the checkout page is the only
-- notification there is, and it is lost whenever somebody closes the tab or
-- switches to their mobile-money app and does not come back. Writing the cart
-- id down at creation is what makes the answer recoverable afterwards — the
-- player's next connection asks Maketou about anything still open.
--
-- Without it, a payment whose redirect went missing would be money taken for
-- nothing, discoverable only by the person who paid.
CREATE TABLE IF NOT EXISTS plus_carts (
  cart_id    text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'waiting_payment',
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz
);
-- "anything this player left unfinished", which is the question asked on every
-- reconnection, so it must not be a scan of every attempt ever made.
CREATE INDEX IF NOT EXISTS plus_carts_open_idx
  ON plus_carts (user_id) WHERE status = 'waiting_payment';

-- What was actually charged, in FCFA, written down at the moment the cart was
-- created.
--
-- Revenue used to be computed as "number of paid carts × today's price", which
-- is only correct while the price has never changed — and the first thing that
-- happens to a price is that it changes. It also silently reported nothing at
-- all whenever MAKETOU_PRICE was unset, which is the arrangement we are moving
-- towards. A sum of amounts recorded per sale survives both.
--
-- NULL on every row written before this column existed; the admin panel counts
-- those separately rather than pretending they were free.
ALTER TABLE plus_carts ADD COLUMN IF NOT EXISTS amount integer;

-- The revenue query reads completed carts by date and nothing else.
CREATE INDEX IF NOT EXISTS plus_carts_paid_idx
  ON plus_carts (created_at DESC) WHERE status = 'completed';

/* ---------- web push ---------- */
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   text PRIMARY KEY,
  device_id  text,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
