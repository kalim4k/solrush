// Nicknames. Imported by the browser AND by the server, on purpose: a rule
// enforced only in the client is not a rule, and a rule enforced only on the
// server shows up as a rejection after the player has already typed the name.

// checkNick returns a REASON CODE when the name is unacceptable, and null when
// it is fine. Truthy means broken — read it as "what is wrong with this?".
export function checkNick(nick) {
  const s = String(nick ?? '').trim();
  if (s.length < 3) return 'nick_short';
  if (s.length > 16) return 'nick_long';

  // Letters from any alphabet, digits, and a few separators. \p{L} rather than
  // A-Z because the game is played in Persian, Russian and Turkish, and a rule
  // written in ASCII tells most of those players their own name is invalid.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(s)) return 'nick_chars';

  // Zero-width and direction-override characters: invisible in the input, and
  // used to forge names that render identically to somebody else's.
  if (/[​-‏‪-‮⁦-⁩﻿]/.test(s)) return 'nick_chars';

  if (/(.)\1{4,}/u.test(s)) return 'nick_spam';        // "aaaaaa"
  if (RESERVED.has(s.toLowerCase())) return 'nick_reserved';
  if (hasSlur(s)) return 'nick_rude';
  return null;
}

export const nickOk = (nick) => checkNick(nick) === null;

// Names that let someone pose as the game itself or as staff.
const RESERVED = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'staff', 'support', 'system',
  'root', 'owner', 'official', 'bot', 'server', 'solrush', 'sol rush',
  'anonymous', 'guest', 'deleted', 'null', 'undefined',
]);

/* A deliberately small list, and only the unambiguous ones.

   A long blocklist here is worse than a short one: it catches Scunthorpe, it
   catches ordinary surnames, and it is wrong in the five other languages this
   game is played in. Anything subtler than this belongs in a report button,
   not in a regex. */
const SLURS = [
  'nigg', 'fagg', 'kike', 'chink', 'spic', 'tranny', 'retard',
  'hitler', 'nazi', 'rape', 'pedo',
];

function hasSlur(s) {
  // Fold the common substitutions first, so "n1gg3r" is caught by "nigg".
  const flat = s.toLowerCase()
    .replace(/[0]/g, 'o').replace(/[1!|]/g, 'i').replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/[7]/g, 't')
    .replace(/[^a-z]/g, '');
  return SLURS.some(w => flat.includes(w));
}

/* Generated names, so a guest is never "User4821".

   Two words and no number: the name has to be sayable, because it is what the
   opponent sees and what gets read aloud when friends play in the same room.
   Collisions are fine — guests are not accounts, and two Swift Foxes in
   different games never meet. */
const ADJECTIVES = [
  'Swift', 'Silent', 'Brave', 'Clever', 'Lucky', 'Iron', 'Rapid', 'Bright',
  'Bold', 'Sly', 'Calm', 'Wild', 'Sharp', 'Noble', 'Quick', 'Steady',
];
const NOUNS = [
  'Fox', 'Wolf', 'Hawk', 'Tiger', 'Falcon', 'Bear', 'Lynx', 'Raven',
  'Otter', 'Panther', 'Heron', 'Ibex', 'Cobra', 'Marten', 'Osprey', 'Shark',
];

export function randomNick() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  for (let i = 0; i < 8; i++) {
    const n = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (nickOk(n)) return n;
  }
  return 'Swift Fox';
}
