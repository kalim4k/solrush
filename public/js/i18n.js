// Translations.
//
// English is imported statically and is therefore always present. Everything
// else is fetched on demand, because a player who opens the game in French
// should not download five packs they will never read.
//
// A missing key falls back to English rather than rendering blank. This matters
// more than it sounds: every visible string in the app is written by JS into an
// empty element, so a key that resolves to undefined does not look like a
// translation bug — it looks like the button is broken.

import EN from '../lang/en.js';

// Shown in the picker, each written in its own language. A list of languages
// labelled in English is useless to exactly the people who need it.
export const LANGS = [
  { code: 'en', flag: '🇬🇧', native: 'English' },
  { code: 'fr', flag: '🇫🇷', native: 'Français' },
  { code: 'es', flag: '🇪🇸', native: 'Español' },
  { code: 'ru', flag: '🇷🇺', native: 'Русский' },
  { code: 'tr', flag: '🇹🇷', native: 'Türkçe' },
  { code: 'fa', flag: '🇮🇷', native: 'فارسی' },
];

export const LANG_CODES = LANGS.map(l => l.code);

// Right-to-left. Drives document.dir, which flips the whole layout — including
// the board, which is why Persian was worth doing properly rather than not at
// all.
export const RTL = new Set(['fa', 'ar', 'he', 'ur']);

const packs = { en: EN };

/* Which packs exist as files. Anything not listed resolves to English instead
   of a 404 on every boot.

   This list and LANGS above must agree. When they did not, the picker offered
   six languages and four of them silently did nothing: loadLang() returned
   English, setLang() stored the code, and the screen never changed. No error,
   no warning — the feature simply looked broken. If you add a language, add it
   to both; there is a test that fails when they drift apart. */
const AVAILABLE = new Set(['en', 'fr', 'es', 'ru', 'tr', 'fa']);

export function loaded(code) {
  return Boolean(packs[code]);
}

/* Fetches a pack once and remembers it. Never rejects: a failed download
   leaves the app in English, which is a worse experience than the right
   language and a far better one than a screen of blank buttons. */
const inflight = new Map();

export function loadLang(code) {
  if (packs[code]) return Promise.resolve(packs[code]);
  if (!AVAILABLE.has(code)) return Promise.resolve(EN);
  if (inflight.has(code)) return inflight.get(code);

  const p = import(`../lang/${code}.js`)
    .then((mod) => {
      packs[code] = mod.default;
      return packs[code];
    })
    .catch((e) => {
      console.warn(`i18n: pack "${code}" failed to load —`, e.message);
      return EN;
    })
    .finally(() => inflight.delete(code));

  inflight.set(code, p);
  return p;
}

/* Returns the lookup function for a language.

   Deliberately synchronous, and deliberately tolerant. It is called from
   render paths that run on every frame of a countdown, so it cannot await
   anything; and it is called with keys built at runtime, so it must survive
   being handed one that does not exist. */
export function makeT(lang) {
  const pack = packs[lang] || EN;
  return (key) => {
    if (key == null) return '';
    const hit = pack[key];
    if (hit !== undefined) return hit;
    const fallback = EN[key];
    if (fallback !== undefined) return fallback;
    // Loud in development, harmless in production: the key itself is at least
    // readable, and it names the thing that needs translating.
    if (location.hostname === 'localhost') console.warn('i18n: missing key', key, `(${lang})`);
    return key;
  };
}

/* Plural category for a count, in the CJK/Slavic-aware sense the packs need.

   English and French want two forms; Russian wants three, and picks by the
   last digit with an exception for the teens. Returning a CATEGORY rather than
   a string keeps that rule here instead of copied into every pack. */
export function plural(n, lang) {
  const i = Math.abs(Math.trunc(n));
  if (lang === 'ru') {
    const mod10 = i % 10, mod100 = i % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  }
  // French counts 0 as singular; English does not. Both otherwise agree.
  if (lang === 'fr') return i <= 1 ? 'one' : 'many';
  return i === 1 ? 'one' : 'many';
}
