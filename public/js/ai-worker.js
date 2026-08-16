// The AI runs here so the board stays responsive while it thinks. Hardcore
// searches for up to two and a half seconds; on the main thread that is two and
// a half seconds of a frozen page, dropped taps and a stuck wall drag.
//
// One message in, one message out, correlated by id — the caller may have
// several requests alive after a fast rematch, and answering the wrong one puts
// a move from the previous game on the board.

import { aiMove } from './ai.js';

self.onmessage = (e) => {
  const { id, state, level, opts } = e.data || {};
  let move = null;
  try {
    move = aiMove(state, level, opts || {});
  } catch (err) {
    // Answer anyway. The caller's fallback is a four-second timeout, and a
    // silent worker means the player sits watching "opponent thinking" until it
    // fires. A null move is handled; silence is not.
    console.error('ai worker failed', err);
  }
  self.postMessage({ id, move });
};
