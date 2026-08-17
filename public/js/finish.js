// What the board does in the second after somebody wins.
//
// The rule that makes this worth money: the animation belongs to the WINNER and
// plays on BOTH screens. Yours runs on the phone of the person you just beat.
// A celebration only the winner sees is a screensaver.
//
// Everything here is DOM plus CSS keyframes, and every keyframe animates only
// transform and opacity. That is not tidiness — those two are the properties a
// browser can hand to the compositor without asking the main thread to repaint.
// Animate a filter, a box-shadow or a background instead and a cheap Android
// drops to ten frames a second, which is worse than no animation at all: a
// stuttering celebration reads as a phone that cannot run the game.
//
// The durations below are the other half of the design. This plays between the
// last move and the result screen, so every millisecond here is a millisecond
// the loser waits to find out how many points they lost. Hence the cap, and
// hence stop(): a tap anywhere skips straight to the result.

export const FINISH_MS = {
  plain: 0,      // free: nothing happens, the result comes up as it always has
  flare: 1150,
  quake: 950,
  storm: 1350,
  stamp: 1100,
};

// One colour each, and the picker swatch is painted from the same table — so
// what you tap is what the other player will actually see.
export const FINISH_TINT = {
  plain: 'rgba(150, 165, 200, .5)',
  flare: 'rgba(255, 200, 90, .95)',
  quake: 'rgba(255, 110, 90, .95)',
  storm: 'rgba(90, 200, 255, .95)',
  stamp: 'rgba(212, 175, 55, .95)',
};

export const FINISH_GLYPH = { plain: '⚪', flare: '💥', quake: '🌋', storm: '🌧️', stamp: '🏅' };

const reduced = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

/* Play `id` inside `host`, and return how long it will run plus a way to cut it
   short. The caller times the result screen off `ms`, so a finish that decides
   to do nothing simply reports zero and changes no other code path.

   `glyph` is the winner's badge, which is how the stamp ends up being *their*
   stamp rather than a generic trophy. */
export function playFinish(host, id, { glyph = '🏆' } = {}) {
  const stop = () => clear(host);
  if (!host || !FINISH_MS[id] || id === 'plain') { stop(); return { ms: 0, stop }; }

  clear(host);

  const box = document.createElement('div');
  box.className = 'finish fin-' + id;
  box.style.setProperty('--fin', FINISH_TINT[id] || FINISH_TINT.plain);

  /* Reduced motion is honoured, not obeyed to the letter of erasing the moment:
     the setting is about movement, so what survives is a single veil that fades
     in and out. No travel, no spin, no shake — and the loser still learns that
     something belonging to the winner just happened. */
  if (reduced()) {
    box.classList.add('fin-still');
    box.appendChild(el('i', 'fin-veil'));
    host.appendChild(box);
    const ms = 420;
    box._timer = setTimeout(stop, ms);
    return { ms, stop };
  }

  build[id](box, glyph);
  host.appendChild(box);

  /* quake moves the host, not the overlay: the point is that the BOARD takes
     the hit. A transform on the host is still compositor-only, and the wrapper
     is already a positioned ancestor, so nothing inside it shifts relative to
     anything else. */
  if (id === 'quake') {
    host.classList.add('fin-shaking');
    box._host = host;
  }

  const ms = FINISH_MS[id];
  box._timer = setTimeout(stop, ms);
  return { ms, stop };
}

// Wipe whatever is running, without needing the handle back. Starting a new
// game has to do this: a rematch two seconds after a win would otherwise open
// on a board with the last celebration still raining on it.
export const clearFinish = (host) => clear(host);

function clear(host) {
  const old = host?.querySelector(':scope > .finish');
  if (old) {
    clearTimeout(old._timer);
    old._host?.classList.remove('fin-shaking');
    old.remove();
  }
  host?.classList.remove('fin-shaking');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  n.className = cls;
  if (text) n.textContent = text;
  return n;
}

const build = {
  // A shockwave: three rings leaving the middle of the board, one behind the
  // other, over a veil that lifts. The stagger is what makes it read as a blast
  // rather than as a circle growing.
  flare(box) {
    box.appendChild(el('i', 'fin-veil'));
    for (let i = 0; i < 3; i++) {
      const r = el('i', 'fin-ring');
      r.style.animationDelay = (i * 0.13) + 's';
      box.appendChild(r);
    }
  },

  // The impact itself is the host shake (see above); this adds the dust, so
  // that the board looks hit rather than merely wobbly.
  quake(box) {
    box.appendChild(el('i', 'fin-veil'));
    for (let i = 0; i < 10; i++) {
      const d = el('i', 'fin-dust');
      d.style.left = (6 + Math.random() * 88) + '%';
      d.style.animationDelay = (Math.random() * 0.2) + 's';
      d.style.setProperty('--dx', (Math.random() * 40 - 20) + 'px');
      box.appendChild(d);
    }
  },

  // Rain in one colour. Deliberately one colour and not confetti: confetti
  // already means "you won" on the result screen, and this has to read as
  // somebody else's weather arriving on your board.
  storm(box) {
    for (let i = 0; i < 26; i++) {
      const s = el('i', 'fin-drop');
      s.style.left = (Math.random() * 100) + '%';
      s.style.animationDelay = (Math.random() * 0.55) + 's';
      s.style.animationDuration = (0.5 + Math.random() * 0.35) + 's';
      s.style.opacity = (0.4 + Math.random() * 0.6).toFixed(2);
      box.appendChild(s);
    }
  },

  // Their badge, dropped onto the board from above and left sitting there for
  // half a second. The one finish that names its owner.
  stamp(box, glyph) {
    box.appendChild(el('i', 'fin-veil'));
    box.appendChild(el('i', 'fin-ring'));
    box.appendChild(el('span', 'fin-stamp', glyph));
  },
};
