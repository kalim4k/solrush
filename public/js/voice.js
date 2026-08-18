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

/* Two switches, not one sequence.

   The first version had a single button that meant "join", then "unmute", with
   a separate ✕ to leave — and, worse than the taps, JOINING REQUIRED THE
   MICROPHONE. You could not listen to your friend without handing over a
   microphone permission first, because the call was only built after
   getUserMedia returned. Somebody who just wanted to hear had to grant the one
   thing they did not want to grant.

   So the call is now built from a transceiver rather than from a microphone.
   The connection forms with nothing to send, which is enough to receive; the
   microphone, when and if it arrives, is dropped into the sender that is
   already there with replaceTrack(). That call needs no renegotiation, which is
   what makes an independent mic switch possible at all — the alternative is a
   fresh offer/answer round on every toggle, and every one of those is a chance
   for the call to break.

   state   off | asking | waiting | connecting | live   — where the CALL is
   mic     is my microphone open
   speaker am I listening
   error   '' | denied | nomic | failed | unsupported   — kept apart from
           state on purpose: refusing the microphone must not take away the
           ability to listen, and folding the refusal into `state` did exactly
           that. */

export function createVoice({ send, onChange, iceServers = [] }) {
  let pc = null;
  let sender = null;         // the one audio sender, live before any microphone
  let localStream = null;
  let mySide = 0;

  let state = 'off';
  let mic = false;
  let speaker = false;
  let error = '';
  let connected = false;
  let peerIn = false;        // the friend has joined the call
  let peerMic = false;
  // Has the player made a decision about the speaker themselves? Until they
  // have, switching the microphone on is allowed to switch listening on too.
  let speakerTouched = false;
  // Have we told the other seat we are here? Sent exactly once per call.
  let announced = false;
  let makingOffer = false;
  let ignoreOffer = false;

  const polite = () => mySide === POLITE_SIDE;
  const inCall = () => mic || speaker;

  function emit() {
    onChange({ state, mic, speaker, error, peerIn, peerMic });
  }

  function setState(s) {
    if (state === s) return;
    state = s;
    emit();
  }

  // One place decides what the call's state is, from the facts. Every earlier
  // version set it by hand at each call site and drifted: "asking" survived a
  // successful permission prompt because the branch that cleared it only ran
  // when the connection was still being set up.
  function recompute() {
    if (!inCall()) { setState('off'); return; }
    if (connected) { setState('live'); return; }
    setState(peerIn ? 'connecting' : 'waiting');
  }

  function audioEl() {
    return document.getElementById('voice-audio');
  }

  /* The speaker switch is also the user gesture that makes playback legal.
     A phone browser refuses to start audio that no tap asked for, so the
     element is played from inside the click rather than left to autoplay —
     without this the friend's voice arrives and is silently dropped. */
  function applySpeaker() {
    const el = audioEl();
    if (!el) return;
    el.muted = !speaker;
    if (speaker) el.play?.().catch(() => { /* no stream yet — ontrack replays */ });
  }

  /* ---- the connection ---- */

  function makePc() {
    const conn = new RTCPeerConnection({ iceServers });

    conn.onicecandidate = (e) => {
      if (e.candidate) send({ k: 'ice', d: e.candidate.toJSON() });
    };

    /* One audio element, fed whatever the remote side is sending.

       e.streams is EMPTY here, and assuming otherwise cost a silent call.
       addTrack(track, stream) signals a stream id alongside the track, so the
       receiver gets e.streams[0] for free — but this connection is built from
       a transceiver and replaceTrack(), which carries a track and no stream at
       all. `el.srcObject = e.streams[0]` therefore assigned undefined: ICE
       connected, the transceiver read recvonly, audio was genuinely arriving,
       and the element had nothing to play. Every state looked right. */
    conn.ontrack = (e) => {
      const el = audioEl();
      if (!el) return;
      if (el.srcObject?.getTracks().includes(e.track)) return;
      el.srcObject = e.streams[0] || new MediaStream([e.track]);
      applySpeaker();   // the stream may arrive after the switch was thrown
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
      if (conn.connectionState === 'connected') { connected = true; recompute(); }
      if (conn.connectionState === 'failed') {
        /* Usually a network that changed under us — wifi to mobile mid-game.
           An ICE restart re-gathers candidates on the new path without tearing
           the call down. Only the impolite side drives it, or both would. */
        if (!polite()) {
          try { conn.restartIce(); } catch { error = 'failed'; emit(); }
        }
      }
    };

    return conn;
  }

  /* One audio transceiver, created with the connection and before any
     microphone exists.

     This is the hinge of the whole redesign. addTrack() builds a sender out of
     a track, so with no track there is no sender, and with no sender there is
     nothing to receive on either — which is why listening used to require a
     microphone permission. addTransceiver('audio', 'sendrecv') builds the
     sender first and leaves it empty; the m-line is negotiated once, and the
     microphone is later dropped into it with replaceTrack(), which the spec
     guarantees needs no new offer.

     So both switches move without renegotiating anything. That matters more
     than the taps it saves: every renegotiation is a chance for a call to break
     on a network that barely allowed it in the first place. */
  // The connection on its own, with no media plumbing attached. Used on the
  // answering path, where the incoming offer is what decides the m-lines.
  function ensureConn() {
    if (!pc) pc = makePc();
    return pc;
  }

  /* Our side of the call: exactly one audio transceiver, always sendrecv, with
     the microphone dropped into it if there is one.

     Finding the existing transceiver before adding one is not tidiness. The
     answering side reaches this after setRemoteDescription has already created
     a transceiver for the offered m-line; adding another produced a second,
     unassociated one — and since `sender` pointed at THAT, a listener who later
     switched their microphone on was replacing the track on a transceiver that
     was in no session description. They heard fine and were heard by nobody,
     with every state on both screens reading correctly.

     Forcing sendrecv is what keeps both switches free of renegotiation. A
     transceiver created by an incoming offer defaults to recvonly, which would
     lock a listener out of ever speaking without a fresh offer/answer round. */
  async function ensureMedia() {
    ensureConn();
    let tr = pc.getTransceivers().find((t) => t.receiver?.track?.kind === 'audio');
    if (!tr) {
      /* ONLY the side that offers creates the m-line.

         Both sides creating one is the obvious reading of "set up my end", and
         it does not work: the answering side's own transceiver was not matched
         to the offered m-line, so setRemoteDescription built a second one and
         the answer went out as recvonly. The call then ran one way — the
         listener heard everything, the talker heard nothing — with a healthy
         ICE state and a correct-looking screen on both ends.

         The offerer owns the m-line; the answerer adopts whatever the offer
         created, two lines below. One creator, no matching to get wrong. */
      if (polite()) return pc;
      tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    }
    /* Forced sendrecv even when we have nothing to send. A transceiver born
       from an incoming offer defaults to recvonly, which would leave a listener
       unable to ever speak without a fresh offer/answer round — and this whole
       design exists so that neither switch renegotiates anything. */
    try { if (tr.direction !== 'sendrecv') tr.direction = 'sendrecv'; }
    catch { /* an ended transceiver refuses; the next connection rebuilds it */ }
    sender = tr.sender;

    const track = localStream?.getAudioTracks()[0] || null;
    if (mic && track && sender.track !== track) {
      await sender.replaceTrack(track).catch(() => { /* closed under us */ });
    }
    return pc;
  }

  /* Only start negotiating once both sides are actually in the call. Sending an
     offer to somebody who has not joined would connect a one-way microphone,
     which is exactly the thing nobody should be able to do by accident. */
  async function maybeConnect() {
    if (!inCall() || !peerIn) return;
    await ensureMedia();
    recompute();
  }

  /* Announce ourselves once, whichever switch was thrown first.

     `announced` is a flag and not `state === 'off'`, which is what it was and
     which was wrong in one specific case: switching the microphone on sets the
     state to 'asking' while the browser shows its permission prompt, so by the
     time this ran the state was no longer 'off' and the announcement was
     skipped. The friend never heard that this player had joined, and their
     screen sat on "your friend is not in the call" for the rest of a call that
     was otherwise working perfectly in both directions. */
  async function enter() {
    if (!announced) {
      announced = true;
      send({ k: 'on' });
      send({ k: 'mute', d: !mic });
    }
    recompute();
    await maybeConnect();
  }

  /* ---- public surface ---- */

  return {
    get state() { return state; },
    get mic() { return mic; },
    get speaker() { return speaker; },

    setSide(side) { mySide = side; },

    /* The microphone switch. Asks for permission the first time and never
       again in the same session.

       Turning it ON turns the speaker on too, unless the player has already
       turned the speaker off by hand this game. Two switches was the request
       and two switches is what this is — but talking into a call you cannot
       hear is nobody's intention, and making that the default outcome of the
       obvious first tap would have replaced one confusing flow with another. */
    async setMic(on) {
      if (!voiceSupported()) { error = 'unsupported'; emit(); return; }
      if (on === mic) return;

      if (!on) {
        mic = false;
        /* The track is STOPPED, not merely disabled. A disabled track keeps the
           browser's recording indicator lit for the rest of the game, and a
           player looking at a red dot next to a microphone they just switched
           off has every reason to distrust the game. The permission is
           remembered, so switching back on costs no second prompt. */
        await sender?.replaceTrack(null).catch(() => { });
        for (const t of localStream?.getAudioTracks() || []) t.stop();
        localStream = null;
        send({ k: 'mute', d: true });
        if (!speaker) { this.leave(); return; }
        recompute();
        emit();
        return;
      }

      const was = state;
      setState('asking');
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
      } catch (e) {
        // NotAllowedError is a refusal; NotFoundError is a device with no mic.
        error = e?.name === 'NotFoundError' ? 'nomic' : 'denied';
        setState(was);
        /* Deliberately NOT a dead end. The call, if there is one, carries on —
           refusing a microphone is a decision about talking, not about
           listening, and the old code ended both. */
        emit();
        return;
      }

      error = '';
      mic = true;
      if (!speakerTouched) { speaker = true; applySpeaker(); }
      /* enter() only builds the connection once the friend is in it. Calling
         ensurePc() here as well looked harmless and was not: on the offering
         seat it sends an offer to somebody who has not joined, and the other
         browser would build a peer connection out of it without its owner ever
         having switched anything on. */
      await enter();
      send({ k: 'mute', d: false });
      recompute();
      emit();
    },

    /* The speaker switch. Costs no permission and asks for nothing, which is
       the point: hearing your friend should never have had a price. */
    async setSpeaker(on) {
      if (!voiceSupported()) { error = 'unsupported'; emit(); return; }
      if (on === speaker) return;
      speakerTouched = true;
      speaker = on;
      applySpeaker();
      if (on) { await enter(); } else if (!mic) { this.leave(); return; }
      recompute();
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
      sender = null;
      makingOffer = false;
      connected = false;
      announced = false;
      const el = audioEl();
      if (el) { el.srcObject = null; el.muted = true; }
      mic = false;
      speaker = false;
      speakerTouched = false;
      state = 'off';
      emit();
    },

    peerLeft() {
      peerIn = false;
      peerMic = false;
      connected = false;
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
          // `inCall()`, not `localStream`: somebody who is only listening is in
          // the call and has to answer the newcomer too, or a listener and a
          // talker never find each other.
          if (!wasIn && inCall()) { send({ k: 'on' }); send({ k: 'mute', d: !mic }); }
          await maybeConnect();
          emit();
          return;
        }
        if (msg.k === 'off') {
          /* Drop the connection too, not just the flag. A peer that comes back
             needs a fresh offer, and reusing a half-dead RTCPeerConnection is
             how you get a call that reconnects into silence. */
          if (pc) { try { pc.close(); } catch { /* already closed */ } pc = null; }
          sender = null;
          const el = audioEl();
          if (el) el.srcObject = null;
          this.peerLeft();
          recompute();
          return;
        }
        if (msg.k === 'mute') { peerMic = !msg.d; emit(); return; }

        /* Nothing below here builds a connection for somebody who has not
           switched anything on. Without this guard the media half of the call
           is driven entirely by the other seat: an offer arrives, ensurePc()
           obliges, and a player who touched neither switch is holding a live
           RTCPeerConnection. They would still not be sending audio — there is
           no track — but they should not be in the call at all. */
        if (!inCall()) return;

        if (msg.k === 'offer' || msg.k === 'answer') {
          const conn = ensureConn();
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
            /* AFTER the remote offer, never before: the offer is what creates
               the transceiver this adopts, and running it first is what built
               a second, useless one. */
            await ensureMedia();
            await conn.setLocalDescription();
            send({ k: 'answer', d: conn.localDescription.toJSON() });
          }
          return;
        }

        if (msg.k === 'ice') {
          const conn = ensureConn();
          try { await conn.addIceCandidate(msg.d); } catch {
            // A candidate for an offer we chose to ignore is expected.
            if (!ignoreOffer) throw new Error('bad candidate');
          }
        }
      } catch {
        // A failure to negotiate is reported beside the switches, and leaves
        // them where the player put them: they can switch off and try again
        // without first working out what the game did with their choices.
        error = 'failed';
        emit();
      }
    },
  };
}
