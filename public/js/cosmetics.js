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
  { id: 'photo', free: false },    // the player's own picture
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

/* Sound packs. A pack changes what a move and a wall SOUND like, and the
   colour of the flash a wall lands with — one choice rather than a row of
   switches, because what is being sold is an identity, not a mixing desk.

   Whose pack plays is the whole design: yours sounds on your opponent's device
   as well as your own, for your own moves. That is what makes it worth buying —
   a sound only you can hear is a setting. It also stays legible, because each
   player's actions keep a signature of their own instead of the board having
   one voice.

   'wood' is what the game has always sounded like and stays free. Sound itself
   is never sold: a game whose free players are silent feels broken, and free
   players are the opponents the paying ones are here for. */
export const PACKS = [
  { id: 'wood', free: true },
  { id: 'neon', free: false },
  { id: 'fire', free: false },
  { id: 'ice', free: false },
  { id: 'drum', free: false },   // djembé and dundun — the one nobody else has
];

export const DEFAULT_SKIN = 'classic';
export const DEFAULT_BADGE = 'none';
export const DEFAULT_PACK = 'wood';

const skinById = new Map(SKINS.map((s) => [s.id, s]));
const badgeById = new Map(BADGES.map((b) => [b.id, b]));
const packById = new Map(PACKS.map((p) => [p.id, p]));

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

export function resolvePack(id, plus = false) {
  const p = packById.get(id);
  if (!p) return DEFAULT_PACK;
  return (p.free || plus) ? p.id : DEFAULT_PACK;
}

/* The photo pawn is a picture the player chose, shrunk in their own browser and
   carried as a data URL — never uploaded. Nothing to host, nothing to cache,
   and no photograph of anyone's face sitting on a server.

   It went through two wrong shapes before this one. First 12x12 indexed
   colour, on the theory that the resolution could serve as moderation; nobody
   could recognise themselves in it, and a pawn you cannot be recognised in is
   worthless for the only thing it is for. Then 48x48 in sixteen colours, which
   was recognisable and still visibly a mosaic. The player asked for the actual
   picture, and they were right to: the point of wearing your own face is that
   it looks like your face.

   So: a real image, compressed. PHOTO_SIDE square, WebP where the browser can
   encode it and JPEG otherwise, quality tuned down until it fits the budget
   below. A pawn is drawn at roughly 33 CSS pixels, so 128 covers a 3x display
   with room to spare and costs a few kilobytes — comparable to the mosaic it
   replaces, and sent once when the socket opens rather than per move.

   Moderation is accountability, not resolution: the photo pawn is a Plus
   feature, so every picture belongs to a paying account with an email behind
   it. That is a far better position to act from than an anonymous upload. */
export const PHOTO_SIDE = 128;
export const PHOTO_MAX_CHARS = 12_000;      // ~9 KB of image, generously sized

/* Deliberately not a general data-URL check.

   This string is handed to background-image: url(...), so what it may contain
   is a security question, not a formatting one. Three raster types, base64
   only, length capped. SVG is excluded on purpose and must stay excluded: an
   SVG is a document, it can carry script, and "image" in its MIME type is the
   only thing about it that resembles a photograph. */
const PHOTO_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isPhoto(s) {
  return typeof s === 'string' && s.length <= PHOTO_MAX_CHARS && PHOTO_RE.test(s);
}
