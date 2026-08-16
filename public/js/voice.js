// Voice chat for friend rooms.
//
// The audio never touches our server. Two browsers negotiate a direct
// connection over the WebSocket already open for the game, and the sound then
// travels between them (or through a TURN relay when their networks refuse a
// direct route). Nothing is recorded and nothing is stored.
//
// Why this is a module rather than a lump inside app.js: it is the only part of
// the client with real state machine behaviour — permission, negotiation, ICE,
// renegotiation after a network change — and all of it is driven by callbacks
// rather than the DOM, so it can be reasoned about on its own.
//
// Deliberately NOT here: any decision about *whether* voice is allowed. The
// server sends `voice: true` with game_start for private rooms only, and
// refuses to relay signalling for anything else. This module is told to start;
// it does not decide.

/* Both peers may press the button at the same moment, and both would then send
   an offer — "glare". The usual fix is the perfect-negotiation pattern: one
   side is polite and yields, the other is not. Seat 1 is polite, arbitrarily
   but consistently, because both peers know their own seat from game_start. */
const POLITE_SIDE = 1;

const MIC = {
  // The three that matter on a phone held near a speaker playing the same call.
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export function voiceSupported() {
  return Boolean(
    typeof RTCPeerConnection !== 'undefined'
    && navigator.mediaDevices
    && navigator.mediaDevices.getUserMedia,
  );
}

/* states, in the order a player meets them:
   off        not in the call
   asking     waiting for the browser's microphone prompt
   waiting    we are in, the friend is not yet
   connecting handshake under way
   live       connected; `muted` says whether our microphone is open
   denied     the player refused the microphone, or there isn't one
   failed     could not connect — almost always a NAT that needs TURN
   unsupported  no WebRTC (very old browser, or an insecure origin) */

export function createVoice({ send, onChange, iceServers = [] }) {
  let pc = null;
  let localStream = null;
  let mySide = 0;

  let state = 'off';
  let muted = true;          // joining does not open the microphone. See below.
  let peerIn = false;        // the friend has joined the call
  let peerMuted = true;
  let makingOffer = false;
  let ignoreOffer = false;

  const polite = () => mySide === POLITE_SIDE;

  function emit() {
    onChange({ state, muted, peerIn, peerMuted });
  }

  function setState(s) {
    if (state === s) return;
    state = s;
    emit();
  }

  /* ---- the connection ---- */

  function makePc() {
    const conn = new RTCPeerConnection({ iceServers });

    conn.onicecandidate = (e) => {
      if (e.candidate) send({ k: 'ice', d: e.candidate.toJSON() });
    };

    conn.ontrack = (e) => {
      // One audio element, fed whatever the remote side is sending.
      const el = document.getElementById('voice-audio');
      if (el && el.srcObject !== e.streams[0]) el.srcObject = e.streams[0];
    };

    /* Only one side ever offers.

       Letting both offer is the textbook setup, and it works — until the two
       offers cross, which is exactly what happens here because both players
       press the button at the same moment and both browsers then add their
       tracks at the same moment. Resolving that collision correctly depends on
       an implicit rollback and on which message lands first, and the result was
       a call that connected most of the time. A voice feature that works four
       times in five is worse than one that does not exist, because the player
       blames their microphone.

       So: seat 0 offers, seat 1 answers, always. Both sides still add their own
       tracks — seat 1's travel back in the answer — and there is no collision to
       resolve because there is only ever one offer in flight. The collision
       guard below stays as a belt for renegotiation after an ICE restart. */
    if (!polite()) {
      conn.onnegotiationneeded = async () => {
        // Guarded: setLocalDescription fires this again, and an unguarded
        // handler renegotiates in a loop that looks like a hung call.
        if (makingOffer) return;
        try {
          makingOffer = true;
          await conn.setLocalDescription();
          send({ k: 'offer', d: conn.localDescription.toJSON() });
        } catch {
          /* the connection state handler below reports it */
        } finally {
          makingOffer = false;
        }
      };
    }

    conn.onconnectionstatechange = () => {
      if (conn !== pc) return;
      if (conn.connectionState === 'connected') setState('live');
      if (conn.connectionState === 'failed') {
        /* Usually a network that changed under us — wifi to mobile mid-game.
           An ICE restart re-gathers candidates on the new path without tearing
           the call down. Only the impolite side drives it, or both would. */
        if (!polite()) {
          try { conn.restartIce(); } catch { setState('failed'); }
        }
      }
    };

    return conn;
  }

  async function ensurePc() {
    if (!pc) pc = makePc();
    if (localStream) {
      for (const track of localStream.getTracks()) {
        const already = pc.getSenders().some(s => s.track === track);
        if (!already) pc.addTrack(track, localStream);
      }
    }
    return pc;
  }

  /* Only start negotiating once both sides are actually in the call. Sending an
     offer to somebody who has not joined would connect a one-way microphone,
     which is exactly the thing nobody should be able to do by accident. */
  async function maybeConnect() {
    if (!localStream || !peerIn) return;
    if (state === 'live') return;
    setState('connecting');
    await ensurePc();
  }

  /* ---- public surface ---- */

  return {
    get state() { return state; },
    get muted() { return muted; },

    setSide(side) { mySide = side; },

    /* Join the call.

       The microphone starts CLOSED. It costs one extra tap, and it removes the
       failure that matters: joining a call and not realising you are audible.
       The button then toggles the microphone, so talking is one tap and the
       state is always on screen. */
    async join() {
      if (!voiceSupported()) { setState('unsupported'); return; }
      if (state !== 'off' && state !== 'failed' && state !== 'denied') return;
      setState('asking');
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
      } catch (e) {
        // NotAllowedError is a refusal; NotFoundError is a device with no mic.
        setState(e?.name === 'NotFoundError' ? 'failed' : 'denied');
        return;
      }
      muted = true;
      for (const t of localStream.getAudioTracks()) t.enabled = false;

      setState(peerIn ? 'connecting' : 'waiting');
      send({ k: 'on' });
      send({ k: 'mute', d: true });
      await maybeConnect();
      emit();
    },

    // Leave the call but stay in the game.
    leave() {
      send({ k: 'off' });
      this.stop();
    },

    // Tear everything down without announcing it — used when the game ends or
    // the socket drops, where the other side finds out by other means.
    stop() {
      if (localStream) for (const t of localStream.getTracks()) t.stop();
      localStream = null;
      if (pc) { try { pc.close(); } catch { /* already closed */ } }
      pc = null;
      makingOffer = false;
      const el = document.getElementById('voice-audio');
      if (el) el.srcObject = null;
      muted = true;
      state = 'off';
      emit();
    },

    toggleMute() {
      if (!localStream) return;
      muted = !muted;
      for (const t of localStream.getAudioTracks()) t.enabled = !muted;
      send({ k: 'mute', d: muted });
      emit();
    },

    peerLeft() {
      peerIn = false;
      peerMuted = true;
      emit();
    },

    /* Everything arriving from the other seat, relayed by the server. */
    async handle(msg) {
      try {
        if (msg.k === 'on') {
          /* Answer a newcomer, but only the first time.

             Whoever joins second announces themselves to somebody who is
             already there, so the one already there has to reply or the
             newcomer never learns the call exists. Replying to EVERY 'on'
             makes the two clients bounce the message off each other forever:
             a tight loop of WebSocket traffic that stopped only when the
             server's rate limiter cut it off — and then the limiter, now
             exhausted, silently dropped the mute notice that came next. The
             call connected and the two players could not see each other's
             microphone state. `wasIn` is the whole fix. */
          const wasIn = peerIn;
          peerIn = true;
          if (!wasIn && localStream) { send({ k: 'on' }); send({ k: 'mute', d: muted }); }
          await maybeConnect();
          emit();
          return;
        }
        if (msg.k === 'off') {
          /* Drop the connection too, not just the flag. A peer that comes back
             needs a fresh offer, and reusing a half-dead RTCPeerConnection is
             how you get a call that reconnects into silence. */
          if (pc) { try { pc.close(); } catch { /* already closed */ } pc = null; }
          const el = document.getElementById('voice-audio');
          if (el) el.srcObject = null;
          if (localStream) setState('waiting');
          this.peerLeft();
          return;
        }
        if (msg.k === 'mute') { peerMuted = Boolean(msg.d); emit(); return; }

        if (msg.k === 'offer' || msg.k === 'answer') {
          const conn = await ensurePc();
          const desc = msg.d;

          /* Perfect negotiation. If an offer arrives while we are making our
             own, exactly one side must back down — otherwise both roll back and
             the call never forms. The impolite side ignores the incoming offer;
             the polite side drops its own. */
          const offerCollision = desc.type === 'offer'
            && (makingOffer || conn.signalingState !== 'stable');
          ignoreOffer = !polite() && offerCollision;
          if (ignoreOffer) return;

          await conn.setRemoteDescription(desc);
          if (desc.type === 'offer') {
            await conn.setLocalDescription();
            send({ k: 'answer', d: conn.localDescription.toJSON() });
          }
          return;
        }

        if (msg.k === 'ice') {
          const conn = await ensurePc();
          try { await conn.addIceCandidate(msg.d); } catch {
            // A candidate for an offer we chose to ignore is expected.
            if (!ignoreOffer) throw new Error('bad candidate');
          }
        }
      } catch {
        setState('failed');
      }
    },
  };
}
