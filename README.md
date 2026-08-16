# SolRush

A 1v1 Quoridor-style strategy game: race your pawn to the far side of the board,
or spend a wall to make your opponent's route longer. Plays against an AI
offline, or against a real opponent over a WebSocket.

## Layout

```
public/            everything the browser gets
  index.html       the shell — 141 elements filled in by JS at boot
  css/style.css    2 915 lines, no external fonts or images
  js/app.js        screens, board, gestures, online play
  js/engine.js     the rules. Imported by the browser AND by the server
  js/ai.js         the opponent: alpha-beta over a distance heuristic
  js/ai-worker.js  runs ai.js off the main thread
  js/account.js    login/register against /api — replaces Supabase
  js/i18n.js       language detection and pack loading
  js/ranks.js      the points ladder
  js/streak.js     flame tiers and milestones (display only)
  js/nick.js       nickname rules, also shared with the server
  js/portal.js     CrazyGames SDK; inert outside their frame
  lang/en.js       the reference pack
  lang/fr.js       français
  sw.js            offline shell + push notifications
server/
  index.js         HTTP, static files, REST, WebSocket upgrade
  boot-env.js      loads .env — must stay the first import of index.js
  game.js          rooms, matchmaking, clocks — the authority on the board
  credentials.js   scrypt hashing, HS256 tokens — no I/O, unit-tested
  auth.js          the half of accounts that touches Postgres
  db.js            Neon connection pool
  streak.js        the daily streak
  schema.sql       tables, applied by `npm run db:push`
test/              56 tests
scripts/
  make-icons.mjs   rebuilds public/icons from solrush.png
  shot.mjs         screenshots the running game at a real device size
  prune-css.mjs    deletes stylesheet rules for markup that no longer exists
  ws-smoke.mjs     socket-level smoke test
  db-smoke.mjs     full-stack test against the real database
solrush.png        the master icon artwork (1254px). Edit this, then re-run
                   make-icons.mjs — never hand-edit anything in public/icons.
```

`engine.js` living under `public/` and being imported by the server is
deliberate. The server re-runs every move through the same code the client used
to draw it, so the two can never disagree about what is legal.

## Running it

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and JWT_SECRET
npm run db:push           # creates the tables in Neon
npm start                 # http://localhost:3000
```

### Getting DATABASE_URL

In the Neon console, create a project and copy the **pooled** connection string —
the host ends in `-pooler`. The direct endpoint caps connections low enough that
a few dozen simultaneous players exhaust it, and this process holds a socket per
player.

### Getting JWT_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Changing it later logs everybody out; it is not otherwise sensitive to its value.

## Tests

```bash
npm test                       # 82 tests, no database needed
npm run smoke -- 3000          # sockets only, against a running server
npm run smoke:db -- 3000       # the whole stack, against the REAL database
npm run smoke:warm             # a RETURNING browser, needs the server + Chrome
npm run smoke:lang             # clicks through all six languages in a browser
npm run smoke:voice            # two browsers, one friend room, a real WebRTC call
```

`smoke` needs the server up but not the database: a guest can play a whole game
without one, and the streak lookup degrades rather than fails.

`smoke:db` is the end-to-end proof — it registers two accounts, plays a ranked
game to a finish over WebSocket, then reads the rows back out of Postgres to
confirm the points, the win/loss, the match record and the streak all landed.
It deletes everything it created afterwards, so it is safe against a live
database, but it does write to one: run it against a branch if that matters.

`smoke:warm` is the one that catches a whole class of bug the others cannot.
Every other check — and every screenshot in `scripts/shot.mjs` — runs in a fresh
browser profile: no service worker, no HTTP cache, every request straight to the
network. That is a first-time visitor, and a first-time visitor is the only kind
who cannot show a staleness bug. Two shipped that way: a stylesheet that put the
bottom nav off the bottom of the screen, and a language pack with no legal
documents in it. Both were invisible to the full suite and obvious to anyone who
had opened the game once before.

So it visits twice in the same profile, edits two files in between with no
version bump, and asserts the second visit sees the new bytes — then checks the
nav is actually on screen and the four legal documents actually have text in
them. Set `SHOT_PROFILE=<dir>` to make `shot.mjs` reuse a profile the same way.

`smoke:lang` clicks every entry in the language picker and reads the page back —
the home screen, a dialog and one of the legal documents — then reloads to check
the choice was remembered. It exists because the switcher shipped broken in a
way no unit test could see: `LANGS` offered six languages, `AVAILABLE` listed
two, and `loadLang()` returned English for the rest. Every key existed, every
pack that existed was complete, and clicking Español did nothing whatsoever.

`smoke:voice` opens two headless browsers with a fake microphone, has one create
a friend room and the other join by code, and puts them in a real call — then
checks the audio stream arrived, the microphone starts closed, and opening it
shows up on the other screen. It finishes with two more browsers on quick match
and asserts they are never offered the button at all. It found two bugs the unit
tests could not: strangers being offered voice (see below), and the two clients
answering each other's "I joined" notice in an infinite loop.

Four of those tests are guards rather than unit tests, and are the ones worth
knowing about:

- **every id app.js reaches for exists in index.html** — app.js writes to
  elements without checking, so a renamed id is a blank page, not an error.
- **every i18n key used exists, in every pack** — a missing key renders its own
  name into a button.
- **no third-party tag or foreign credential survives** — the audit removed an
  ad network, an analytics token and a rewarded-video API key belonging to the
  original author. This stops one reappearing in a later copy-paste.
- **the page carries real text for a crawler** — everything else is written by
  JS into empty elements.

## Icons

`solrush.png` is the master. Everything under `public/icons/` is generated:

```bash
node scripts/make-icons.mjs
```

Two shapes come out of it and they are not the same picture. The **any** icons
are the badge cropped to fill the frame — the browser adds no rounding, so
shipping the artwork with its margin still on gives a small icon floating in a
dark square. The **maskable** icon keeps the margin and lets the background run
to all four edges, because the platform crops it to its own shape and only
guarantees the middle 80%. Swap them and Android rounds an already-rounded badge
and shaves its corners.

`icons/icon.svg` is a flat redraw of the same mark, not a trace of the render: a
3D image stops being legible somewhere around 40px, and the favicon is 16.
`.logo-mark` in the stylesheet is that same mark again in CSS. All three carry
the artwork's sampled colours, so changing the master means changing all three.

## Screenshots

```bash
node scripts/shot.mjs http://localhost:3000/ 390 844 out.png
node scripts/shot.mjs http://localhost:3000/ 390 844 board.png btn-ai,ai-normal
```

Use this rather than `chrome --screenshot`. Chrome's `--window-size` does **not**
set the layout viewport in headless: ask for 390 and the page is laid out at
526, wide enough to clear a mobile breakpoint, then cropped to 390 — so a
perfectly responsive layout appears to overflow. This script sets the viewport
over the DevTools protocol, which works, and prints the real numbers so a wrong
one is obvious.

## Voice chat

Available in friend rooms only — rooms opened with a code, between two people
who already know each other. Never in public rooms, never in quick match. That
is a deliberate product decision, not a technical limit: live audio between
anonymous strangers is a moderation problem that cannot be solved with a filter,
and this game has nobody staffed to answer it.

Two flags on `Room` look like they mean the same thing and do not:

- **`private`** — not listed in the lobby. Quick match sets this too, so that a
  matchmade game is not shown as joinable. It is therefore useless as a test for
  "these two players know each other".
- **`invited`** — the second seat was filled by somebody who typed a code the
  first player sent them. This is the one voice is gated on.

Gating on `private` was the first version, and it offered a microphone to every
stranger paired by matchmaking. `smoke:voice` caught it; the unit tests did not,
because they all built rooms through `createRoom` and never through the
matchmaker. There is now a test that goes through `hub.quick()` specifically.

The server never carries the audio. It relays the WebRTC handshake — an offer,
an answer, ICE candidates, and small on/off/mute notices — through the WebSocket
the game already uses, and the two browsers connect to each other. `relayVoice`
enforces the room rule, an allowlist of message kinds, a size cap and a rate
limit, for the same reason the emoji list is an allowlist: an unchecked relay
between two players is a chat channel, and an invisible one.

### TURN

STUN alone is enough for most pairs and costs nothing. When both players are
behind a restrictive NAT — two mobile networks is the usual case — the call
needs a relay, and without one it fails and the UI says so. Set `TURN_URL`,
`TURN_USER` and `TURN_PASS` to add one; `coturn` on any small VPS will do.

Two things to know before turning it on. Credentials handed to the browser are
readable by anyone who plays, so use short-lived ones in production. And a
direct connection means each player's device learns the other's network address
— true of any voice call, stated plainly in the privacy document, and the reason
voice is not offered to strangers.

## Monetisation

There is none, and the machinery is gone rather than switched off. Removed
outright: the Support dialog, the Advertise screen, the video overlay, the three
banner slots, and the ~190 lines of JS that drove them. The social row went with
them; the legal links stayed, because Terms and Privacy have to be reachable.

Two things deliberately survive:

- **`ADS_ENABLED = false`** at the top of `js/app.js`, guarding the one
  remaining call — the CrazyGames interstitial. That one fires on **their**
  inventory inside **their** frame and cannot run anywhere else.
- **`portal.js` in full.** It is inert outside an iframe, and most of it is
  friend invites and mute handling rather than advertising.

The streak restore no longer forks three ways. Every branch that was not the
free monthly restore ended up granting the streak anyway — an ad that never
arrived could not be allowed to cost someone their nine days — so the fallback
was always the real behaviour. The server still enforces one free restore per
calendar month.

If you ever do want ads, use **your own** publisher account. Never reuse
someone else's tag: the network keys payment to the account, so a borrowed tag
pays them and gets your domain flagged.

## Pruning dead CSS

```bash
node scripts/prune-css.mjs            # dry run, lists what it would remove
node scripts/prune-css.mjs --write
```

Removing a feature leaves its stylesheet rules behind. This deletes them per
**selector**, not per rule — several were shared, like
`.side-btn, .soc, .nav-btn { transition: … }`, and cutting the whole block to be
rid of the first two would have silently taken the transition off the navigation
as well. Edit the `DEAD` list at the top when you remove the next thing.

## Deploying

The WebSocket needs a process that stays alive, so this does **not** go on
Vercel/Netlify functions. Render, Railway, Fly.io or a small VPS all work — one
Node process, one port, and Neon on the other end. Set `PORT`, `DATABASE_URL`,
`JWT_SECRET` and `PUBLIC_ORIGIN` in the host's environment panel; `.env` is only
for local work and must never be committed.

## Before going live

- [x] Name — SolRush, applied everywhere.
- [x] Neon connected, schema applied, full stack verified end to end.
- [x] Icons — favicon, PWA set, maskable, apple-touch, social card, header mark.
- [x] **Neon password rotated** and verified end to end with `npm run smoke:db`.
- [ ] Set the absolute URLs in `<link rel="canonical">`, `og:url` and the
      `hreflang` block — they are relative right now, which works but tells a
      search engine nothing about which domain is canonical. `og:image` must be
      absolute too, or most messengers will not fetch the card.
- [x] Support, Advertise, the ad slots and the social row — removed, along
      with their CSS and their 32 orphaned translation keys.
- [x] All six language packs written (`en`, `fr`, `es`, `ru`, `tr`, `fa`),
      including the four legal documents in each. `fa` is right-to-left.
      Verified in a browser with `npm run smoke:lang`.
- [ ] Add a cookie/consent banner before taking EU traffic — the app writes a
      permanent device id to localStorage and sends language and timezone to the
      server.
- [ ] Set `RESEND_API_KEY` and `MAIL_FROM`, or password resets will only ever
      return a dev link in the response instead of sending mail.
- [ ] Only then wire up an ad network, using **your own** publisher account.
