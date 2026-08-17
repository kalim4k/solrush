// What a move sounds like.
//
// Every sound here is synthesised at the moment it plays. Nothing is downloaded,
// which is not a purist choice — a set of sample files for five packs is a
// couple of megabytes added to the first load, and the players this is built
// for pay for their data by the megabyte. A pack costs a few hundred bytes of
// code and arrives with the app.
//
// Two rules shaped all of it:
//
//   frequency decides intensity  a pawn moves forty times a game, so its sound
//                                has to be almost nothing or it is unbearable
//                                by move twenty. A wall lands eight or ten
//                                times and can afford some body. Victory
//                                happens once and can be a whole phrase.
//
//   short and quiet              these play on a phone speaker, often in
//                                public. Nothing here runs past a third of a
//                                second, and gains stay under 0.4.
//
// The context and the mute checks live in app.js, which owns the toggle; this
// module is handed a live AudioContext and told what happened.

import { DEFAULT_PACK } from './cosmetics.js';

/* One shared noise buffer, made once. Noise is what turns an oscillator into a
   drum skin or a spark, and generating two seconds of it per hit would allocate
   on the audio thread's doorstep during a move animation. */
let noiseBuf = null;
function noise(ctx) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

// An envelope that starts and ends just above zero, because exponential ramps
// refuse to touch it and a linear release clicks.
function env(ctx, peak, t0, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  return g;
}

function tone(ctx, { type = 'sine', from, to, peak, decay, t0 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t0);
  if (to && to !== from) o.frequency.exponentialRampToValueAtTime(to, t0 + decay);
  const g = env(ctx, peak, t0, decay);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + decay + 0.02);
}

function hit(ctx, { freq, q = 1, peak, decay, t0 }) {
  const src = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = env(ctx, peak, t0, decay);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + decay + 0.02);
}

/* Each pack answers two questions: what does a pawn moving sound like, and what
   does a wall landing sound like. `mine` shifts the pitch up for the player's
   own move — the game has always done this and it is genuinely useful, because
   it tells you whose turn just ended without looking. */
const VOICES = {
  wood: {
    // The original. Kept exactly as it was: this is what the game sounds like.
    pawn: (ctx, t0, mine) =>
      tone(ctx, { type: 'triangle', from: mine ? 660 : 500, peak: 0.22, decay: 0.07, t0 }),
    wall: (ctx, t0, mine) =>
      tone(ctx, { from: mine ? 340 : 270, to: mine ? 180 : 140, peak: 0.3, decay: 0.14, t0 }),
  },

  neon: {
    // Synthwave: a square blip and a saw that falls away underneath it.
    pawn: (ctx, t0, mine) =>
      tone(ctx, { type: 'square', from: mine ? 880 : 700, peak: 0.13, decay: 0.06, t0 }),
    wall: (ctx, t0, mine) => {
      tone(ctx, { type: 'sawtooth', from: mine ? 420 : 340, to: 90, peak: 0.2, decay: 0.18, t0 });
      tone(ctx, { type: 'square', from: mine ? 1200 : 980, peak: 0.07, decay: 0.05, t0 });
    },
  },

  fire: {
    // A spark and a soft thud. Mostly noise, because fire has no pitch.
    pawn: (ctx, t0, mine) =>
      hit(ctx, { freq: mine ? 2600 : 2000, q: 0.9, peak: 0.14, decay: 0.05, t0 }),
    wall: (ctx, t0, mine) => {
      hit(ctx, { freq: 700, q: 0.6, peak: 0.26, decay: 0.16, t0 });
      tone(ctx, { from: mine ? 150 : 120, to: 60, peak: 0.24, decay: 0.18, t0 });
    },
  },

  ice: {
    // Crystal: a high chime, and a wall that cracks then rings.
    pawn: (ctx, t0, mine) =>
      tone(ctx, { from: mine ? 1500 : 1180, peak: 0.13, decay: 0.11, t0 }),
    wall: (ctx, t0, mine) => {
      hit(ctx, { freq: 5200, q: 2, peak: 0.12, decay: 0.06, t0 });
      tone(ctx, { from: mine ? 900 : 760, to: mine ? 500 : 420, peak: 0.2, decay: 0.2, t0 });
    },
  },

  drum: {
    /* Djembé and dundun. The pack nobody else has, and the reason it works is
       that a hand drum is mostly a pitch that falls fast — a short noise burst
       for the slap of the skin, a sine dropping an octave underneath for the
       body. The pawn is a tone (the rim), the wall is a bass (the dundun). */
    pawn: (ctx, t0, mine) => {
      hit(ctx, { freq: mine ? 1800 : 1400, q: 1.2, peak: 0.1, decay: 0.035, t0 });
      tone(ctx, { from: mine ? 420 : 340, to: mine ? 260 : 210, peak: 0.18, decay: 0.09, t0 });
    },
    wall: (ctx, t0, mine) => {
      hit(ctx, { freq: 320, q: 0.8, peak: 0.18, decay: 0.07, t0 });
      tone(ctx, { from: mine ? 130 : 105, to: 52, peak: 0.34, decay: 0.26, t0 });
    },
  },
};

// The colour a wall flashes as it lands, so the pack is seen as well as heard.
// Read straight into a CSS custom property; keep them light enough to sit under
// the wall's own colour rather than replacing it.
export const PACK_TINT = {
  wood: 'rgba(180, 140, 90, .55)',
  neon: 'rgba(120, 90, 255, .6)',
  fire: 'rgba(255, 120, 40, .6)',
  ice: 'rgba(90, 210, 255, .6)',
  drum: 'rgba(225, 160, 60, .6)',
};

// A short pattern for the phone's motor, matched to the sound. Kept brief for
// the same reason the sounds are: it happens on every move.
export const PACK_BUZZ = {
  wood: 12,
  neon: 8,
  fire: [6, 20, 10],
  ice: 6,
  drum: [14, 30, 18],
};

export function playMove(ctx, pack, { wall = false, mine = true } = {}) {
  const voice = VOICES[pack] || VOICES[DEFAULT_PACK];
  const t0 = ctx.currentTime;
  try { (wall ? voice.wall : voice.pawn)(ctx, t0, mine); }
  catch { /* a context that died under us is not worth a broken move */ }
}
