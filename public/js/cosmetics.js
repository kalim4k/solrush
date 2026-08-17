// What a player looks like to their opponent.
//
// One list, imported by the browser and by the server. The server has to know
// it too — it decides whether somebody is allowed to wear what they asked for —
// and a second copy kept in server/ would drift the first time a skin is added.
// This file touches no DOM and imports nothing, so it loads in both.
//
// The rule behind every entry here: it is worth paying for only if the OTHER
// player sees it. A cosmetic nobody else can see is a setting, not a purchase.

/* Pawn skins. `free` ones are available to everyone — enough of them that the
   picker never looks like a locked shop, which is what makes the paid ones read
   as a choice rather than a toll. The id is what goes on the wire and into the
   CSS class, so it must stay stable once anyone owns it. */
export const SKINS = [
  { id: 'classic', free: true },   // the original: red or blue by seat
  { id: 'slate', free: true },
  { id: 'moss', free: true },
  { id: 'amber', free: false },
  { id: 'ember', free: false },
  { id: 'ice', free: false },
  { id: 'violet', free: false },
  { id: 'gold', free: false },
  { id: 'pixel', free: false },    // the player's own photo, reduced to 12x12
];

/* Badges sit next to the nickname. Only one is free, on purpose: the badge is
   the cheapest thing to render and the most visible thing on the screen, so it
   carries most of the reason to buy. */
export const BADGES = [
  { id: 'none', free: true },
  { id: 'flame', free: false },
  { id: 'crown', free: false },
  { id: 'star', free: false },
  { id: 'bolt', free: false },
  { id: 'skull', free: false },
];

export const DEFAULT_SKIN = 'classic';
export const DEFAULT_BADGE = 'none';

const skinById = new Map(SKINS.map((s) => [s.id, s]));
const badgeById = new Map(BADGES.map((b) => [b.id, b]));

export const isFreeSkin = (id) => Boolean(skinById.get(id)?.free);
export const isFreeBadge = (id) => Boolean(badgeById.get(id)?.free);

/* The gate, in one place so the client and the server cannot disagree about it.
   The client calls it to grey out what it may not use; the server calls it to
   decide what actually goes on the board — and the server's answer is the one
   that counts, because the client's copy of `plus` is a value the client sent.

   Anything unknown falls back rather than throwing: an id from a newer build,
   or one somebody typed into a WebSocket frame by hand, should cost the player
   their skin and nothing else. */
export function resolveSkin(id, plus = false) {
  const s = skinById.get(id);
  if (!s) return DEFAULT_SKIN;
  return (s.free || plus) ? s.id : DEFAULT_SKIN;
}

export function resolveBadge(id, plus = false) {
  const b = badgeById.get(id);
  if (!b) return DEFAULT_BADGE;
  return (b.free || plus) ? b.id : DEFAULT_BADGE;
}

/* The pixel pawn is a photo the player chose, reduced in their own browser to a
   grid of palette indices and sent as text — never uploaded. Nothing to host,
   nothing to cache, and no photographs of faces sitting on the server.

   It started at 12x12, chosen so that nothing recognisable could survive: the
   resolution was meant to be the moderation. That was the wrong trade. Nobody
   could recognise THEMSELVES either, and a pawn you cannot be recognised in is
   worthless for the one thing it is for — being seen wearing it. A cosmetic
   that fails to identify its owner is not a cosmetic.

   So 48x48 with sixteen colours: about 2.4 KB of text, sent once when the
   socket opens rather than per move, and a face that reads as that face at the
   size a pawn is actually drawn.

   What that costs: an offensive picture is now legible too. The mitigation is
   not resolution any more, it is accountability — custom pawns are a Plus
   feature, so every one of them belongs to a paying account with an email
   behind it, which is a far better position to act from than an anonymous
   upload would have been.

   Format: "P" + 16 colours as 3-digit hex + 2304 characters indexing them. */
export const PIXEL_SIDE = 48;
export const PIXEL_COLOURS = 16;
const PIXEL_RE = /^P([0-9a-f]{3}){16}[0-9a-f]{2304}$/;

export function isPixelData(s) {
  return typeof s === 'string' && PIXEL_RE.test(s);
}

// Palette first, then the grid, so a reader can decode it in one pass.
export function decodePixel(s) {
  if (!isPixelData(s)) return null;
  const palette = [];
  for (let i = 0; i < PIXEL_COLOURS; i++) {
    const h = s.slice(1 + i * 3, 4 + i * 3);
    palette.push('#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]);
  }
  const grid = s.slice(1 + PIXEL_COLOURS * 3);
  return { palette, grid };
}
