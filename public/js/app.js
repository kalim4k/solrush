// SolRush client app: screens, board UI, online play (WebSocket), AI mode, auth.
import { initialState, applyMove, pawnMoves, canPlaceWall, goalRow, cloneState, N } from './engine.js';
import {
    SKINS, BADGES, PACKS, FINISHES,
    DEFAULT_SKIN, DEFAULT_BADGE, DEFAULT_PACK, DEFAULT_FINISH,
    resolveSkin, resolveBadge, resolvePack, resolveFinish,
    isPhoto, PHOTO_SIDE, PHOTO_MAX_CHARS,
} from './cosmetics.js';
import { playMove, playVictory, PACK_TINT, PACK_BUZZ } from './packs.js';
import { playFinish, clearFinish, FINISH_TINT, FINISH_GLYPH } from './finish.js';
import { aiMove } from './ai.js';
import { makeT, LANGS, LANG_CODES, RTL, loadLang } from './i18n.js';
import { rankOf, nextRank } from './ranks.js';
import { flameClass, isMilestone, FLAMES, MILESTONES } from './streak.js';
import { checkNick, nickOk, randomNick } from './nick.js';
import { createVoice, voiceSupported } from './voice.js';
import {
    embedded, initPortal, inPortal, portalAd, portalPlaying, portalHappy,
    portalLoaded, portalInviteCode, portalShowInvite, portalHideInvite, portalInstant,
    portalRoom, portalOnJoin, portalInviteLink, portalMuted, portalOnMute, portalUserName,
} from './portal.js';
import * as account from './account.js';

/* Monetisation is off.

   Nothing in this build asks a player to watch anything: no third-party tag in
   the page, no rewarded video behind the streak restore, and the Support screen
   asks for a share instead of an impression. portal.js still carries the
   CrazyGames ad call, because that one lives on THEIR inventory inside THEIR
   frame and can only fire there — but nothing calls it while this is false.

   Turning ads on later is this flag plus your own publisher account. Do not
   reuse anybody else's tag: the network keys payment to the account, so a
   borrowed tag pays them and gets the domain flagged. */
const ADS_ENABLED = false;

/* ================= state ================= */
const $ = (id) => document.getElementById(id);

const SUPPORTED = new Set(LANG_CODES);
// CIS languages we do not translate: Russian is the common second language there.
const CIS_LANGS = ['uk', 'be', 'kk', 'ky', 'uz', 'tg', 'az', 'hy', 'ka', 'tk'];
const CIS_TZ = /Moscow|Kaliningrad|Samara|Volgograd|Saratov|Astrakhan|Kirov|Ulyanovsk|Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Khandyga|Vladivostok|Ust-Nera|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr|Minsk|Kiev|Kyiv|Uzhgorod|Zaporozhye|Simferopol|Chisinau|Tiraspol|Almaty|Astana|Qostanay|Aqtobe|Aqtau|Atyrau|Oral|Qyzylorda|Tashkent|Samarkand|Bishkek|Dushanbe|Ashgabat|Baku|Yerevan|Tbilisi/i;
// Second hint only, for phones kept in English while the owner is elsewhere.
// Neither the phone language nor the timezone is changed by a VPN, so this
// never guesses from the IP address and never fights with a VPN.
const TZ_LANG = [
    [/Tehran/i, 'fa'],
    [/Istanbul/i, 'tr'],
    [/Paris|Brussels|Monaco|Casablanca|Algiers|Tunis|Dakar|Abidjan|Kinshasa|Lubumbashi|Douala|Libreville|Bamako|Ouagadougou|Niamey|Conakry|Antananarivo|Port-au-Prince/i, 'fr'],
    [/Madrid|Canary|Ceuta|Mexico_City|Tijuana|Monterrey|Bogota|Lima|Santiago|Buenos_Aires|Cordoba|Caracas|Guayaquil|Asuncion|Montevideo|La_Paz|Havana|Santo_Domingo|Guatemala|Tegucigalpa|Managua|El_Salvador|Panama|Costa_Rica|Puerto_Rico/i, 'es'],
    [CIS_TZ, 'ru'],
];

// First visit: the phone's own language wins, then its timezone, then English.
// Whatever the player picks by hand is remembered and always beats detection.
function detectLang() {
    const saved = localStorage.getItem('wr_lang');
    if (saved && SUPPORTED.has(saved)) return saved;
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
    for (const l of langs) {
        const base = String(l).slice(0, 2).toLowerCase();
        if (SUPPORTED.has(base)) return base;
        if (CIS_LANGS.includes(base)) return 'ru';
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    for (const [re, code] of TZ_LANG) if (re.test(tz)) return code;
    return 'en';
}
let lang = detectLang();
let t = makeT(lang);
let vibroOn = localStorage.getItem('wr_vibro') !== '0';
let soundOn = localStorage.getItem('wr_sound') !== '0';
// A portal's own mute control sits outside the frame and outranks our
// setting: silencing their page must silence us, whatever the profile says.
let portalMute = false;

/* Move sounds, like a chess clock. Synthesised, never downloaded — see
   packs.js, which holds the five voices.

   Whose pack plays is the point of the feature: the mover's. Your drums sound
   on your opponent's phone when you move, which is the only thing that makes a
   sound pack worth paying for, and it keeps the board legible because each
   player's moves keep a signature of their own. */
let audioCtx = null;
function tick(mine, wall = false) {
    if (!soundOn || portalMute) return;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        playMove(audioCtx, movingPack(mine), { wall, mine });
    } catch { /* no audio — fine */ }
}

// The winner's pack says the last word. Same rule as a move — it is their
// signature, so it plays on the loser's device too.
function victorySound(pack) {
    if (!soundOn || portalMute) return;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        playVictory(audioCtx, pack);
    } catch { /* no audio — fine */ }
}

// The pack belonging to whoever just moved. Falls back to the free one for the
// AI, for a replay, and for an opponent on a build that predates all this.
function movingPack(mine) {
    if (mine) return resolvePack(myPack, myPlus);
    return game?.oppPack || DEFAULT_PACK;
}

// The tint a wall flashes, by the seat that built it. `by` is a seat number,
// not a side of the screen, so it has to be compared with my own seat rather
// than assumed.
function packTintFor(by) {
    const mine = game && by === game.myIndex;
    return PACK_TINT[movingPack(mine)] || PACK_TINT[DEFAULT_PACK];
}

// theme: light by default, dark if the user switched it in the profile
function applyTheme() {
    const dark = localStorage.getItem('wr_theme') === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    /* Repaint the browser's own chrome to match.
       The theme here is a setting in the profile, not the operating system's —
       so a CSS media query cannot follow it, and a static tag leaves a phone
       showing a pale status bar above a dark game. These two values are --bg
       from the stylesheet's light and dark blocks; changing one means changing
       the other. */
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#12141f' : '#f4f4fb';
}
applyTheme();

// per-device id for visitor tracking (guests included)
let deviceId = localStorage.getItem('wr_device');
if (!deviceId) {
    deviceId = (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
    localStorage.setItem('wr_device', deviceId);
}
// running as an installed app? (home-screen icon opens in standalone mode)
function runsInstalled() {
    try {
        return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    } catch { return false; }
}

/* Where a player came from, worked out once and then kept forever.

   Three ways of knowing, in order of how much they can be trusted.

   A tag in the link — /?f=tt — is put there on purpose and cannot be confused
   with anything. It is the only way to tell one video from another.

   Failing that, the app they came out of. Instagram, TikTok and Facebook open
   links inside a browser of their own and hide who sent the visitor, which is
   why the referrer is useless for exactly the places that matter most — but
   that browser announces itself by name, so the visit can be attributed with
   no tag at all. This covers the ordinary case: a finger on the link in a bio.

   Failing that, who sent them. Catches search engines, Reddit, forums — every
   place that plays by the normal rules.

   Nothing catches a person who reads the address off the screen and types it.
   Those are honestly counted as direct.

   First touch only. Somebody who arrives from Instagram and comes back the
   next day by typing the address is still an Instagram player; overwriting
   would quietly turn every returning visitor into "direct" and make the whole
   table say that nothing works. */
const SRC_APPS = [
    [/Instagram/i, 'instagram'],
    [/BytedanceWebview|musical_ly|TikTok|Bytedance|trill/i, 'tiktok'],
    [/FBAN|FBAV|FB_IAB|FBIOS|FBSV/i, 'facebook'],
    [/Telegram/i, 'telegram'],
    [/Snapchat/i, 'snapchat'],
    [/Twitter/i, 'twitter'],
    [/Pinterest/i, 'pinterest'],
    [/LinkedInApp/i, 'linkedin'],
];
const SRC_HOSTS = [
    [/instagram|ig\.me/, 'instagram'], [/tiktok|musical\.ly/, 'tiktok'],
    [/youtube|youtu\.be/, 'youtube'], [/facebook|fb\.com|fb\.me/, 'facebook'],
    [/t\.me|telegram/, 'telegram'], [/google\./, 'google'],
    [/yandex\./, 'yandex'], [/bing\./, 'bing'], [/duckduckgo/, 'duckduckgo'],
    [/reddit/, 'reddit'], [/discord/, 'discord'], [/twitter|x\.com/, 'twitter'],
    [/pinterest/, 'pinterest'], [/whatsapp/, 'whatsapp'],
];

function trafficSource() {
    const saved = localStorage.getItem('wr_src');
    if (saved) return saved;
    let src = '';
    try {
        const q = new URLSearchParams(location.search);
        // ?f= is ours and short enough to type; utm_source is what every other
        // tool writes, so both are read
        const tag = (q.get('f') || q.get('utm_source') || '').toLowerCase();
        if (/^[a-z0-9_-]{1,24}$/.test(tag)) src = tag;
        if (!src) src = (SRC_APPS.find(([re]) => re.test(navigator.userAgent || '')) || [])[1] || '';
        if (!src && document.referrer) {
            const host = new URL(document.referrer).hostname;
            if (host && host !== location.hostname) {
                src = (SRC_HOSTS.find(([re]) => re.test(host)) || [])[1] || 'ref:' + host.replace(/^www\./, '').slice(0, 32);
            }
        }
        if (!src) src = 'direct';
    } catch { src = 'direct'; }
    localStorage.setItem('wr_src', src);
    return src;
}

function logVisit(game = false, installed = false) {
    try {
        fetch('/api/visit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({
                device: deviceId, nick: myNick(), game,
                // language + timezone → the owner sees who comes from where
                lang: navigator.language || '',
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                // installed-the-app flag: fires on install and on standalone launches
                installed: installed || runsInstalled(),
                src: trafficSource(),
            }),
        }).catch(() => { });
    } catch { }
}
// the moment the user accepts the install prompt, tell the server
window.addEventListener('appinstalled', () => logVisit(false, true));

// guest nick sticks to the device forever, so the same person keeps the same
// name across visits (was per-tab before — every visit looked like a new user)
let guestNick = localStorage.getItem('wr_nick') || sessionStorage.getItem('wr_nick');
// A name saved before the rules existed is replaced here rather than left to
// fail at the server, so a guest with a banned name simply gets a clean one.
if (!guestNick || checkNick(guestNick)) {
    guestNick = randomNick();
}
localStorage.setItem('wr_nick', guestNick);

let config = { auth: false };
// `session` keeps the shape the rest of this file expects — {access_token} —
// but it is now issued by /api and held by account.js rather than by Supabase.
let session = account.getSession();
let profile = null;       // {nick, points, wins, losses, veteran}

let ws = null;
let wsReady = false;
let wsToken = sessionStorage.getItem('wr_ws_token') || null;

// game context
let game = null; // { mode:'ai'|'online', state, myIndex, oppNick, clocks, over }

/* ================= ladder ================= */
// Points and streak live on the server; these are the last values it told us.
let myPoints = 0;
let myVeteran = false;
let myStreak = 0;
let myStreakBest = 0;
// Whether today already counts towards the streak. A streak that is alive but
// not yet extended today is exactly the moment it can be lost, so the flame
// goes out and the game asks for a game today instead of tomorrow.
let myStreakToday = false;
// 'none' | 'today' | 'risk' | 'freeze' | 'lost' — the card reads differently in
// each, because "4 days" after a missed day looks like a broken counter.
let myStreakState = 'none';
/* ---- cosmetics ----
   Chosen locally, sent to the server at hello, and handed to the opponent with
   the rest of the game_start payload — because a skin only the wearer can see
   is not worth anything. myPlus is what the SERVER last told us we are entitled
   to; it is never the authority, only what the picker greys out. */
let myPlus = false;
let mySkin = localStorage.getItem('wr_skin') || DEFAULT_SKIN;
let myBadge = localStorage.getItem('wr_badge') || DEFAULT_BADGE;
let myPixel = localStorage.getItem('wr_pixel') || '';
let myPack = localStorage.getItem('wr_pack') || DEFAULT_PACK;
let myFinish = localStorage.getItem('wr_finish') || DEFAULT_FINISH;

/* Every hello carries the same thing, and there are three places that send one
   — first connect, after logging in, and after logging out. When cosmetics were
   added, two of them were updated and the third was not, so a player who logged
   out kept their skin locally and lost it on the board. One builder, no drift. */
function helloMsg(jwt) {
    return {
        t: 'hello',
        nick: myNick(),
        token: wsToken,
        device: deviceId,
        tz: new Date().getTimezoneOffset(),
        /* Blank when this browser has never chosen, so the server can tell
           "I want the default" apart from "I have no opinion". Logging in on a
           second phone is the second case, and it should arrive wearing what
           the account already owns rather than resetting it. */
        skin: localStorage.getItem('wr_skin') || '',
        badge: localStorage.getItem('wr_badge') || '',
        pack: localStorage.getItem('wr_pack') || '',
        finish: localStorage.getItem('wr_finish') || '',
        // Only with the skin that uses it: 2.4 KB has no business riding on
        // every reconnect otherwise.
        pixel: mySkin === 'photo' ? myPixel : '',
        jwt,
    };
}

let myStreakBroken = 0;   // days that just broke, any size — what the flame shows
let myStreakLost = 0;     // days on offer to take back, 0 when there is nothing
let myStreakFree = false; // this month's free restore is still unspent
// Below this there is nothing worth buying back: "get 1 day back" reads as a
// joke, and the day is quicker to replay than to think about.
const MIN_RESTORE_DAYS = 3;
let streakEvent = null;   // set when a match just advanced the streak
let celebratedDay = 0;    // guards against showing the same milestone twice

const rankName = (points) => t(rankOf(points).key);
const rankIcon = (points) => rankOf(points).icon;

// Compact badge for lists and the match header: icon plus name, no number —
// the raw score is noise next to a nickname.
function rankChip(points) {
    return `${rankIcon(points)} ${rankName(points)}`;
}
let aiTimer = null;

/* ---- AI runs in a Web Worker so the UI never freezes while it thinks ---- */
let aiWorker = null;      // null = not created yet, false = unavailable
let aiReqId = 0;
const aiPending = new Map();

function getAiWorker() {
    if (aiWorker === false) return null;
    if (!aiWorker) {
        try {
            aiWorker = new Worker('js/ai-worker.js', { type: 'module' });
            aiWorker.onmessage = (e) => {
                const cb = aiPending.get(e.data.id);
                aiPending.delete(e.data.id);
                if (cb) cb(e.data.move);
            };
            aiWorker.onerror = () => { aiWorker = false; };
        } catch {
            aiWorker = false;
            return null;
        }
    }
    return aiWorker;
}

function aiMoveAsync(state, level, opts) {
    return new Promise((resolve) => {
        const w = getAiWorker();
        if (!w) { setTimeout(() => resolve(aiMove(state, level, opts)), 30); return; }
        const id = ++aiReqId;
        aiPending.set(id, resolve);
        w.postMessage({ id, state, level, opts });
        // safety net: if the worker died mid-request, compute on the main thread
        setTimeout(() => {
            if (aiPending.has(id)) {
                aiPending.delete(id);
                resolve(aiMove(state, level, opts));
            }
        }, 4000);
    });
}

/* ================= helpers ================= */
function vibrate(pattern) {
    if (vibroOn && navigator.vibrate) navigator.vibrate(pattern);
}

// Record every board position so the finished game can be replayed.
// Kept only in memory for the current game — discarded on menu/new game.
function recordSnapshot(state) {
    if (!game) return;
    (game.history = game.history || []).push(cloneState(state));
}

function myNick() {
    return profile?.nick || guestNick;
}

let toastTimer = null;
function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ================= i18n ================= */
function applyI18n() {
    t = makeT(lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    const cur = LANGS.find(l => l.code === lang) || LANGS[0];
    $('btn-lang').textContent = cur.flag + ' ' + cur.code.toUpperCase();
    $('lang-current').textContent = cur.flag + ' ' + cur.native;
    document.querySelectorAll('#lang-list button').forEach(b =>
        b.classList.toggle('active', b.dataset.lang === lang));
    updateProfileUI();
}

// The list is built once from LANGS, each entry written in its own language.
function buildLangList() {
    $('lang-list').innerHTML = LANGS
        .map(l => `<button data-lang="${l.code}"><span class="lf">${l.flag}</span>${l.native}</button>`)
        .join('');
    $('lang-list').querySelectorAll('button').forEach(b =>
        b.addEventListener('click', () => setLang(b.dataset.lang)));
}

async function setLang(code) {
    if (!SUPPORTED.has(code)) return;
    await loadLang(code);            // no-op for ru/en, which ship with the app
    lang = code;
    localStorage.setItem('wr_lang', code);
    applyI18n();
    if (game) renderGame();
    $('overlay-lang').hidden = true;
}

/* ================= navigation ================= */
const NAV_SCREENS = ['screen-home', 'screen-leaderboard', 'screen-profile'];
let currentScreen = 'screen-home';

function show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(screenId).classList.add('active');
    currentScreen = screenId;
    const nav = $('bottom-nav');
    const playing = screenId === 'screen-game' || screenId === 'screen-waiting';
    nav.classList.toggle('hidden', playing);
    // Ads live in the menus only, never over a live board
    document.documentElement.classList.toggle('in-game', playing);
    document.querySelectorAll('.nav-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.screen === screenId));
    if (screenId === 'screen-leaderboard') loadLeaderboard();
    if (screenId === 'screen-profile') { updateProfileUI(); renderPushRow(); } // points move every match
    if (screenId === 'screen-rooms') wsSend({ t: 'lobby_sub' });
    else wsSend({ t: 'lobby_unsub' });
}

document.querySelectorAll('.nav-btn').forEach(b =>
    b.addEventListener('click', () => show(b.dataset.screen)));
document.querySelectorAll('[data-back]').forEach(b =>
    b.addEventListener('click', () => show('screen-home')));

// Safari on iOS applies :active only on pages that listen for touches at all.
// Without this one empty listener every button on an iPhone stayed flat under
// the finger and the whole app felt a beat behind.
document.addEventListener('touchstart', () => { }, { passive: true });

/* ---------- with no connection ----------
   The app already worked offline — the shell is cached and the AI plays
   locally — but it gave no sign of it. Quick match, the lobby and playing a
   friend all looked exactly as usual and led to a wait with no end, so the
   whole game read as broken when in fact only half of it was unavailable. */
const ONLINE_ONLY = ['btn-quick', 'btn-online', 'btn-friend'];

function renderOnlineState() {
    const off = !navigator.onLine;
    $('offline-bar').hidden = !off;
    for (const id of ONLINE_ONLY) $(id).disabled = off;
    // an online count of 0 next to a green dot reads as "nobody is playing"
    $('online-count').parentElement.hidden = off;
}
window.addEventListener('online', () => {
    renderOnlineState();
    connectWs();                       // reconnect at once instead of on a timer
    if (currentScreen === 'screen-leaderboard') loadLeaderboard();
});
window.addEventListener('offline', renderOnlineState);

/* ================= WebSocket ================= */
let reconnectDelay = 500;

function wsSend(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/* A socket can look open while nothing is getting through — a phone changing
   network, a tunnel that died quietly. A single lost state message left the
   board frozen showing the opponent to move: no legal moves on screen, so no
   way to play, while the server had already handed the turn over and was
   counting down the thirty seconds. The player then lost a game they were
   never able to take a turn in.

   So during a game: if nothing has arrived for a few seconds, ask the server
   what the position is. Same on coming back to the tab. */
let lastMsgAt = 0;
let syncTimer = null;

function inLiveGame() { return game?.mode === 'online' && !game.over; }

function requestSync() {
    if (!inLiveGame()) return;
    if (ws && ws.readyState === 1) wsSend({ t: 'sync' });
    else if (ws && ws.readyState > 1) connectWs();   // socket is gone, rebuild it
}

function watchdogTick() {
    if (inLiveGame() && Date.now() - lastMsgAt > 6000) requestSync();
}

function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
        reconnectDelay = 500;
        wsReady = true;
        lastMsgAt = Date.now();
        wsSend(helloMsg(session?.access_token));
        if (currentScreen === 'screen-rooms') wsSend({ t: 'lobby_sub' });
    };
    ws.onmessage = (ev) => {
        lastMsgAt = Date.now();
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        handleWsMessage(msg);
    };
    ws.onclose = () => {
        wsReady = false;
        if (inLiveGame()) toast(t('conn_lost'));
        setTimeout(connectWs, reconnectDelay);
        reconnectDelay = Math.min(8000, reconnectDelay * 2);
    };
    if (!syncTimer) {
        syncTimer = setInterval(watchdogTick, 3000);
        // back from the lock screen or another app: check the board immediately
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') requestSync();
        });
    }
}

function handleWsMessage(msg) {
    switch (msg.t) {
        case 'hello_ok':
            wsToken = msg.token;
            sessionStorage.setItem('wr_ws_token', wsToken);
            $('online-count').textContent = msg.online;
            myPoints = msg.points || 0;
            myVeteran = Boolean(msg.veteran);
            /* The server's verdict on what we may wear, and on what it will
               actually show the opponent. Taking its answer back rather than
               keeping our own means a player who is not entitled to a skin
               sees the same pawn everybody else sees, instead of admiring a
               gold piece that exists only on their screen. */
            myPlus = Boolean(msg.plus);
            /* Written through to storage, not just held in memory: this is how
               a second device ends up wearing what the account owns, and it has
               to survive the next reload without a server round trip — the
               picker is on the profile screen, which opens long before the
               socket does on a slow connection. */
            if (msg.skin) { mySkin = msg.skin; localStorage.setItem('wr_skin', mySkin); }
            if (msg.badge) { myBadge = msg.badge; localStorage.setItem('wr_badge', myBadge); }
            if (msg.pixel) { myPixel = msg.pixel; localStorage.setItem('wr_pixel', myPixel); }
            if (msg.pack) { myPack = msg.pack; localStorage.setItem('wr_pack', myPack); }
            if (msg.finish) { myFinish = msg.finish; localStorage.setItem('wr_finish', myFinish); }
            renderCosmetics();
            updateProfileUI();
            myStreak = msg.streak || 0;
            myStreakBest = msg.streakBest || 0;
            myStreakToday = Boolean(msg.streakToday);
            myStreakState = msg.streakState || 'none';
            myStreakBroken = msg.streakBroken || 0;
            myStreakLost = msg.streakLost || 0;
            myStreakFree = Boolean(msg.streakFree);
            renderStreakOffer();
            renderStreak();
            updateProfileUI();
            flushPendingJoin();   // arrived through an invite link
            flushPendingQuick();  // arrived from a notification
            flushPortalRoom();    // leading a group in from the portal
            flushIntent();        // tapped Quick match before the socket was up
            break;
        case 'lobby':
            $('online-count').textContent = msg.online;
            renderRooms(msg.rooms || []);
            break;
        case 'room_created':
            $('waiting-code').hidden = !msg.code;
            if (msg.code) showInvite(msg.code);
            // Inside the portal the same code also goes to their invite button in
            // the frame's footer, so a group can be gathered without leaving it.
            if (msg.code) portalShowInvite(msg.code);
            // Their friends list shows a Join button beside this player only while
            // this is true, so it is set the moment the room opens and cleared the
            // moment it fills — a stale "joinable" sends friends into a full room.
            portalRoom(msg.code, true);
            show('screen-waiting');
            break;
        case 'game_start':
            portalHideInvite();       // the room is full; there is nobody left to invite
            portalRoom(inviteCode, false);   // same room, no longer open
            startOnlineGame(msg);
            break;
        case 'state':
            if (game?.mode === 'online') {
                // turn passed to me ⇒ this state carries the opponent's move
                const oppMoved = msg.state.turn === game.myIndex && game.state?.turn !== game.myIndex;
                const oppWalled = msg.state.walls.length > (game.state?.walls.length ?? 0);
                game.state = msg.state;
                game.clocks = { ...msg.clocks, recvAt: Date.now() };
                recordSnapshot(msg.state); // server states cover both players' moves
                cancelWallPreview();
                renderGame();
                if (oppMoved) { vibrate(12); tick(false, oppWalled); }
            }
            break;
        case 'game_over':
            if (game?.mode === 'online') {
                if (msg.points) {
                    myPoints = msg.points.total ?? myPoints;
                    game.award = msg.points;
                    updateProfileUI();
                }
                onGameOver(msg.winner === msg.you, msg.reason);
            }
            break;
        /* The account's own totals, sent by the server once it has actually
           written them. `profile` used to be fetched once at login and never
           read again, so games, wins and losses sat at zero however long you
           played, until a reload. Asking for them on game_over does not work
           either: that message goes out before the write lands. */
        case 'stats':
            if (profile) {
                profile.wins = msg.wins;
                profile.losses = msg.losses;
                profile.points = msg.points;
                profile.veteran = msg.veteran;
            }
            myPoints = msg.points ?? myPoints;
            myVeteran = Boolean(msg.veteran);
            updateProfileUI();
            break;
        case 'streak':
            myStreak = msg.streak || 0;
            myStreakBest = msg.best || myStreakBest;
            myStreakToday = true;   // this message only arrives after a match today
            myStreakState = 'today';
            myStreakBroken = 0;      // a game today started a fresh run either way
            myStreakLost = 0;
            if (msg.advanced) streakEvent = { days: myStreak, froze: Boolean(msg.froze) };
            renderStreak();
            updateProfileUI();
            // the result overlay may already be up — fill the line in place
            if (!$('overlay-gameover').hidden) showStreakLine();
            // and celebrate regardless of where the player is by now: this message
            // arrives on its own schedule, and the moment must not depend on that
            if (msg.advanced && isMilestone(myStreak)) celebrateStreak(myStreak);
            break;
        case 'emoji':
            showEmoji(msg.e);
            vibrate(20);
            break;
        case 'rematch_offer':
            toast(t('rematch') + '?');
            break;
        case 'rematch_declined':
            $('rematch-status').hidden = false;
            $('rematch-status').textContent = t('rematch_declined');
            $('btn-rematch').style.display = 'none';
            break;
        case 'rtc':
            // Signalling for the friend-room call. The server only relays this
            // in private rooms, so arriving here at all means it is allowed.
            voice?.handle(msg);
            break;
        case 'opp_disconnected':
            // the clock stops while they are away, and the screen has to show that
            if (msg.clocks && game) game.clocks = { ...msg.clocks, recvAt: Date.now() };
            // Their peer connection died with their socket. Say so, rather than
            // leaving the call looking connected while nobody can hear anything.
            voice?.peerLeft();
            toast(t('opp_disconnected'));
            break;
        case 'opp_reconnected':
            if (msg.clocks && game) game.clocks = { ...msg.clocks, recvAt: Date.now() };
            toast(t('opp_reconnected'));
            break;
        case 'error':
            if (msg.code === 'room_not_found') toast(t('err_room_not_found'));
            else if (msg.code === 'room_full') toast(t('err_room_full'));
            else if (msg.code !== 'bad_move') toast(t('err_generic'));
            break;
    }
}

/* ================= lobby ================= */
function renderRooms(rooms) {
    const list = $('rooms-list');
    list.innerHTML = '';
    if (!rooms.length) {
        list.innerHTML = `<div class="rooms-empty">${t('rooms_empty')}</div>`;
        return;
    }
    for (const room of rooms) {
        const el = document.createElement('div');
        el.className = 'room-item';
        const letter = (room.nick || '?')[0].toUpperCase();
        el.innerHTML = `<div class="r-avatar"></div><div class="r-info"><b></b><small></small></div><button class="btn-join"></button>`;
        el.querySelector('.r-avatar').textContent = letter;
        // the rank sits with the nickname, so you know who you are about to face
        el.querySelector('b').textContent = `${rankIcon(room.points || 0)} ${room.nick}`;
        // show what kind of room it is: mode · walls · time
        const modeLabel = room.mode === 'race' ? '🏁 ' + t('race_title') : '⚔️ ' + t('duel_title');
        const timeLabel = room.time === '0' ? '∞' : room.time + t('min_short');
        el.querySelector('small').textContent = `${rankName(room.points || 0)} · ${modeLabel} · ${room.walls}🧱 · ${timeLabel}`;
        const btn = el.querySelector('.btn-join');
        btn.textContent = t('join');
        btn.addEventListener('click', () => wsSend({ t: 'join_room', roomId: room.id }));
        list.appendChild(el);
    }
}

/* An action that needs the socket to be up.

   wsSend() drops the message when the socket is not open yet, silently and by
   design — it is the right behaviour for a move during a blip. It is the wrong
   behaviour for the three buttons that START online play, because every one of
   them is reachable within a second of the page appearing: on a slow connection
   the tap lands before the socket does, the message evaporates, and the player
   waits on a screen that will never resolve. Nothing retries, because nothing
   knows anything was lost.

   This never showed up in local testing — the socket is open before a hand can
   reach the screen — and it is exactly what happened on the first real
   deployment, where the round trip is no longer zero.

   Only the LAST intent is kept: tapping Quick match and then Play a friend
   should do the second thing, not both. */
let pendingIntent = null;

function whenConnected(fn) {
    if (ws && ws.readyState === WebSocket.OPEN) { fn(); return; }
    pendingIntent = fn;
}

function flushIntent() {
    const fn = pendingIntent;
    pendingIntent = null;
    if (fn) fn();
}

$('btn-online').addEventListener('click', () => show('screen-rooms'));
$('btn-quick').addEventListener('click', () => {
    // The waiting screen goes up straight away either way: "looking for an
    // opponent" is honest while the socket is still coming up.
    whenConnected(() => wsSend({ t: 'quick' }));
    show('screen-waiting');
    $('waiting-code').hidden = true;
});
$('btn-friend').addEventListener('click', () => show('screen-friend'));

/* ---- create-room settings dialog: mode / walls / time ---- */
let createCfg = { mode: 'duel', walls: '10', time: '5', private: false };
function pickOpt(groupId, val) {
    document.querySelectorAll(`#${groupId} button`).forEach(b =>
        b.classList.toggle('on', b.dataset.val === val));
}
function syncCreateDialog() {
    const race = createCfg.mode === 'race';
    // duel is always 10 walls; race lets you pick 10 or 15
    $('cr-walls').querySelector('[data-val="15"]').hidden = !race;
    if (!race && createCfg.walls === '15') { createCfg.walls = '10'; pickOpt('cr-walls', '10'); }
    $('cr-mode-hint').textContent = race ? t('race_rules') : t('duel_rules');
}
function openCreateDialog(isPrivate) {
    createCfg = { mode: 'duel', walls: '10', time: '5', private: isPrivate };
    pickOpt('cr-mode', 'duel'); pickOpt('cr-walls', '10'); pickOpt('cr-time', '5');
    syncCreateDialog();
    $('overlay-create').hidden = false;
}
$('btn-create-room').addEventListener('click', () => openCreateDialog(false));
$('btn-friend-create').addEventListener('click', () => openCreateDialog(true));
$('cr-cancel').addEventListener('click', () => { $('overlay-create').hidden = true; });
$('cr-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    createCfg.mode = b.dataset.val; pickOpt('cr-mode', b.dataset.val); syncCreateDialog();
});
$('cr-walls').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.hidden) return;
    createCfg.walls = b.dataset.val; pickOpt('cr-walls', b.dataset.val);
});
$('cr-time').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    createCfg.time = b.dataset.val; pickOpt('cr-time', b.dataset.val);
});
$('cr-create').addEventListener('click', () => {
    $('overlay-create').hidden = true;
    const cfg = { ...createCfg };
    whenConnected(() => wsSend({
        t: 'create_room', private: cfg.private,
        mode: cfg.mode, walls: Number(cfg.walls), time: cfg.time,
    }));
});
$('btn-friend-join').addEventListener('click', () => {
    const code = $('friend-code-input').value.trim().toUpperCase();
    if (code.length >= 4) whenConnected(() => wsSend({ t: 'join_code', code }));
});

/* ================= invite a friend by link ================= */
// Without these two counters there is no way to tell whether invitations are
// being sent at all, let alone whether anyone arrives through them.
function logEvent(kind) {
    try {
        fetch('/api/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: deviceId, kind }),
            keepalive: true,
        }).catch(() => { });
    } catch { /* analytics must never break the game */ }
}

// example.com/#K7X2P9 — the friend taps it and lands straight in the room,
// with nothing to read out or type in.
const CODE_RE = /^[A-Z0-9]{4,8}$/;
const roomLink = (code) => location.origin + '/#' + code;

let inviteCode = '';
function showInvite(code) {
    inviteCode = code;
    $('room-code-value').textContent = code;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // clipboard API needs a secure context and permission; the old selection
        // trick still works where it does not
        try {
            const el = document.createElement('textarea');
            el.value = text;
            el.style.position = 'fixed';
            el.style.opacity = '0';
            document.body.appendChild(el);
            el.select();
            const ok = document.execCommand('copy');
            el.remove();
            return ok;
        } catch {
            return false;
        }
    }
}


// Straight from the result screen into a private room, keeping whatever
// settings were last used — the friend just wants to play, not configure.
// This one button brings around 388 new players a day, over a tenth of all
// growth, which is why it holds the result screen.
$('btn-invite-friend').addEventListener('click', () => {
    $('overlay-gameover').hidden = true;
    wsSend({
        t: 'create_room', private: true,
        mode: createCfg.mode, walls: Number(createCfg.walls), time: createCfg.time,
    });
});

$('invite-share').addEventListener('click', async () => {
    // Inside a portal our own address is the wrong one to hand out: it takes
    // the friend out of the page they are on. Theirs opens the room in place.
    const url = (await portalInviteLink(inviteCode)) || roomLink(inviteCode);
    logEvent('invite_share');
    // the native sheet puts the link straight into WhatsApp or Telegram
    if (navigator.share) {
        try {
            await navigator.share({ title: 'SolRush', text: t('invite_text'), url });
            return;
        } catch {
            return;   // the player dismissed the sheet — not an error
        }
    }
    // desktop browsers often have no share sheet — copy instead, same one tap
    toast(await copyText(url) ? t('invite_copied') : url);
});

// A code in the address bar means the player arrived through an invitation.
// It is consumed once: the hash is cleared so a refresh does not rejoin.
let pendingJoin = '';
function takeInviteFromUrl() {
    const code = decodeURIComponent(location.hash.replace(/^#/, '')).trim().toUpperCase();
    if (!CODE_RE.test(code)) return;
    pendingJoin = code;
    history.replaceState(null, '', location.pathname + location.search);
}

// arriving from a notification: straight into matchmaking
let pendingQuick = false;
// leading a group in from a portal: open a private room the moment we connect
let pendingPortalRoom = false;
function takeQuickFromUrl() {
    const q = new URLSearchParams(location.search);
    if (q.get('go') !== 'quick') return;
    pendingQuick = true;
    history.replaceState(null, '', location.pathname);
}

function flushPendingJoin() {
    if (!pendingJoin) return;
    wsSend({ t: 'join_code', code: pendingJoin });
    logEvent('invite_join');
    pendingJoin = '';
}

function flushPendingQuick() {
    if (!pendingQuick) return;
    pendingQuick = false;
    wsSend({ t: 'quick' });
    show('screen-waiting');
    $('waiting-code').hidden = true;
}
$('btn-cancel-wait').addEventListener('click', () => { portalHideInvite(); portalRoom('', false); wsSend({ t: 'leave_room' }); show('screen-home'); });
$('btn-how').addEventListener('click', () => { $('overlay-how').hidden = false; });
$('btn-how-close').addEventListener('click', () => { $('overlay-how').hidden = true; });

/* ================= board rendering ================= */
const board = $('board');
let geo = null; // {u, g, pad, size}
let cellEls = [];
let pawnEls = [null, null];

// board dimensions of the current game (race is bigger than the classic 9x9)
function dims() {
    const s = game?.state;
    return { cols: s?.cols || 9, rows: s?.rows || 9 };
}
function isRace() { return game?.state?.mode === 'race'; }

function computeGeo() {
    const { cols, rows } = dims();
    // cells are 1u, grooves and padding 0.3u → total width in units:
    const uw = cols * 1.3 + 0.3;
    const uh = rows * 1.3 + 0.3;
    const size = board.clientWidth;
    const u = size / uw;
    const g = 0.3 * u;
    geo = { size, height: u * uh, u, g, pad: g };
}

// view mapping: player 1 sees the board rotated 180° — but NOT in race mode,
// where both players stand on the same (bottom) side
function toView(r, c) {
    if (game?.myIndex === 1 && !isRace()) {
        const { cols, rows } = dims();
        return { r: rows - 1 - r, c: cols - 1 - c };
    }
    return { r, c };
}
function wallToView(w) {
    if (game?.myIndex === 1 && !isRace()) {
        const { cols, rows } = dims();
        return { r: rows - 2 - w.r, c: cols - 2 - w.c, o: w.o };
    }
    return w;
}
// inverse mappings equal the forward ones (180° rotation is an involution)
const fromView = toView;
const wallFromView = wallToView;

function cellXY(r, c) {
    return { x: geo.pad + c * (geo.u + geo.g), y: geo.pad + r * (geo.u + geo.g) };
}

function buildBoard() {
    // A rematch started within a second of a win would otherwise open on a board
    // with the last celebration still running over it. Every new game passes
    // through here, which is why it is done here and not in three start paths.
    clearFinish(board);
    const { cols, rows } = dims();
    // race board is taller than wide — cap width so the whole board fits on screen
    board.style.aspectRatio = `${cols * 1.3 + 0.3} / ${rows * 1.3 + 0.3}`;
    board.style.maxWidth = isRace() ? 'min(80vw, 46dvh)' : 'min(87vw, 55dvh)';
    computeGeo();
    board.innerHTML = '';
    cellEls = [];

    // competitor look: tinted end-zone bands under a thin pencil grid,
    // cells stay as invisible tap targets
    const bandH = geo.pad + geo.u + geo.g / 2;
    for (const pos of ['top', 'bottom']) {
        if (isRace() && pos === 'bottom') continue; // race: only the finish band on top
        const b = document.createElement('div');
        b.className = 'zone-band ' + pos;
        b.style.cssText = (pos === 'top' ? 'top:0;' : 'bottom:0;') + `left:0;width:100%;height:${bandH}px`;
        board.appendChild(b);
    }
    for (let i = 1; i < Math.max(cols, rows); i++) {
        const at = geo.pad + i * (geo.u + geo.g) - geo.g / 2;
        if (i < cols) {
            const v = document.createElement('div');
            v.className = 'grid-line';
            v.style.cssText = `left:${at}px;top:${geo.pad / 2}px;width:1px;height:${geo.height - geo.pad}px`;
            board.append(v);
        }
        if (i < rows) {
            const h = document.createElement('div');
            h.className = 'grid-line';
            h.style.cssText = `left:${geo.pad / 2}px;top:${at}px;width:${geo.size - geo.pad}px;height:1px`;
            board.append(h);
        }
    }

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const el = document.createElement('div');
            el.className = 'cell';
            const { x, y } = cellXY(r, c);
            el.style.cssText = `left:${x}px;top:${y}px;width:${geo.u}px;height:${geo.u}px`;
            el.dataset.vr = r;
            el.dataset.vc = c;
            board.appendChild(el);
            cellEls.push(el);
        }
    }
    pawnEls = [0, 1].map(i => {
        const el = document.createElement('div');
        el.className = 'pawn';
        const d = geo.u * 0.82;
        el.style.width = el.style.height = d + 'px';
        board.appendChild(el);
        return el;
    });
}

const BADGE_GLYPH = { none: '', flame: '🔥', crown: '👑', star: '⭐', bolt: '⚡', skull: '💀' };

/* Same idea as paintPawn, for the small ball in the player pill. Kept separate
   because the ball holds a rank icon inside it and must not lose the class the
   rank styling hangs off. */
function paintChipBall(el, skin, pixel, seat) {
    if (!el) return;
    const usePixel = skin === 'photo' && isPhoto(pixel);
    const cls = ['chip-ball', seat];
    if (usePixel) cls.push('skin-photo');
    else if (skin && skin !== DEFAULT_SKIN && skin !== 'photo') cls.push('skin-' + skin);
    el.className = cls.join(' ');
    // Clear the shorthand first: applyChipBallColors() writes an inline
    // `background` for unskinned balls, and that shorthand would otherwise sit
    // on top of the photo set on the next line.
    el.style.background = '';
    el.style.backgroundImage = usePixel ? photoURL(pixel) : '';
}

/* A nickname with its owner's badge in front. Built from nodes rather than a
   template string: the nickname is chosen by another player and arrives over
   the socket, so it goes in as text and never as markup. */
function setNickWithBadge(el, nick, badge) {
    el.textContent = '';
    const glyph = BADGE_GLYPH[badge] || '';
    if (glyph) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = glyph;
        el.appendChild(b);
    }
    el.appendChild(document.createTextNode(String(nick ?? '')));
}

/* A pawn wears the skin its owner chose, and falls back to its seat colour —
   for a player with no skin, for the AI, and for an opponent on a build that
   predates all this. Never leaves a pawn unpainted: an invisible piece is
   worse than a plain one. */
function paintPawn(el, skin, pixel, seat, extra = '') {
    const usePixel = skin === 'photo' && isPhoto(pixel);
    const cls = ['pawn'];
    if (usePixel) cls.push('skin-photo');
    else if (skin && skin !== DEFAULT_SKIN && skin !== 'photo') cls.push('skin-' + skin);
    else cls.push(seat);
    if (extra) cls.push(extra);
    el.className = cls.join(' ');
    el.style.backgroundImage = usePixel ? photoURL(pixel) : '';
}

/* The photo is already a data URL, so this is only quoting.

   The quotes matter: a data URL contains commas, semicolons and slashes, and an
   unquoted url() ends at the first one the parser dislikes. It cannot contain a
   double quote — isPhoto() allows base64 characters only — so quoting is safe
   without escaping. */
function photoURL(data) {
    return isPhoto(data) ? `url("${data}")` : '';
}

function positionPawn(i) {
    const p = game.state.pawns[i];
    const v = toView(p.r, p.c);
    const { x, y } = cellXY(v.r, v.c);
    const off = geo.u * 0.09;
    pawnEls[i].style.left = (x + off) + 'px';
    pawnEls[i].style.top = (y + off) + 'px';
}

function wallRect(vw) {
    const thick = geo.g * 0.78;             // slim capsule, well inside the groove
    const inset = -geo.g / 2;               // stretch to the grid lines: collinear walls join seamlessly
    const len = 2 * geo.u + geo.g - 2 * inset;
    const a = cellXY(vw.r, vw.c);
    if (vw.o === 'h') {
        return { x: a.x + inset, y: a.y + geo.u + geo.g / 2 - thick / 2, w: len, h: thick };
    }
    return { x: a.x + geo.u + geo.g / 2 - thick / 2, y: a.y + inset, w: thick, h: len };
}

function renderGame() {
    if (!game) return;
    const s = game.state;
    const me = game.myIndex;

    // walls (replay the pop-in animation only for newly added ones)
    const prevWallCount = game._wallsRendered || 0;
    board.querySelectorAll('.wall:not(.preview)').forEach(el => el.remove());
    s.walls.forEach((w, idx) => {
        const el = document.createElement('div');
        // wall wears the color of whoever placed it (player 0 blue, player 1 red)
        el.className = 'wall ' + (w.by === 0 ? 'blue' : w.by === 1 ? 'red' : '');
        if (idx < prevWallCount) el.classList.add('no-anim');
        const rect = wallRect(wallToView(w));
        el.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
        /* The pack is seen as well as heard: the wall lands in its owner's
           colour. A custom property rather than a class, because the flash
           belongs to the player who built it and there is one wall element per
           wall — so this is the cheapest way to say "this one, that colour"
           without a rule per pack per seat. */
        el.style.setProperty('--flash', packTintFor(w.by));
        board.appendChild(el);
    });
    game._wallsRendered = s.walls.length;

    const myTurn = s.turn === me && s.winner === null && !game.over;

    // pawns: my pawn gets my skin, or my seat colour; glowing ring on my turn
    paintPawn(pawnEls[me], resolveSkin(mySkin, myPlus), myPixel, myColor(), myTurn ? 'glow' : '');
    paintPawn(pawnEls[1 - me], game.oppSkin, game.oppPixel, oppColor());
    positionPawn(0);
    positionPawn(1);

    // move hints are colored like my ball
    board.classList.toggle('my-blue', myColor() === 'blue');
    board.classList.toggle('my-red', myColor() === 'red');

    const legal = myTurn ? pawnMoves(s, me) : [];
    for (const el of cellEls) {
        const vr = +el.dataset.vr, vc = +el.dataset.vc;
        const lg = fromView(vr, vc);
        const isLegal = legal.some(m => m.r === lg.r && m.c === lg.c);
        el.classList.toggle('legal', isLegal);
    }

    // HUD — rank icons only during play; the number belongs on the result screen
    setNickWithBadge($('me-nick'), myNick(), resolveBadge(myBadge, myPlus));
    setNickWithBadge($('opp-nick'), game.oppNick, game.oppBadge);
    const online = game.mode === 'online';
    $('me-rank').textContent = online ? rankIcon(myPoints) : '';
    $('opp-rank').textContent = online ? rankIcon(game.oppPoints || 0) : '';
    $('me-walls').textContent = s.left[me];
    $('opp-walls').textContent = s.left[1 - me];
    $('dock-walls').textContent = s.left[me];
    const canDrag = myTurn && s.left[me] > 0;
    $('drag-h').classList.toggle('disabled', !canDrag);
    $('drag-v').classList.toggle('disabled', !canDrag);
    $('chip-me').className = 'p-pill ' + myColor() + (myTurn ? ' turn-active' : '');
    $('chip-opp').className = 'p-pill ' + oppColor() +
        (!myTurn && s.winner === null && !game.over ? ' turn-active' : '');
    /* The ball beside each name wears the same skin as that player's pawn.
       Without this the board showed a photograph while the pill two inches
       above it showed a plain coloured bead for the same person, which reads
       as a bug rather than as a design. */
    paintChipBall($('chip-me').querySelector('.chip-ball'),
        resolveSkin(mySkin, myPlus), myPixel, myColor());
    paintChipBall($('chip-opp').querySelector('.chip-ball'),
        game.oppSkin, game.oppPixel, oppColor());
    applyChipBallColors();
    $('turn-banner').textContent = myTurn ? t('your_turn') : t('opp_turn');
    const bandTop = board.querySelector('.zone-band.top');
    const bandBottom = board.querySelector('.zone-band.bottom');
    if (isRace()) {
        // race: everyone runs to the same finish line on top
        $('zone-top').textContent = '🏁 ' + t('finish_label');
        $('zone-top').className = 'zone-label zone-top finish';
        $('zone-bottom').textContent = '▲ ' + myNick().toUpperCase() + ' · ' + String(game.oppNick).toUpperCase();
        $('zone-bottom').className = 'zone-label zone-bottom';
        if (bandTop) bandTop.className = 'zone-band top finish';
    } else {
        // like the competitor: each end is tinted with its OWNER's color —
        // opponent's home on top, mine at the bottom (that's also my start)
        $('zone-top').textContent = '▲ ' + String(game.oppNick).toUpperCase();
        $('zone-top').className = 'zone-label zone-top ' + oppColor();
        $('zone-bottom').textContent = '▼ ' + myNick().toUpperCase();
        $('zone-bottom').className = 'zone-label zone-bottom ' + myColor();
        if (bandTop) bandTop.className = 'zone-band top ' + oppColor();
        if (bandBottom) bandBottom.className = 'zone-band bottom ' + myColor();
    }
}

function myColor() { return game.myIndex === 0 ? 'blue' : 'red'; }
function oppColor() { return game.myIndex === 0 ? 'red' : 'blue'; }

function applyChipBallColors() {
    document.querySelectorAll('.chip-ball').forEach(el => {
        /* A skinned ball paints itself from a class, and an inline background
           beats any class there is — so writing the seat colour here would
           silently undo every skin. Leave those alone. */
        if ([...el.classList].some(c => c.startsWith('skin-'))) return;
        const isRed = el.classList.contains('red');
        el.style.background = isRed
            ? 'radial-gradient(circle at 32% 26%, #ffb9c0, #e33d52 62%, #a91f33)'
            : 'radial-gradient(circle at 32% 26%, #b6d2ff, #2f6df6 62%, #1a48b8)';
    });
}

/* ================= clocks ================= */
function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

setInterval(() => {
    if (!game || game.over) return;
    if (game.mode === 'ai') {
        $('me-clock').textContent = '—';
        $('opp-clock').textContent = '—';
        $('me-clock').classList.remove('danger');
        $('opp-clock').classList.remove('danger');
        return;
    }
    const ck = game.clocks;
    if (!ck) return;
    // Frozen while an opponent is away: the server has stopped charging the turn,
    // so a screen that kept counting down would be showing a defeat that is not
    // going to happen.
    const elapsed = ck.paused ? 0 : Date.now() - ck.recvAt;
    const me = game.myIndex;
    const bank = [...ck.bank];
    const active = ck.turn;
    bank[active] = Math.max(0, bank[active] - elapsed);
    const moveLeft = Math.max(0, Math.min(ck.moveLimit - elapsed, bank[active]));

    // no-time rooms show ∞ — only the 30s per-move rule applies
    $('me-clock').textContent = ck.noTime ? '∞' : fmtClock(bank[me]);
    $('opp-clock').textContent = ck.noTime ? '∞' : fmtClock(bank[1 - me]);
    const meDanger = active === me && (moveLeft <= 10_000 || (!ck.noTime && bank[me] <= 10_000));
    const oppDanger = active !== me && (moveLeft <= 10_000 || (!ck.noTime && bank[1 - me] <= 10_000));
    $('me-clock').classList.toggle('danger', meDanger);
    $('opp-clock').classList.toggle('danger', oppDanger);

    const myTurn = active === me;
    $('turn-banner').textContent =
        (myTurn ? t('your_turn') : t('opp_turn')) + ` · ${Math.ceil(moveLeft / 1000)}s`;
}, 250);

/* ============ moves: tap a cell to move · drag a wall from the dock ============ */
let previewEl = null;
let dragWall = null; // 'h' | 'v' while a wall is being dragged from the dock
let dragValid = false;
let dragSlot = null; // logical wall coords under the finger

function isMyTurn() {
    return game && !game.over && game.state.winner === null && game.state.turn === game.myIndex;
}

function cancelWallPreview() {
    dragWall = null;
    dragSlot = null;
    dragValid = false;
    if (previewEl) { previewEl.remove(); previewEl = null; }
}

// nearest wall slot to a board point, orientation is fixed by the dragged handle
function nearestSlot(px, py, o) {
    const step = geo.u + geo.g;
    const { cols, rows } = dims();
    const clampR = (v) => Math.max(0, Math.min(rows - 2, v));
    const clampC = (v) => Math.max(0, Math.min(cols - 2, v));
    const r = clampR(Math.round((py - geo.pad - geo.u - geo.g / 2) / step));
    const c = clampC(Math.round((px - geo.pad - geo.u - geo.g / 2) / step));
    return wallFromView({ o, r, c });
}

function updateDragPreview(clientX, clientY, isTouch) {
    const bw = board.getBoundingClientRect();
    const px = clientX - bw.left;
    let py = clientY - bw.top;
    if (isTouch) py -= geo.u * 0.8; // keep the wall visible above the finger
    // outside the board → hide the preview but keep dragging
    if (px < -geo.u || py < -geo.u || px > bw.width + geo.u || py > bw.height + geo.u) {
        if (previewEl) { previewEl.remove(); previewEl = null; }
        dragSlot = null;
        return;
    }
    dragSlot = nearestSlot(Math.max(0, Math.min(bw.width, px)), Math.max(0, Math.min(bw.height, py)), dragWall);
    dragValid = canPlaceWall(game.state, game.myIndex, dragSlot) && game.state.left[game.myIndex] > 0;
    if (!previewEl) {
        previewEl = document.createElement('div');
        board.appendChild(previewEl);
    }
    previewEl.className = `wall preview ${myColor()} ${dragValid ? 'preview-ok' : 'preview-bad'}`;
    const rect = wallRect(wallToView(dragSlot));
    previewEl.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
}

function finishDrag() {
    if (dragWall && dragSlot && dragValid) {
        const w = dragSlot;
        cancelWallPreview();
        submitMove({ type: 'wall', ...w });
    } else {
        cancelWallPreview();
    }
}

function startDrag(o) {
    if (!isMyTurn() || game.state.left[game.myIndex] <= 0) return false;
    dragWall = o;
    dragSlot = null;
    dragValid = false;
    vibrate(12);
    return true;
}

for (const [id, o] of [['drag-h', 'h'], ['drag-v', 'v']]) {
    const el = $(id);
    el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (startDrag(o)) {
            const tt = e.changedTouches[0];
            updateDragPreview(tt.clientX, tt.clientY, true);
        }
    }, { passive: false });
    el.addEventListener('mousedown', (e) => {
        if ('ontouchstart' in window) return;
        e.preventDefault();
        startDrag(o);
    });
}

document.addEventListener('touchmove', (e) => {
    if (!dragWall) return;
    e.preventDefault();
    const tt = e.changedTouches[0];
    updateDragPreview(tt.clientX, tt.clientY, true);
}, { passive: false });
document.addEventListener('touchend', () => { if (dragWall) finishDrag(); });
document.addEventListener('touchcancel', () => { if (dragWall) cancelWallPreview(); });

window.addEventListener('mousemove', (e) => { if (dragWall) updateDragPreview(e.clientX, e.clientY, false); });
window.addEventListener('mouseup', () => { if (dragWall) finishDrag(); });

// tap a highlighted cell → move the ball
function tapCell(target) {
    if (!isMyTurn() || dragWall) return false;
    const cell = target?.closest?.('.cell');
    if (cell && cell.classList.contains('legal')) {
        const lg = fromView(+cell.dataset.vr, +cell.dataset.vc);
        submitMove({ type: 'pawn', r: lg.r, c: lg.c });
        return true;
    }
    return false;
}

// react on touchend directly: mobile browsers fire `click` with a delay,
// and the move must land the instant the finger lifts
let cellTouch = null;
board.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && !dragWall) {
        const tt = e.touches[0];
        cellTouch = { x: tt.clientX, y: tt.clientY };
    } else cellTouch = null;
}, { passive: true });
board.addEventListener('touchend', (e) => {
    const start = cellTouch;
    cellTouch = null;
    if (!start || dragWall) return;
    const tt = e.changedTouches[0];
    if (Math.abs(tt.clientX - start.x) > 14 || Math.abs(tt.clientY - start.y) > 14) return; // was a scroll
    if (tapCell(document.elementFromPoint(tt.clientX, tt.clientY))) {
        e.preventDefault(); // swallow the delayed synthetic click so the move isn't sent twice
    }
}, { passive: false });

board.addEventListener('click', (e) => { tapCell(e.target); }, false);

function submitMove(move) {
    if (!isMyTurn()) return;
    // The buzz belongs to the pack too — the drums thump, the ice barely ticks.
    vibrate(PACK_BUZZ[resolvePack(myPack, myPlus)] ?? (move.type === 'wall' ? 25 : 15));
    tick(true, move.type === 'wall');
    if (game.mode === 'online') {
        wsSend({ t: 'move', move });
        // optimistic apply for snappy UI; server state will overwrite
        const copy = cloneState(game.state);
        if (applyMove(copy, move)) {
            if (move.type === 'wall') copy.walls[copy.walls.length - 1].by = game.myIndex;
            game.state = copy;
            renderGame();
        }
    } else {
        const s = game.state;
        if (!applyMove(s, move)) return;
        notePos(s);
        if (move.type === 'wall') s.walls[s.walls.length - 1].by = game.myIndex;
        recordSnapshot(s);
        renderGame();
        if (s.winner !== null) { onGameOver(s.winner === game.myIndex, 'goal'); return; }
        scheduleAiMove();
    }
}

/* ================= AI mode ================= */
function posKey(s) {
    return `${s.pawns[0].r},${s.pawns[0].c}|${s.pawns[1].r},${s.pawns[1].c}|${s.left[0]},${s.left[1]}`;
}

function notePos(s) {
    if (!game || game.mode !== 'ai') return;
    (game.seen = game.seen || []).push(posKey(s));
    if (game.seen.length > 16) game.seen.shift();
}

function scheduleAiMove() {
    clearTimeout(aiTimer);
    const hardcore = game.aiLevel === 'hardcore';
    aiTimer = setTimeout(async () => {
        if (!game || game.mode !== 'ai' || game.over) return;
        const g = game;
        const s = game.state;
        if (s.turn !== 1 - game.myIndex) return;
        const t0 = Date.now();
        const move = await aiMoveAsync(s, game.aiLevel, { recent: game.seen || [] });
        if (game !== g || !move) return; // the game was left/restarted meanwhile
        const finish = () => {
            if (!game || game.mode !== 'ai' || game.over) return;
            if (applyMove(s, move)) {
                notePos(s);
                if (move.type === 'wall') s.walls[s.walls.length - 1].by = 1 - game.myIndex;
                recordSnapshot(s);
                renderGame();
                vibrate(10);
                tick(false, move.type === 'wall');
                if (s.winner !== null) onGameOver(s.winner === game.myIndex, 'goal');
            }
        };
        // hardcore always answers after exactly ~1.3s: thinking time + padding
        const pad = hardcore ? Math.max(0, 1300 - (Date.now() - t0)) : 0;
        aiTimer = setTimeout(finish, pad);
    }, hardcore ? 120 : 500 + Math.random() * 700);
}

function startAiGame(level = 'normal', boardMode = 'duel') {
    game = {
        mode: 'ai',
        aiLevel: level,
        state: initialState(boardMode),
        myIndex: 0,
        oppNick: '🤖 ' + t('ai_' + level),
        clocks: null,
        over: false,
    };
    game.state.turn = Math.random() < 0.5 ? 0 : 1;
    game.seen = []; // recent positions, so hardcore never shuffles back and forth
    game.history = [cloneState(game.state)]; // for the post-game replay
    stopReplay();
    $('overlay-gameover').hidden = true;
    cancelWallPreview();
    logVisit(true);
    show('screen-game');
    buildBoard();
    renderGame();
    portalPlaying(true);   // a portal keeps its own ads out of a live match
    if (game.state.turn === 1) scheduleAiMove();
}

$('btn-ai').addEventListener('click', () => show('screen-ai'));
for (const lvl of ['easy', 'normal', 'hard', 'hardcore']) {
    $('ai-' + lvl).addEventListener('click', () => startAiGame(lvl));
}

/* ================= online game ================= */
function startOnlineGame(msg) {
    if (msg.me) { myPoints = msg.me.points || 0; myVeteran = Boolean(msg.me.veteran); }
    // a second match on the same day must not replay the same celebration
    streakEvent = null;
    celebratedDay = 0;
    game = {
        mode: 'online',
        state: msg.state,
        myIndex: msg.you,
        oppNick: msg.opp?.nick || '???',
        oppPoints: msg.opp?.points || 0,
        /* Already resolved by the server against what that player is entitled
           to wear, so these are taken as given. Doing the check again here
           would only mean two places to keep in step, and this one is the copy
           an opponent could edit. */
        oppSkin: msg.opp?.skin || DEFAULT_SKIN,
        oppBadge: msg.opp?.badge || DEFAULT_BADGE,
        oppPixel: msg.opp?.pixel || '',
        oppPack: msg.opp?.pack || DEFAULT_PACK,
        oppFinish: msg.opp?.finish || DEFAULT_FINISH,
        ranked: msg.ranked !== false,
        clocks: { ...msg.clocks, recvAt: Date.now() },
        over: false,
        award: null,
        history: [cloneState(msg.state)], // for the post-game replay
    };
    stopReplay();
    $('overlay-gameover').hidden = true;
    $('btn-rematch').style.display = '';
    $('rematch-status').hidden = true;
    cancelWallPreview();
    logVisit(true);
    show('screen-game');
    setupVoice(msg);
    buildBoard();
    renderGame();
    portalPlaying(true);   // a portal keeps its own ads out of a live match
    vibrate([20, 40, 20]);
}

/* ================= game over / rematch ================= */
/* Their ad goes between matches and nowhere else, and not after every one.
   A portal pays per ad shown, which makes it tempting to ask on every result
   screen — and that is exactly how a game gets closed and never opened again.
   One every four minutes at most, on a screen the player is leaving anyway. */
const PORTAL_AD_GAP_MS = 4 * 60 * 1000;
let lastPortalAd = 0;

function maybePortalAd() {
    if (!ADS_ENABLED) return;
    if (!inPortal() || Date.now() - lastPortalAd < PORTAL_AD_GAP_MS) return;
    lastPortalAd = Date.now();
    portalAd('midgame');
}

function onGameOver(iWon, reason) {
    if (!game || game.over) return;
    game.over = true;
    clearTimeout(aiTimer);
    portalPlaying(false);
    if (iWon) portalHappy();
    renderGame();
    const reasonKey = {
        goal: 'reason_goal', timeout: 'reason_timeout', move_timeout: 'reason_move_timeout',
        opponent_left: 'reason_opponent_left', resign: 'reason_resign',
    }[reason] || 'reason_goal';
    const reveal = () => {
        $('result-emoji').textContent = iWon ? '🏆' : '😔';
        $('result-title').textContent = iWon ? t('game_win') : t('game_lose');
        $('result-reason').textContent = t(reasonKey);
        document.querySelector('.win-modal').classList.toggle('lose', !iWon);
        // players strip
        $('rs-ball-me').className = 'rs-ball ' + myColor();
        $('rs-ball-opp').className = 'rs-ball ' + oppColor();
        $('rs-nick-me').textContent = myNick();
        $('rs-nick-opp').textContent = game?.oppNick || '';
        $('rs-tag-me').textContent = iWon ? 'WIN' : 'LOSS';
        $('rs-tag-me').className = iWon ? 'win' : 'loss';
        $('rs-tag-opp').textContent = iWon ? 'LOSS' : 'WIN';
        $('rs-tag-opp').className = iWon ? 'loss' : 'win';
        showAward();
        showStreakLine();
        spawnConfetti(iWon);
        $('btn-rematch').style.display = '';
        $('rematch-status').hidden = true;
        $('overlay-gameover').hidden = false;
        maybeAskPush();
        maybePortalAd();
    };

    /* The winner's victory signature, on both screens — theirs is what the
       loser watches. This is the one moment in a match when both players are
       certainly looking at the same thing, which is why it is the piece of the
       Plus offer that sells the rest.

       It delays the result screen by up to a second and a bit, and that cost is
       paid by the person who just lost, so two things are non-negotiable: the
       cap in FINISH_MS, and the tap-to-skip below. Anyone who does not want to
       watch gets their result the instant they touch the screen. */
    const fin = iWon ? resolveFinish(myFinish, myPlus) : (game.oppFinish || DEFAULT_FINISH);
    const glyph = iWon
        ? BADGE_GLYPH[resolveBadge(myBadge, myPlus)]
        : BADGE_GLYPH[game.oppBadge || DEFAULT_BADGE];
    /* Inside the board, not around it. The first version hung this on
       .board-wrap — the whole flex column — and the storm rained down over the
       player pills and the empty space beside them, which read as a rendering
       fault rather than as weather. Clipped to the board, the same animation
       reads as something happening ON the game. */
    const anim = playFinish(board, fin, { glyph: glyph || '🏆' });
    if (anim.ms) victorySound(movingPack(iWon));   // the winner's pack, same rule

    let shown = false;
    const finishNow = () => {
        if (shown) return;
        shown = true;
        clearTimeout(timer);
        document.removeEventListener('pointerdown', finishNow, true);
        anim.stop();
        reveal();
    };
    const timer = setTimeout(finishNow, Math.max(600, anim.ms));
    // Capture phase: nothing under the finger during this second should be able
    // to swallow the tap, and there is nothing left to click on the board anyway.
    if (anim.ms) document.addEventListener('pointerdown', finishNow, true);

    vibrate(iWon ? [40, 60, 40, 60, 80] : 60);
}

// The points line under the result. This is the number people come back for,
// so it gets its own row rather than being tucked into the stats strip.
function showAward() {
    const row = $('pts-row'), up = $('rank-up'), note = $('pts-note');
    row.hidden = true; up.hidden = true; note.hidden = true;
    if (game?.mode !== 'online') return;
    const a = game.award;
    if (game.ranked === false || a?.ranked === false) {
        // friendly game via a private code — say so instead of showing nothing
        note.textContent = t('unranked_hint');
        note.hidden = false;
        return;
    }
    // nothing moved: either the floor at zero held, or a rematch hit the cap
    if (!a || !a.delta) return;
    const before = (a.total || 0) - a.delta;
    row.hidden = false;
    $('pts-delta').textContent = (a.delta > 0 ? '+' : '') + a.delta;
    $('pts-delta').className = 'pts-delta ' + (a.delta > 0 ? 'up' : 'down');
    $('pts-total').textContent = `${a.total} ${t('points_label')}`;
    if (rankOf(a.total).key !== rankOf(before).key) {
        const climbed = a.delta > 0;
        up.textContent = (climbed ? t('rank_up') : t('rank_down')) + ' ' + rankChip(a.total);
        up.className = 'rank-up ' + (climbed ? 'up' : 'down');
        up.hidden = false;
        if (climbed) vibrate([30, 50, 30, 50, 60]);
    }
}

function spawnConfetti(on) {
    const box = $('confetti');
    box.innerHTML = '';
    if (!on) return;
    const colors = ['#2f6df6', '#ffb340', '#ff5c7a', '#21c07a', '#9b7bff', '#ff8a5c'];
    for (let i = 0; i < 42; i++) {
        const p = document.createElement('span');
        p.style.left = Math.random() * 100 + '%';
        p.style.background = colors[i % colors.length];
        p.style.animationDuration = (2.4 + Math.random() * 2.4) + 's';
        p.style.animationDelay = (Math.random() * 1.8) + 's';
        p.style.transform = `rotate(${Math.random() * 360}deg)`;
        box.appendChild(p);
    }
}

$('btn-rematch').addEventListener('click', () => {
    if (!game) return;
    if (game.mode === 'ai') { startAiGame(game.aiLevel); return; }
    wsSend({ t: 'rematch', yes: true });
    $('rematch-status').hidden = false;
    $('rematch-status').textContent = t('rematch_wait');
});
// Kept whole, guarded, because the wallet is only away for as long as the ad
// networks are looking. Put the markup back and this wakes up with it; without
// the guard, its absence would throw on boot and take the whole app down.
if ($('wallet-copy')) {
    $('wallet-copy').addEventListener('click', async () => {
        const addr = $('wallet-addr').textContent.trim();
        try {
            await navigator.clipboard.writeText(addr);
        } catch {
            // older browsers / no clipboard permission — select it so it can be copied by hand
            const r = document.createRange();
            r.selectNodeContents($('wallet-addr'));
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
        }
        const b = $('wallet-copy');
        b.textContent = t('copied');
        setTimeout(() => { b.textContent = t('copy'); }, 2000);
    });
}


$('btn-to-menu').addEventListener('click', () => {
    if (game?.mode === 'online') wsSend({ t: 'rematch', yes: false });
    portalHideInvite();
    portalRoom('', false);
    /* Leaving the room ends the call. Deliberately not done at game over: the
       result screen and the rematch offer are exactly when friends talk, and
       cutting the microphone the instant somebody wins would feel like a bug.
       leave() announces it, so the other end updates rather than waiting on a
       peer that is never coming back. */
    voice?.leave();
    wsSend({ t: 'leave_room' });
    stopReplay();
    game = null; // history goes with it — nothing is kept
    $('overlay-gameover').hidden = true;
    show('screen-home');
});

/* ================= replay of the finished game ================= */
let replay = null; // { idx, timer, playing, savedState }

function renderReplayFrame() {
    if (!replay || !game) return;
    const last = game.history.length - 1;
    replay.idx = Math.max(0, Math.min(last, replay.idx));
    game.state = cloneState(game.history[replay.idx]);
    game._wallsRendered = game.state.walls.length; // no pop-in flicker while scrubbing
    renderGame();
    $('turn-banner').textContent = t('replay_move') + ' ' + replay.idx + '/' + last;
    $('rp-count').textContent = replay.idx + '/' + last;
    $('rp-fill').style.width = (last ? (replay.idx / last * 100) : 0) + '%';
    $('rp-play').textContent = replay.playing ? '⏸' : '▶';
}

function replayTick() {
    if (!replay) return;
    const last = game.history.length - 1;
    if (replay.idx >= last) { replay.playing = false; renderReplayFrame(); return; }
    replay.idx++;
    renderReplayFrame();
    tick(replay.idx % 2 === 0); // soft click on each step
}

function playReplay(on) {
    if (!replay) return;
    clearInterval(replay.timer);
    replay.playing = on;
    if (on) {
        if (replay.idx >= game.history.length - 1) replay.idx = 0; // restart from the top
        renderReplayFrame();
        replay.timer = setInterval(replayTick, 750);
    }
    renderReplayFrame();
}

function startReplay() {
    if (!game || !game.history || game.history.length < 2) return;
    replay = { idx: 0, timer: null, playing: false, savedState: game.state };
    $('overlay-gameover').hidden = true;
    $('replay-bar').hidden = false;
    playReplay(true);
}

function stopReplay() {
    if (!replay) return;
    clearInterval(replay.timer);
    if (game) game.state = replay.savedState; // put the final position back
    replay = null;
    $('replay-bar').hidden = true;
}

$('btn-replay').addEventListener('click', startReplay);
$('rp-close').addEventListener('click', () => {
    stopReplay();
    $('overlay-gameover').hidden = false; // back to the win/lose screen
});
$('rp-play').addEventListener('click', () => playReplay(!replay?.playing));
$('rp-start').addEventListener('click', () => { if (replay) { playReplay(false); replay.idx = 0; renderReplayFrame(); } });
$('rp-prev').addEventListener('click', () => { if (replay) { playReplay(false); replay.idx--; renderReplayFrame(); } });
$('rp-next').addEventListener('click', () => { if (replay) { playReplay(false); replay.idx++; renderReplayFrame(); } });

/* resign */
$('btn-resign').addEventListener('click', () => { if (game && !game.over) $('overlay-resign').hidden = false; });
$('btn-resign-no').addEventListener('click', () => { $('overlay-resign').hidden = true; });
$('btn-resign-yes').addEventListener('click', () => {
    $('overlay-resign').hidden = true;
    if (!game || game.over) return;
    if (game.mode === 'online') wsSend({ t: 'resign' });
    else onGameOver(false, 'resign');
});

/* ================= voice (friend rooms only) =================

   Built lazily, on the first friend game, so that a player who never opens a
   private room never constructs an RTCPeerConnection and is never anywhere near
   a microphone permission prompt. */
let voice = null;

function ensureVoice() {
    if (voice) return voice;
    voice = createVoice({
        send: (m) => wsSend({ t: 'rtc', ...m }),
        onChange: renderVoice,
        iceServers: config?.ice || [],
    });
    return voice;
}

/* Show the control only when the SERVER said this room may carry voice.
   game_start carries `voice: true` for private rooms; deciding it here from
   `ranked` would put a permission in the hands of the client. */
function setupVoice(msg) {
    const allowed = msg.voice === true && voiceSupported();
    $('voice-row').hidden = !allowed;
    if (!allowed) { voice?.stop(); return; }
    ensureVoice().setSide(msg.you);
    renderVoice({ state: 'off', muted: true, peerIn: false, peerMuted: true });
}

function renderVoice(v) {
    const btn = $('btn-voice');
    const label = $('voice-label');
    const peer = $('voice-peer');

    btn.classList.toggle('live', v.state === 'live' && !v.muted);
    btn.classList.toggle('muted', v.state === 'live' && v.muted);
    btn.classList.toggle('busy', v.state === 'asking' || v.state === 'connecting');
    btn.disabled = v.state === 'asking' || v.state === 'unsupported';
    $('btn-voice-leave').hidden = v.state === 'off' || v.state === 'unsupported';

    label.textContent = {
        off: t('voice_join'),
        asking: t('voice_asking'),
        waiting: t('voice_waiting'),
        connecting: t('voice_connecting'),
        denied: t('voice_denied'),
        failed: t('voice_failed'),
        unsupported: t('voice_unsupported'),
        live: v.muted ? t('voice_muted') : t('voice_live'),
    }[v.state] || '';

    // What the other end is doing. Silence here is ambiguous — "is my friend
    // not talking, or not in the call at all?" — so it is always stated.
    peer.textContent = v.state === 'off' ? ''
        : !v.peerIn ? t('voice_peer_out')
            : v.peerMuted ? t('voice_peer_muted') : t('voice_peer_live');
}

$('btn-voice').addEventListener('click', () => {
    const v = ensureVoice();
    if (v.state === 'live') v.toggleMute();
    else v.join();
});

$('btn-voice-leave').addEventListener('click', () => ensureVoice().leave());

/* ================= emoji ================= */
let emojiTimer = null;
document.querySelectorAll('#emoji-bar button').forEach(b =>
    b.addEventListener('click', () => {
        if (game?.mode === 'online') wsSend({ t: 'emoji', e: b.dataset.emoji });
        showEmoji(b.dataset.emoji, true);
    }));

function showEmoji(e, mine = false) {
    const pop = $('emoji-pop');
    pop.textContent = e;
    pop.style.right = mine ? '' : '8px';
    pop.style.left = mine ? '8px' : '';
    pop.style.top = mine ? '' : '8px';
    pop.style.bottom = mine ? '8px' : '';
    pop.hidden = false;
    clearTimeout(emojiTimer);
    emojiTimer = setTimeout(() => { pop.hidden = true; }, 1800);
}

/* ================= leaderboard ================= */
/* The table as it was the last time it could be fetched.

   Offline this used to say "error, try again", which is true and useless: the
   player is on a train and cannot try anything. Yesterday's standings are
   worth far more than an apology, so long as they are labelled as yesterday's
   rather than passed off as live. */
const LB_CACHE = 'wr_lb';

async function loadLeaderboard() {
    const list = $('lb-list');
    try {
        const res = await fetch('/api/leaderboard');
        const { rows } = await res.json();
        if (rows?.length) {
            try { localStorage.setItem(LB_CACHE, JSON.stringify({ at: Date.now(), rows })); } catch { }
        }
        renderLeaderboard(rows, 0);
    } catch {
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem(LB_CACHE) || 'null'); } catch { }
        if (cached?.rows?.length) renderLeaderboard(cached.rows, cached.at);
        else list.innerHTML = `<div class="lb-empty">${t(navigator.onLine ? 'err_generic' : 'offline_bar')}</div>`;
    }
}

// `savedAt` marks the list as a copy: 0 means it came from the server just now.
function renderLeaderboard(rows, savedAt) {
    const list = $('lb-list');
    list.innerHTML = '';
    if (!rows?.length) {
        list.innerHTML = `<div class="lb-empty">${t('leaderboard_empty')}</div>`;
        return;
    }
    if (savedAt) {
        const p = document.createElement('p');
        p.className = 'lb-stale';
        p.textContent = t('lb_stale').replace('%t', new Date(savedAt).toLocaleString());
        list.appendChild(p);
    }
    {
        rows.forEach((row, i) => {
            const el = document.createElement('div');
            el.className = 'lb-item';
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
            el.innerHTML = `<div class="lb-rank"></div><div class="r-avatar"></div>
        <div class="lb-nick"></div>
        <div class="lb-score"><b></b><small></small></div>`;
            const pts = row.points || 0;
            el.querySelector('.lb-rank').textContent = medal;
            el.querySelector('.r-avatar').textContent = (row.nick || '?')[0].toUpperCase();
            el.querySelector('.lb-nick').innerHTML =
                `<span class="lb-name"></span><small class="lb-badge"></small>`;
            // The badge rides with the name, so it is on show to everyone who
            // opens the table — not only to whoever this player is beating.
            setNickWithBadge(el.querySelector('.lb-name'), row.nick, row.badge || DEFAULT_BADGE);
            el.querySelector('.lb-badge').textContent = rankChip(pts);
            el.querySelector('.lb-score b').textContent = pts.toLocaleString();
            el.querySelector('.lb-score small').textContent =
                `${t('points_label')} · ${row.wins} ${t('lb_wins')}`;
            list.appendChild(el);
        });
    }
}

/* ================= profile & auth ================= */
function updateProfileUI() {
    const nick = myNick();
    setNickWithBadge($('profile-nick'), nick, resolveBadge(myBadge, myPlus));
    /* The avatar shows the pawn the player chose, so the profile answers "what
       do I look like to everybody else" in one glance — which is the question
       the whole appearance box exists to answer. It falls back to the initial
       when the classic pawn is in use, since that has no colour of its own
       until a seat is assigned. */
    const skin = resolveSkin(mySkin, myPlus);
    const av = $('profile-avatar');
    const usePixel = skin === 'photo' && isPhoto(myPixel);
    av.className = 'avatar' + (skin !== DEFAULT_SKIN && !usePixel ? ' skin-' + skin : '');
    av.style.backgroundImage = usePixel ? photoURL(myPixel) : '';
    av.textContent = (skin === DEFAULT_SKIN && !usePixel) ? nick[0].toUpperCase() : '';
    renderRankCard();
    const wins = profile?.wins || 0, losses = profile?.losses || 0;
    $('stat-games').textContent = wins + losses;
    $('stat-wins').textContent = wins;
    $('stat-losses').textContent = losses;
    $('stat-rate').textContent = (wins + losses) > 0 ? Math.round(100 * wins / (wins + losses)) + '%' : '—';
    $('theme-toggle').checked = localStorage.getItem('wr_theme') === 'dark';
    const logged = Boolean(session && profile);
    $('guest-hint').hidden = logged;
    $('auth-buttons').hidden = logged; // always visible for guests, even if auth is broken —
    // tapping then explains WHY it is unavailable
    $('logged-box').hidden = !logged;
    $('vibro-toggle').checked = vibroOn;
    $('sound-toggle').checked = soundOn;
}

/* ================= streak ================= */
// Russian needs three plural forms and Turkish none, so the unit and the
// sentence shape both come from the language pack.
function daysWord(n) {
    if (lang === 'ru') {
        const a = n % 10, b = n % 100;
        if (a === 1 && b !== 11) return t('day_one');
        if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return t('day_few');
        return t('day_many');
    }
    return n === 1 ? t('day_one') : t('day_many');
}

// %n is the number and %u the unit, both filled per language: word order
// differs (Turkish leads with "üst üste") and Russian inflects the unit.
const daysPhrase = (n, key = 'streak_days') =>
    t(key).replace('%n', n).replace('%u', daysWord(n));

// The flame in the home header: the one place a returning player sees it
// before they have done anything.
/* ---------- appearance ---------- */

function cosSave() {
    localStorage.setItem('wr_skin', mySkin);
    localStorage.setItem('wr_badge', myBadge);
    localStorage.setItem('wr_pack', myPack);
    localStorage.setItem('wr_finish', myFinish);
    if (myPixel) localStorage.setItem('wr_pixel', myPixel);
    /* Re-introduce ourselves rather than inventing a "cosmetics changed"
       message. hello already carries the whole identity and the server already
       resolves it against the account; a second path would be a second place
       to forget when a skin is added. */
    wsSend(helloMsg(session?.access_token));
    renderCosmetics();
    // The profile is the screen the picker sits on: the avatar and the badge
    // beside the nickname have to move with the choice, or the player has to
    // leave and come back to find out what they picked.
    updateProfileUI();
    if (game) renderGame();
}

function cosSwatch(id, isBadge, chosen, locked) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cos-swatch' + (isBadge ? ' cos-badge' : ' skin-' + id)
        + (chosen ? ' on' : '') + (locked ? ' locked' : '');
    if (isBadge) b.textContent = BADGE_GLYPH[id] || '·';
    // The ids are not translated, but they are all a screen reader has here.
    b.setAttribute('aria-label', id);
    b.setAttribute('aria-pressed', String(chosen));
    return b;
}

function renderCosmetics() {
    const skinBox = $('skin-grid'), badgeBox = $('badge-grid');
    if (!skinBox || !badgeBox) return;

    skinBox.textContent = '';
    for (const s of SKINS) {
        const locked = !s.free && !myPlus;
        const el = cosSwatch(s.id, false, s.id === mySkin, locked);
        // The photo swatch shows the photo, once there is one to show.
        if (s.id === 'photo' && isPhoto(myPixel)) el.style.backgroundImage = photoURL(myPixel);
        el.addEventListener('click', () => {
            if (locked) return toast(t('plus_locked'));
            // Choosing the photo swatch with no photo yet means "pick one".
            if (s.id === 'photo' && !isPhoto(myPixel)) return $('pixel-file').click();
            mySkin = s.id;
            cosSave();
        });
        skinBox.appendChild(el);
    }

    badgeBox.textContent = '';
    for (const b of BADGES) {
        const locked = !b.free && !myPlus;
        const el = cosSwatch(b.id, true, b.id === myBadge, locked);
        el.addEventListener('click', () => {
            if (locked) return toast(t('plus_locked'));
            myBadge = b.id;
            cosSave();
        });
        badgeBox.appendChild(el);
    }

    const packBox = $('pack-grid');
    if (!packBox) return;
    packBox.textContent = '';
    for (const p of PACKS) {
        const locked = !p.free && !myPlus;
        const el = cosSwatch(p.id, true, p.id === myPack, locked);
        el.textContent = PACK_GLYPH[p.id] || '·';
        el.addEventListener('click', () => {
            if (locked) {
                /* Play it anyway before refusing. Hearing the drums once is a
                   far better argument for buying them than a padlock is, and
                   there is nothing to protect: the sound is a few lines of
                   code that already shipped to this browser. */
                previewPack(p.id);
                return toast(t('plus_locked'));
            }
            myPack = p.id;
            cosSave();
            previewPack(p.id);
        });
        packBox.appendChild(el);
    }

    const finBox = $('finish-grid');
    if (!finBox) return;
    finBox.textContent = '';
    for (const f of FINISHES) {
        const locked = !f.free && !myPlus;
        const el = cosSwatch(f.id, true, f.id === myFinish, locked);
        el.textContent = FINISH_GLYPH[f.id] || '·';
        // Ringed in the colour it actually plays in, so the picker does not
        // reduce five different animations to five emoji.
        el.style.boxShadow = 'inset 0 0 0 2px ' + (FINISH_TINT[f.id] || 'transparent');
        el.addEventListener('click', () => {
            // Same reasoning as the sound packs: show it, then refuse. This one
            // is the whole reason to buy, and it costs nothing to demonstrate.
            previewFinish(f.id);
            if (locked) return toast(t('plus_locked'));
            myFinish = f.id;
            cosSave();
        });
        finBox.appendChild(el);
    }
}

const PACK_GLYPH = { wood: '🪵', neon: '🎛️', fire: '🔥', ice: '❄️', drum: '🥁' };

// Played inside the appearance box rather than over the whole screen: it has to
// be obviously a preview, and the box is already the right shape for it.
function previewFinish(id) {
    const host = document.querySelector('.cosmetics-box');
    if (!host) return;
    playFinish(host, id, { glyph: BADGE_GLYPH[resolveBadge(myBadge, myPlus)] || '🏆' });
    if (id !== DEFAULT_FINISH) victorySound(resolvePack(myPack, myPlus));
}

// A move and then a wall, spaced the way they fall in a real game.
function previewPack(id) {
    if (!soundOn || portalMute) return;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        playMove(audioCtx, id, { wall: false, mine: true });
        setTimeout(() => playMove(audioCtx, id, { wall: true, mine: true }), 220);
    } catch { /* no audio — the picker still works */ }
}

/* A photo reduced to twelve colours on a twelve-square grid.

   Nothing is uploaded. The file is decoded in the page, drawn into a canvas at
   12x12, and only the resulting couple of hundred characters ever go anywhere
   — which is why this needs no image hosting, and why a face at this size is
   its own moderation. */
async function encodePhoto(file) {
    const bitmap = await createImageBitmap(file);
    const cv = document.createElement('canvas');
    cv.width = cv.height = PHOTO_SIDE;
    const ctx = cv.getContext('2d');
    // Centre-crop to a square: a face cropped beats a face with bars round it.
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap,
        (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
        0, 0, PHOTO_SIDE, PHOTO_SIDE);
    bitmap.close?.();

    /* WebP where the browser can encode it, JPEG where it cannot. toDataURL
       does NOT throw on a format it does not support — it quietly returns a
       PNG instead, and a PNG of a photograph is several times the size of
       either. So the test is on what came back, never on what was asked for.

       Then quality steps down until it fits the budget. A single pass at a
       fixed quality is what produces the occasional 40 KB pawn from a busy
       picture: the weight of a compressed photograph depends on the
       photograph, so the loop has to look. */
    const encode = (type, q) => {
        const url = cv.toDataURL(type, q);
        return url.startsWith('data:' + type) ? url : null;
    };
    const type = encode('image/webp', 0.8) ? 'image/webp' : 'image/jpeg';

    for (const q of [0.82, 0.7, 0.6, 0.5, 0.4]) {
        const out = encode(type, q) || cv.toDataURL('image/jpeg', q);
        if (out.length <= PHOTO_MAX_CHARS) return out;
    }

    /* Still over budget at the lowest quality, which a very noisy image can
       manage. Halve the size rather than refuse: every exit from here that is
       not an image is a player who paid for this and did not get it. */
    const small = document.createElement('canvas');
    small.width = small.height = PHOTO_SIDE / 2;
    small.getContext('2d').drawImage(cv, 0, 0, small.width, small.height);
    return small.toDataURL('image/jpeg', 0.6);
}

$('btn-pixel').addEventListener('click', () => {
    if (!myPlus) return toast(t('plus_locked'));
    $('pixel-file').click();
});

$('pixel-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';        // so picking the same file twice still fires
    if (!file || !myPlus) return;
    try {
        myPixel = await encodePhoto(file);
        mySkin = 'photo';
        cosSave();
    } catch { toast(t('err_generic')); }
});

function renderStreak() {
    const pill = $('streak-pill');
    // The flame always carries the number, alive or broken. It is the streak
    // itself — vanishing would read as the count being lost. Only the offer
    // behind it has a minimum, so a one-day streak still shows 1 and simply has
    // nothing to tap.
    const days = myStreak > 0 ? myStreak : myStreakBroken;
    pill.hidden = days < 1;
    pill.classList.toggle('broken', myStreak < 1 && days > 0);
    if (days < 1) return;
    $('streak-count').textContent = days;
    const lit = myStreak > 0 && myStreakState === 'today';
    $('streak-flame').className = 'flame ' + flameClass(days) + (lit ? '' : ' unlit');
}

// What the flame offers back, or 0 when there is nothing worth offering.
function restorable() {
    return myStreakLost >= MIN_RESTORE_DAYS ? myStreakLost : 0;
}

/* ---------- the flame, explained ---------- */
// Everything the streak does lives behind the flame itself, on both screens.
// Before this the rules only surfaced once a streak had already broken, so the
// players actually keeping one — the ones the flame is for — never saw them.
function streakShownDays() {
    return Math.max(1, myStreak > 0 ? myStreak : myStreakBroken);
}

// The ladder of tiers, with the one currently in force marked. Built on every
// open because the language, the streak and the tier can all have moved since.
function renderFlameLadder() {
    const box = $('info-flames');
    const mine = flameClass(streakShownDays());
    box.innerHTML = '';
    FLAMES.forEach((f, i) => {
        const next = FLAMES[i + 1];
        const li = document.createElement('li');
        if (f.cls === mine) li.className = 'now';
        const icon = document.createElement('span');
        icon.className = 'flame ' + f.cls;
        icon.textContent = '🔥';
        const label = document.createElement('span');
        // plain numbers, so the range needs no translating in six languages
        label.textContent = next ? `${f.min}–${next.min - 1}` : `${f.min}+`;
        li.append(icon, label);
        box.appendChild(li);
    });
}

function openStreakInfo() {
    const days = streakShownDays();
    const broken = myStreak < 1 && myStreakBroken > 0;
    const lit = myStreak > 0 && myStreakState === 'today';
    $('info-flame').className = 'flame ' + flameClass(days) + (lit ? '' : ' unlit') + ' cel-flame';
    $('info-title').textContent = broken ? daysPhrase(myStreakBroken, 'streak_lost')
        : myStreak > 0 ? daysPhrase(myStreak) : t('streak_none');
    $('info-sub').textContent = broken ? t('streak_lost_sub')
        : myStreak > 0 ? (lit ? t('streak_keep') : t('streak_today')) : '';

    const btn = $('btn-restore-home');
    btn.hidden = !restorable();
    btn.disabled = false;
    if (restorable()) btn.textContent = daysPhrase(myStreakLost, 'streak_restore');

    // One free restore per calendar month, counted the way a player expects to
    // read it: what is left over what they get.
    $('info-free').textContent = (myStreakFree ? 1 : 0) + '/1';
    renderFlameLadder();
    $('info-milestones').textContent = MILESTONES.join('  ·  ');
    $('overlay-streak-info').hidden = false;
}

for (const id of ['streak-pill', 'streak-flame-btn']) {
    $(id).addEventListener('click', openStreakInfo);
}
$('btn-info-close').addEventListener('click', () => { $('overlay-streak-info').hidden = true; });
$('overlay-streak-info').addEventListener('click', (e) => {
    if (e.target === $('overlay-streak-info')) $('overlay-streak-info').hidden = true;
});

// One line on the result screen — and on a milestone day, a celebration over
// the top of it. A week of coming back should not pass as one more grey line.
function showStreakLine() {
    const el = $('streak-line');
    if (!streakEvent) { el.hidden = true; return; }
    const { days, froze } = streakEvent;
    el.className = 'streak-line ' + flameClass(days);
    el.textContent = (froze ? t('streak_saved') + ' ' : '') + '🔥 ' + daysPhrase(days);
    el.hidden = false;
    if (isMilestone(days)) celebrateStreak(days);
}

/* The streak card, in whichever of its states applies. Four days showing after
   a missed day is what made this necessary: the number had not changed, the
   game said nothing, and the only sane conclusion was that it was broken. Now
   each state says out loud what happened and what it costs. */
function renderStreakCard() {
    const flame = $('streak-flame-big');
    const sub = $('streak-sub');
    const restore = $('btn-restore-streak');

    // The offer stands on its own: a player who already started a new run sees
    // that run on the card and the old one waiting on the button beneath it.
    restore.hidden = !restorable();
    if (restorable()) restore.textContent = daysPhrase(myStreakLost, 'streak_restore');

    /* Not gated on restorable(): a break too short to sell back is still a
       break, and the card should say so rather than silently showing "no
       streak yet" to somebody who had one yesterday. The offer above appears
       separately, or not at all. */
    if (myStreak < 1 && myStreakBroken > 0) {
        flame.className = 'flame ' + flameClass(myStreakBroken) + ' unlit';
        $('streak-days').textContent = daysPhrase(myStreakBroken, 'streak_lost');
        sub.textContent = t('streak_lost_sub');
        $('streak-card').classList.add('cold');
        return;
    }

    const lit = myStreak > 0 && myStreakState === 'today';
    flame.className = 'flame ' + flameClass(Math.max(1, myStreak)) + (lit ? '' : ' unlit');
    $('streak-days').textContent = myStreak > 0 ? daysPhrase(myStreak) : t('streak_none');
    // What the player has to do today outranks the personal best — the record
    // can wait until the day is safe.
    sub.textContent = myStreak > 0
        ? (myStreakState === 'risk' ? t('streak_today')
            : myStreakBest > myStreak ? t('streak_best').replace('%n', myStreakBest)
                : t('streak_keep'))
        : '';
    $('streak-card').classList.toggle('cold', myStreak < 1);
}

/* Buying a streak back. The ad plays first and the streak is restored only
   after it actually rendered — otherwise everyone whose ad never arrives, and
   that is a good part of this audience, would pay nothing and get it anyway,
   which makes the whole offer meaningless. */
// Both buttons do the same thing, so they share one handler.
for (const id of ['btn-restore-streak', 'btn-restore-home']) {
    $(id).addEventListener('click', () => startRestore());
}

/* One button, one outcome: the streak comes back. What happens underneath
   differs — this month's first restore is free, the rest play an ad first —
   but the player is never told which, because from their side nothing about
   the button changed. If the ad never arrives, which is the normal case for a
   good part of this audience, the streak is given anyway rather than held to
   ransom over something they cannot control. */
/* The streak comes back, full stop.

   This used to fork three ways — the portal's rewarded video, our own network's
   video, or a free monthly restore — and every branch that was not the free one
   ended up granting the streak anyway, because an ad that never arrives could
   not be allowed to cost somebody their nine days. With no ads at all, the
   fallback IS the behaviour, and what is left is the line that was doing the
   work the whole time.

   The server still enforces the one-free-restore-a-month rule, so this is not
   an unlimited undo button — /api/streak/restore answers no_free_restore when
   the month's restore is spent. */
function startRestore() {
    $('btn-restore-streak').disabled = true;
    $('btn-restore-home').disabled = true;
    claimStreak();
}

async function claimStreak() {
    try {
        const res = await fetch('/api/streak/restore', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({ device: deviceId, tz: new Date().getTimezoneOffset() }),
        });
        const data = await res.json();
        if (!data.ok) {
            $('btn-restore-streak').disabled = false;
            $('btn-restore-home').disabled = false;
            return;
        }
        myStreak = data.streak || myStreakLost;
        myStreakState = 'today';     // the day is closed; playing is optional now
        myStreakToday = true;
        myStreakBroken = 0;
        myStreakLost = 0;
        myStreakFree = false;
        closeAdOverlay();
        renderStreak();
        renderStreakCard();
        renderStreakOffer();
        toast(t('streak_restored'));
    } catch {
        $('btn-restore-streak').disabled = false;
        $('btn-restore-home').disabled = false;
    }
}

function renderStreakOffer() { $('overlay-streak-info').hidden = true; }

function celebrateStreak(days) {
    if (celebratedDay === days) return;   // already shown for this milestone
    celebratedDay = days;
    $('cel-flame').className = 'flame ' + flameClass(days) + ' cel-flame';
    $('cel-num').textContent = days;
    /* The count, spelled out with its unit — and it has to be built here rather
       than by the blanket data-i18n pass, because that pass copies a string
       into an element and does not know what %n is. The title asked for a key
       that existed in no language pack at all, so the screen showed the key
       itself; the line under it asked for one that did exist and showed a raw
       "%n". Two different ways of printing the plumbing at the player. */
    $('cel-title').textContent = daysPhrase(days, 'streak_wow');
    // sparks are built fresh so they restart their drift every time
    const box = $('streak-sparks');
    box.innerHTML = '';
    for (let i = 0; i < 18; i++) {
        const sp = document.createElement('i');
        sp.style.left = Math.random() * 100 + '%';
        sp.style.animationDuration = (2.6 + Math.random() * 2.4) + 's';
        sp.style.animationDelay = (Math.random() * 1.3) + 's';
        sp.style.opacity = '0';
        box.appendChild(sp);
    }
    $('overlay-streak').hidden = false;
    vibrate([40, 60, 40, 60, 90]);
}

$('cel-close').addEventListener('click', () => { $('overlay-streak').hidden = true; });
// tapping the backdrop closes it too — nobody should have to hunt for the button
$('overlay-streak').addEventListener('click', (e) => {
    if (e.target === $('overlay-streak')) $('overlay-streak').hidden = true;
});

// Rank, points, and how far the next rank is. The bar is the whole point:
// "97 to go" pulls far harder than a bare number.
function renderRankCard() {
    const pts = myPoints;
    const cur = rankOf(pts);
    const next = nextRank(pts);
    $('rank-badge').textContent = cur.icon;
    $('rank-name').textContent = t(cur.key);
    $('rank-points').textContent = `${pts.toLocaleString()} ${t('points_label')}`;
    $('veteran-badge').hidden = !myVeteran;
    // streak card sits under the rank: one is skill, the other is showing up
    renderStreakCard();
    if (next) {
        const span = next.min - cur.min;
        const done = Math.max(0, Math.min(1, (pts - cur.min) / span));
        $('rank-fill').style.width = (done * 100).toFixed(1) + '%';
        $('rank-next').textContent = t('rank_next')
            .replace('%n', (next.min - pts).toLocaleString())
            .replace('%r', t(next.key));
        $('rank-bar').hidden = false;
    } else {
        $('rank-bar').hidden = true;
        $('rank-next').textContent = t('rank_top');
    }
}

// 'forgot' asks for the address to send the letter to; 'reset' is the form the
// letter leads back to, where the new password is typed.
let authMode = 'login'; // 'login' | 'register' | 'nick' | 'forgot' | 'reset'

/* A reset link now arrives as /?reset=<token> from our own mail, instead of
   Supabase's #type=recovery fragment. Read at import time and stripped from the
   address bar immediately: the token is a one-hour password change, and leaving
   it in the URL leaves it in history and in anything the player pastes. */
const RESET_TOKEN = account.takeResetToken();
const CAME_FOR_RECOVERY = Boolean(RESET_TOKEN);

function openAuthForm(mode) {
    authMode = mode;
    // login accepts nick OR email; registration pre-fills a suggested nick
    $('auth-email').placeholder = mode === 'login' ? t('email_or_nick') : t('email');
    if (mode === 'register' && !$('auth-nick').value) {
        /* The name they have been playing under — not a fresh "Player417".
           This field used to run its own little generator, unrelated to the one
           in nick.js, so somebody who had spent an evening as Swift Tiger was
           offered a stranger's name at signup and had to type their own back
           in. Whatever they are called now is the right suggestion. */
        $('auth-nick').value = myNick() || randomNick();
    }
    $('auth-buttons').hidden = true;
    $('auth-form').hidden = false;
    $('auth-msg').hidden = true;
    $('auth-email').hidden = mode === 'nick' || mode === 'reset';
    $('auth-password').hidden = mode === 'nick' || mode === 'forgot';
    $('auth-nick').hidden = mode !== 'register' && mode !== 'nick';
    $('btn-forgot').hidden = mode !== 'login';
    $('btn-auth-toggle').hidden = mode === 'nick' || mode === 'reset' || mode === 'forgot';
    $('btn-auth-submit').textContent =
        mode === 'login' ? t('do_login')
            : mode === 'register' ? t('do_register')
                : mode === 'forgot' ? t('send_reset')
                    : t('save');
    $('btn-auth-toggle').textContent = mode === 'login' ? t('no_account') : t('have_account');
    if (mode === 'forgot') $('auth-email').placeholder = t('email');
    if (mode === 'reset') $('auth-password').placeholder = t('new_password');
}

function closeAuthForm() {
    $('auth-form').hidden = true;
    updateProfileUI();
}

function authMsg(text, ok = false) {
    const el = $('auth-msg');
    el.textContent = text;
    el.className = 'auth-msg' + (ok ? ' ok' : '');
    el.hidden = false;
}

function ensureAuthAvailable() {
    if (config.auth) return true;
    // The server says whether accounts are usable — it is the only side that
    // knows whether the database answered. A guest can still play everything
    // except the ladder, so this is a notice, not a wall.
    toast(t('auth_unavailable'));
    return false;
}
$('btn-show-login').addEventListener('click', () => { if (ensureAuthAvailable()) openAuthForm('login'); });
$('btn-show-register').addEventListener('click', () => { if (ensureAuthAvailable()) openAuthForm('register'); });
$('btn-auth-toggle').addEventListener('click', () => openAuthForm(authMode === 'login' ? 'register' : 'login'));
$('btn-auth-cancel').addEventListener('click', closeAuthForm);

// Only switches the form over — the address is asked for on the next screen.
// It used to read the email box straight away and return in silence when it was
// empty, which looked like a dead button.
$('btn-forgot').addEventListener('click', () => openAuthForm('forgot'));

$('btn-auth-submit').addEventListener('click', async () => {
    if (!config.auth) { ensureAuthAvailable(); return; }
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const nick = $('auth-nick').value.trim();
    try {
        if (authMode === 'forgot') {
            if (!email) { authMsg(t('err_email_bad')); return; }
            const r = await account.startReset(email);
            // The server answers identically for an address it has never seen, so
            // this form cannot be used to find out who has an account here. Only a
            // genuine failure to send is reported, because saying "sent" to that
            // leaves someone waiting on mail that will never arrive.
            if (!r.ok) { authMsg(t(account.authErrorKey(r.error))); return; }
            // With no mail provider configured the server hands the link straight
            // back so the flow can be walked through locally.
            if (r.data.devLink) console.info('reset link (dev only):', r.data.devLink);
            authMsg(t('reset_sent'), true);
            return;
        }
        if (authMode === 'register') {
            // checkNick returns a REASON CODE, and those codes are already the
            // i18n keys ('nick_short', 'nick_taken', …) — so it maps straight to
            // a sentence without a lookup table in between.
            const nickErr = checkNick(nick);
            if (nickErr) { authMsg(t('err_' + nickErr.replace(/^nick_(short|long|chars|spam)$/, 'nick_bad'))); return; }
            // The device carries the guest streak this account inherits.
            const r = await account.register(email, password, nick, deviceId);
            if (!r.ok) { authMsg(t(account.authErrorKey(r.error))); return; }
            session = account.getSession();
            await afterLogin();
        } else if (authMode === 'login') {
            if (!email.includes('@')) { authMsg(t('err_email_bad')); return; }
            const r = await account.login(email, password, deviceId);
            if (!r.ok) { authMsg(t(account.authErrorKey(r.error))); return; }
            session = account.getSession();
            await afterLogin();
        } else if (authMode === 'nick') {
            const nickErr = checkNick(nick);
            if (nickErr) { authMsg(t('err_' + nickErr.replace(/^nick_(short|long|chars|spam)$/, 'nick_bad'))); return; }
            const created = await createProfileReq(nick);
            if (!created) return;
            closeAuthForm();
        } else if (authMode === 'reset') {
            const r = await account.finishReset(RESET_TOKEN, password);
            if (!r.ok) { authMsg(t(account.authErrorKey(r.error))); return; }
            // The reset does not log you in — the token proves you can read the
            // mailbox, not that you know the new password you just typed. Send
            // them through the ordinary login with it.
            authMsg(t('reset_sent'), true);
            openAuthForm('login');
        }
    } catch {
        authMsg(t('err_generic'));
    }
});

/* Registration now takes the nickname with it, so an account always has one and
   the "pick a nick" step never runs. Kept because the form still has that mode
   and a half-removed branch is worse than a stub that says so. */
async function createProfileReq() {
    authMsg(t('err_generic'));
    return false;
}

async function afterLogin() {
    session = account.getSession();
    if (!session) return;
    const data = await account.fetchProfile(new Date().getTimezoneOffset());
    if (!data) {
        // The token expired or the server refused it. account.js has already
        // cleared it; show the login form rather than a profile of nobody.
        session = null;
        profile = null;
        updateProfileUI();
        openAuthForm('login');
        return;
    }
    profile = data;
    // The profile call also returns the streak, so the flame is right the
    // moment the profile opens instead of one WebSocket round-trip later.
    myPoints = data.points || 0;
    myVeteran = Boolean(data.veteran);
    myStreak = data.streak || 0;
    myStreakBest = data.streakBest || 0;
    myStreakToday = Boolean(data.streakToday);
    myStreakState = data.streakState || 'none';
    myStreakBroken = data.streakBroken || 0;
    myStreakLost = data.streakLost || 0;
    myStreakFree = Boolean(data.streakFree);

    closeAuthForm();
    updateProfileUI();
    renderStreak();
    showNickNotice();
    // re-identify on the game server under the account nick
    wsSend(helloMsg(session.access_token));
}

// A nickname that broke the rules was replaced by hand. The player is told
// once, in their own language, and the note is cleared as soon as they read it.
function showNickNotice() {
    const old = profile?.nick_notice;
    if (!old) return;
    $('nick-notice-text').textContent = t('nick_changed_body')
        .replace('%old', old).replace('%new', profile.nick);
    $('overlay-nick-notice').hidden = false;
    profile.nick_notice = null;
    fetch('/api/nick-notice/ack', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch(() => { });
}
$('btn-nick-notice-close').addEventListener('click', () => {
    $('overlay-nick-notice').hidden = true;
});

$('btn-logout').addEventListener('click', async () => {
    account.logout();
    session = null;
    profile = null;
    updateProfileUI();
    wsSend(helloMsg());
});

/* ================= settings ================= */
$('btn-lang').addEventListener('click', () => { $('overlay-lang').hidden = false; });
$('lang-current').addEventListener('click', () => { $('overlay-lang').hidden = false; });
$('lang-close').addEventListener('click', () => { $('overlay-lang').hidden = true; });

$('vibro-toggle').addEventListener('change', (e) => {
    vibroOn = e.target.checked;
    localStorage.setItem('wr_vibro', vibroOn ? '1' : '0');
    if (vibroOn) vibrate(20);
});

$('sound-toggle').addEventListener('change', (e) => {
    soundOn = e.target.checked;
    localStorage.setItem('wr_sound', soundOn ? '1' : '0');
    if (soundOn) tick(true); // preview
});

/* ================= PWA: installable app ================= */
if ('serviceWorker' in navigator) {
    /* Was there already a worker in charge when this page loaded? Read it now,
       before registering — after the new worker calls clients.claim() this
       turns truthy and the answer is lost. */
    const hadWorker = Boolean(navigator.serviceWorker.controller);

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { });
    });

    /* A new worker taking over mid-page means the files it is about to serve
       are not the files this page was built from. Reload once so the player is
       not looking at last week's stylesheet with this week's markup.

       Only when a worker was already controlling the page. On a first visit
       clients.claim() fires this too, and reloading a first-time visitor for no
       reason is its own bug. The flag guards against the reload loop this
       pattern is famous for. */
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadWorker || reloading) return;
        reloading = true;
        window.location.reload();
    });
}

// browsers fire this when the app is installable — show the profile button
// and (like the competitor) a slim banner right on the home screen
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt = e;
    $('install-row').hidden = false;
    // show the banner on every visit/reload (closing only hides it for now)
    if (!runsInstalled()) $('install-banner').hidden = false;
});
async function doInstall() {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => { });
    installEvt = null;
    $('install-row').hidden = true;
    $('install-banner').hidden = true;
}
$('btn-install').addEventListener('click', doInstall);
$('install-banner-go').addEventListener('click', doInstall);
$('install-banner-close').addEventListener('click', () => {
    $('install-banner').hidden = true; // just for this view — returns on next reload
    iosDismissed = true;
});

// iPhone/iPad: Safari never fires beforeinstallprompt, so show a manual hint
// (Share → Add to Home Screen). Only in Safari (other iOS browsers can't do it).
let iosDismissed = false;
function maybeShowIosInstall() {
    const ua = navigator.userAgent;
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const iosSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios|yabrowser|opios/i.test(ua);
    if (iosSafari && !runsInstalled() && !iosDismissed) {
        $('install-banner-go').hidden = true;          // no auto-install button on iOS
        const el = $('install-banner-text');
        el.removeAttribute('data-i18n');               // stop applyI18n from overwriting it
        el.textContent = t('install_ios');
        $('install-banner').hidden = false;
    }
}
maybeShowIosInstall();

/* ================= notifications ================= */
// Permission can be asked exactly once: a refusal is permanent and we cannot
// undo it. So the ask waits until someone has finished three matches — by then
// they have a streak worth protecting, and the prompt reads as useful rather
// than as a website grabbing at them on arrival.
const PUSH_AFTER_GAMES = 3;

function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function subscribePush() {
    if (!pushSupported() || !config?.vapid) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(config.vapid),
        });
        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device: deviceId, sub: sub.toJSON(),
                tz: new Date().getTimezoneOffset(), lang,
            }),
        });
        localStorage.setItem('wr_push', '1');
        return true;
    } catch (e) {
        console.warn('push subscribe failed', e);
        return false;
    }
}

/* Called after every finished match. Shows a question of our own, once, ever.

   It used to fire the browser's permission prompt straight at people. That
   prompt can be shown once in the lifetime of the site — a refusal is final
   and nothing we do afterwards can undo it — so throwing it at everyone spent
   the single chance on the many who were not going to say yes. Our own window
   costs nothing when refused and asks in words a player understands.

   The flag is written the moment the window opens, not when it is answered,
   so reloading the page cannot bring it back. One time and no more. */
async function maybeAskPush() {
    if (!pushSupported() || !config?.vapid) return;
    if (localStorage.getItem('wr_push')) return;          // already subscribed
    if (localStorage.getItem('wr_push_asked')) return;    // asked before, do not nag
    if (Notification.permission === 'denied') return;     // nothing we can do
    const played = Number(localStorage.getItem('wr_games') || 0) + 1;
    localStorage.setItem('wr_games', String(played));
    if (played < PUSH_AFTER_GAMES) return;
    localStorage.setItem('wr_push_asked', '1');
    // Permission already given on another visit: nothing to ask, just finish up.
    if (Notification.permission === 'granted') { subscribePush().then(renderPushRow); return; }
    $('overlay-push').hidden = false;
}

$('btn-push-no').addEventListener('click', () => { $('overlay-push').hidden = true; });
$('btn-push-yes').addEventListener('click', async () => {
    $('overlay-push').hidden = true;
    // Asked inside the tap, which is what makes the browser show its prompt.
    let ok = false;
    try { ok = await Notification.requestPermission() === 'granted'; } catch { ok = false; }
    if (ok) ok = await subscribePush();
    if (ok) toast(t('push_on'));
    renderPushRow();
});

/* ---------- the switch in the profile ---------- */
// The one-time prompt after a third match reaches nobody who tapped past it,
// and a browser will not show it twice. A switch of their own is the only way
// back — and the way in for everyone the prompt caught at a bad moment.
function renderPushRow() {
    const row = $('push-row');
    if (!pushSupported() || !config?.vapid || Notification.permission === 'denied') {
        row.hidden = true;
        return;
    }
    row.hidden = false;
    $('push-toggle').checked = Boolean(localStorage.getItem('wr_push'));
}

$('push-toggle').addEventListener('change', async (e) => {
    const box = e.target;
    if (box.checked) {
        // Asking inside the tap is what makes the browser show the prompt at all.
        box.disabled = true;
        let ok = Notification.permission === 'granted';
        if (!ok) {
            localStorage.setItem('wr_push_asked', '1');
            try { ok = await Notification.requestPermission() === 'granted'; } catch { ok = false; }
        }
        if (ok) ok = await subscribePush();
        box.disabled = false;
        box.checked = ok;
        toast(t(ok ? 'push_on' : 'push_blocked'));
        if (!ok) renderPushRow();          // a refusal hides the row for good
        return;
    }
    localStorage.removeItem('wr_push');
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await fetch('/api/push/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint }),
            });
            await sub.unsubscribe();
        }
    } catch { /* the row is off either way; the server drops dead endpoints */ }
    toast(t('push_off'));
});

/* ================= legal / info pages ================= */

// The documents are stored as plain text so they stay easy to translate, with
// three markers the renderer understands: "## " starts a section heading,
// "• " a list item, and a blank line separates paragraphs. Built with DOM
// nodes rather than innerHTML so the text is never treated as markup.
function renderDoc(target, text) {
    target.textContent = '';
    let list = null;
    const flushList = () => { list = null; };
    for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (!line) { flushList(); continue; }
        if (line.startsWith('## ')) {
            flushList();
            const h = document.createElement('h3');
            h.textContent = line.slice(3);
            target.appendChild(h);
        } else if (line.startsWith('• ')) {
            if (!list) { list = document.createElement('ul'); target.appendChild(list); }
            const li = document.createElement('li');
            li.textContent = line.slice(2);
            list.appendChild(li);
        } else {
            flushList();
            const p = document.createElement('p');
            p.textContent = line;
            target.appendChild(p);
        }
    }
}

/* When Terms and Privacy last changed. Bump it whenever you edit either
   document — the date is the only signal a returning player has that the terms
   they agreed to are not the terms in front of them. ISO so it sorts and so
   toLocaleDateString can render it in whatever language is showing. */
const DOC_UPDATED = '2026-08-17';

document.querySelectorAll('.legal-links a[data-legal]').forEach(a =>
    a.addEventListener('click', () => {
        const p = a.dataset.legal; // rules | help | terms | privacy
        $('legal-title').textContent = t(p + '_title');
        renderDoc($('legal-text'), t(p + '_body'));
        // only the two legal documents carry a revision date
        const dated = p === 'terms' || p === 'privacy';
        $('legal-updated').hidden = !dated;
        // %n was being printed literally — the placeholder was never filled, so
        // the line read "Last updated %n" under both documents.
        if (dated) {
            $('legal-updated').textContent = t('doc_updated').replace('%n',
                new Date(DOC_UPDATED).toLocaleDateString(lang, {
                    year: 'numeric', month: 'long', day: 'numeric',
                }));
        }
        $('overlay-legal').hidden = false;
        $('legal-text').scrollTop = 0;   // only sticks once the dialog is laid out
    }));
$('legal-close').addEventListener('click', () => { $('overlay-legal').hidden = true; });

$('theme-toggle').addEventListener('change', (e) => {
    localStorage.setItem('wr_theme', e.target.checked ? 'dark' : 'light');
    applyTheme();
});

/* ================= boot ================= */
window.addEventListener('resize', () => {
    if (game && currentScreen === 'screen-game') { buildBoard(); cancelWallPreview(); renderGame(); }
});

/* Arriving inside the portal, with their group.

   Their model has a leader and invitees. The leader's game is told to open
   straight into a room — no menu, no settings — and hands the room code back
   to them for the invite button. The invitees launch already carrying that
   code and must land in the same room without touching anything.

   Both cases map onto private rooms, which this game already has: the only
   new part is reading their code instead of ours out of the address bar. */
async function takePortalInvite() {
    if (!inPortal()) return;
    portalLoaded();

    // Their mute switch, now and whenever it is touched.
    portalMute = portalMuted();
    portalOnMute((m) => { portalMute = m; });

    /* A friend pressing Join in their friends drawer while this game is already
       running. Nothing reloads, so the room has to be changed from underneath:
       leave whatever we are in and go to theirs. */
    portalOnJoin((code) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            portalHideInvite();
            wsSend({ t: 'leave_room' });
            wsSend({ t: 'join_code', code });
        } else {
            pendingJoin = code;   // not connected yet: it goes out with the hello
        }
    });

    /* Signed in on CrazyGames, they play under that name. Their requirement,
       and a fair one — friends have to recognise each other across the board.
       Only for a guest: an account of ours already has a name its owner chose. */
    if (!profile) {
        const name = await portalUserName();
        if (name) {
            const clean = name.slice(0, 16);
            if (nickOk(clean)) { guestNick = clean; localStorage.setItem('wr_nick', clean); }
        }
    }

    const code = portalInviteCode();
    if (code) { pendingJoin = String(code).toUpperCase(); return; }
    // no code and told to go straight in: this player is the leader
    if (portalInstant()) pendingPortalRoom = true;
}

function flushPortalRoom() {
    if (!pendingPortalRoom) return;
    pendingPortalRoom = false;
    wsSend({
        t: 'create_room', private: true,
        mode: createCfg.mode, walls: Number(createCfg.walls), time: createCfg.time,
    });
}

async function boot() {
    takeInviteFromUrl();   // read the code before anything can rewrite the URL
    takeQuickFromUrl();
    // Before the socket opens, so an invited player has their room code ready
    // and lands in the room on the first connection rather than the second.
    await initPortal();
    await takePortalInvite();   // the nick it may set has to be in place before hello
    buildLangList();
    await loadLang(lang);            // detected pack, if it is not ru/en
    applyI18n();
    logVisit(false);
    updateProfileUI();
    renderOnlineState();
    connectWs();
    try {
        config = await (await fetch('/api/config')).json();
    } catch { config = { auth: false }; }
    if (config.auth) {
        try {
            // No SDK to download and no client to construct: the session is a
            // token in localStorage, read at import time by account.js.
            if (account.getSession()) {
                session = account.getSession();
                // kept apart so a stumble here cannot swallow the reset form below
                try { await afterLogin(); } catch (e) { console.error('afterLogin failed', e); }
            }
            // A reset link used to land on the ordinary profile because the
            // session it carried was valid, so the password form was never
            // shown. Put it back last, after everything else has painted.
            if (CAME_FOR_RECOVERY) { show('screen-profile'); openAuthForm('reset'); }
        } catch (e) {
            console.error('auth init failed', e);
            config.auth = false;
        }
    }
    updateProfileUI();
}

boot();
