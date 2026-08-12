// ---------------------------------------------------------------------------
// The sound engine. One AudioContext and the amp bus (master) live forever.
// Every SOURCE POST on the board owns its own tone generator (strummed
// chord, plucked arpeggio, microtone dyad, live guitar, or silence) and every pedal owns a
// "rig". setChain() wires each complete source->pedals->amp path in
// parallel into the master — several tones at once, mixed at the amps.
//
//   src A: chord ──┐ bus ── rig ── rig ──┐
//                                        ├── master (all amps) ── speakers
//   src B: arp ────┘ bus ───── rig ──────┘
// ---------------------------------------------------------------------------

import { CHORDS, CHORD_GAINS, CHORD_LEVEL, E2 } from './config.js';
import { MODULES, createCabinet, createStrings } from './modules.js';
import { RIFFS, PROGRESSIONS } from './riffs.js';
import { DRUM_PATTERNS, kitFor, renderDrumsStereo, drumBars } from './drums.js';
import { BASS_LINES, BASS_TONES } from './bass.js';

export function createAudio() {
  let ctx = null;     // created on the first user gesture, then permanent
  let master = null;
  let userVolume = null;
  // remembered between sessions, and deliberately quiet on a first visit
  let savedVolume = Math.min(1, Math.max(0,
    Number(localStorage.getItem('masterVolume') ?? 0.5)));
  let speakers = null; // last node before the destination — what you hear
  const transport = { origin: 0, bpm: 100 }; // the shared clock for synced inputs
  let paused = false; // this player has stopped the room; see setPaused()

  function beatSeconds(state) {
    return 60 / (state.sync ? transport.bpm : (state.bpm || 100));
  }
  // Start a loop WHERE THE BAND ALREADY IS, rather than at the next beat.
  //
  // Waiting for a beat boundary looks right and is subtly wrong: the loop then
  // begins at ITS bar one whenever it happened to be built, so an eight-bar
  // kit rebuilt mid-phrase plays its bar one under everyone else's bar three.
  // Worse, a whole-board rebuild (a reconnect, a preset) takes hundreds of
  // milliseconds — long enough to straddle a beat — so the sources scatter
  // across different beats and the band lands out of phase with itself.
  //
  // Seeking into the buffer instead makes both impossible: the offset is read
  // from the shared clock, so a loop is in phase the instant it starts, no
  // matter when that is or how slow the rebuild was.
  function startInPhase(src, spb, synced) {
    if (!synced || !src.buffer) { src.start(); return; }
    const loopBeats = src.buffer.duration / spb;
    const beatsIn = (ctx.currentTime - transport.origin) / spb;
    const phase = ((beatsIn % loopBeats) + loopBeats) % loopBeats; // never negative
    src.start(ctx.currentTime + 0.02, phase * spb);
  }
  const rigs = new Map();     // pedal instanceId -> rig
  const sources = new Map();  // source post id -> { bus, loop, guitar }
  const ampGains = new Map(); // amp post id -> gain (its volume knob)
  const ampCabs = new Map();  // amp post id -> speaker cabinet
  const ampTaps = new Map();  // amp id -> scope tap, for the wave halo

  // 10 on a volume knob used to mean 2x. Nothing in here needs that much.
  function vol(v) { return Math.pow((v ?? 5) / 10, 1.5) * 1.15; }

  // Browsers only allow sound after a user gesture, so call this from a click.
  // While paused it must NOT wake the context back up — clicking the board is
  // a gesture, and a pause that the next click undoes is not a pause.
  function start() {
    if (ctx) { if (!paused) ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.26; // quiet nominal level: dynamics survive
    // Safety net: a fast limiter then a soft knee, so however many pedals get
    // stacked the output never hard-clips against the sound card.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;    // catches peaks, not everything
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;    // fast enough to catch transients
    limiter.release.value = 0.1;
    const softClip = ctx.createWaveShaper();
    {
      const n = 2048, curve = new Float32Array(n);
      // unity below the knee, rounding off above it. Normalising a tanh by
      // tanh(k) would give this stage 1.6x gain — the same mistake the valve
      // stage had, and it was quietly adding 4dB to everything.
      // HARD CEILING. Whatever arrives, nothing louder than CEILING can leave
      // this program. The knee keeps normal playing untouched; above it the
      // curve saturates and can never exceed the ceiling, by construction.
      const knee = 0.32, CEILING = 0.5;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        const a = Math.abs(x);
        curve[i] = a <= knee
          ? x
          : Math.sign(x) * (knee + (CEILING - knee) * Math.tanh((a - knee) / (CEILING - knee)));
      }
      softClip.curve = curve;
      softClip.oversample = '2x';
    }
    userVolume = ctx.createGain();
    userVolume.gain.value = savedVolume;
    master.connect(limiter).connect(softClip).connect(userVolume).connect(ctx.destination);
    speakers = softClip;
    // One room for the whole band. Each instrument brings its own space (the
    // cab's IR, the kit's reflections, the bass bone dry) — three different
    // rooms is the tell that the band was pasted together. A small shared
    // early-reflection send puts everyone in the same one. Band-limited so it
    // can't thicken the lows or hiss the top, and quiet enough to be felt
    // rather than heard.
    const glueSend = ctx.createGain();
    glueSend.gain.value = 0.085;
    const glueHp = ctx.createBiquadFilter();
    glueHp.type = 'highpass'; glueHp.frequency.value = 280; glueHp.Q.value = 0.7;
    const glueLp = ctx.createBiquadFilter();
    glueLp.type = 'lowpass'; glueLp.frequency.value = 5800; glueLp.Q.value = 0.7;
    const glue = ctx.createConvolver();
    glue.normalize = false;
    {
      const gsr = ctx.sampleRate, N = Math.floor(gsr * 0.09);
      const ir = ctx.createBuffer(2, N, gsr);
      // six early bounces per side, different walls left and right, then a
      // whisper of diffusion — 90 ms of "same room", no audible tail
      const taps = [[0.011, 0.013], [0.017, 0.019], [0.023, 0.029],
        [0.031, 0.037], [0.041, 0.047], [0.053, 0.059]];
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        taps.forEach(([tl, tr], i) => {
          d[Math.floor((ch ? tr : tl) * gsr)] = Math.pow(0.72, i) * 0.8 * (i % 2 && ch ? -1 : 1);
        });
        for (let i = Math.floor(0.012 * gsr); i < N; i++) {
          d[i] += (Math.random() * 2 - 1) * 0.02 * Math.exp(-3 * (i / N));
        }
      }
      glue.buffer = ir;
    }
    master.connect(glueSend);
    glueSend.connect(glueHp).connect(glueLp).connect(glue).connect(limiter);
    transport.origin = ctx.currentTime;
    if (paused) ctx.suspend(); // paused before the first gesture: stay that way
    console.log('[audio] started');
  }

  /* ------------------------------------------------------------- pause --
     A real stop, not a mute: suspending the context freezes the clock, so
     every loop, delay tail and reverb resumes exactly where it left off and
     the whole band stays in phase. transportBeat() reads ctx.currentTime, so
     the playhead freezes with the sound for free. Local to this player —
     it changes nothing on the board, so there's no op and nothing to sync. */
  function setPaused(on) {
    paused = !!on;
    if (!ctx) return paused; // nothing running yet; start() will honour it
    if (paused) ctx.suspend(); else ctx.resume();
    return paused;
  }

  /* ------------------------------------------------------- source posts -- */

  function createSource(id, state) {
    if (!ctx || sources.has(id)) return;
    const bus = ctx.createGain();
    bus.gain.value = vol(state.volume);
    sources.set(id, { bus, loop: null, guitar: null });
    applyMode(id, state);
  }

  // An amp has two ways in. SPEAKER goes through the cone, which is what a
  // guitar wants and is most of the tone. DIRECT skips it, because a guitar
  // speaker is a bandpass from 85 Hz to 5 kHz and a drum kit put through one
  // loses its whole top octave — every hat, shaker and cymbal — and then has
  // nowhere to sit but on top of the guitar. Both meet at the amp's output,
  // so the volume knob and the wave halo still see everything.
  function createAmp(id, state) {
    if (!ctx || ampGains.has(id)) return;
    const level = vol(state?.volume);
    const speaker = ctx.createGain();
    const direct = ctx.createGain();
    const sum = ctx.createGain();
    speaker.gain.value = level;
    direct.gain.value = level;
    const cab = createCabinet(ctx);
    speaker.connect(cab.in);
    cab.out.connect(sum);
    direct.connect(sum);
    sum.connect(master);
    ampGains.set(id, { speaker, direct, sum });
    ampCabs.set(id, cab);
    openTap(id, sum);
  }

  function disposeAmp(id) {
    const amp = ampGains.get(id);
    if (!amp) return;
    for (const n of [amp.speaker, amp.direct, amp.sum]) {
      try { n.disconnect(); } catch { /* ok */ }
    }
    ampCabs.get(id)?.dispose();
    ampCabs.delete(id);
    ampGains.delete(id);
    closeTap(id);
  }

  /* --------------------------------------------------------- amp scopes -- */
  // Every amp gets a listening post on the last node before the master bus:
  // an analyser is a pass-through with no output, so it costs one FFT window
  // and changes nothing you hear. The scene reads it to draw the waves
  // rolling out of the cabinet.

  function openTap(id, from) {
    closeTap(id);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0;
    from.connect(analyser);
    ampTaps.set(id, {
      analyser, from,
      scope: { wave: new Float32Array(analyser.fftSize), rms: 0 },
    });
  }

  // Blanket disconnect() calls in setChain() sever the tap along with the
  // signal path, so re-arming is part of every rewire. Reconnecting a live
  // pair is a no-op in Web Audio, which makes this safe to call every time.
  function armTap(id) {
    const t = ampTaps.get(id);
    if (t) t.from.connect(t.analyser);
  }

  function closeTap(id) {
    const t = ampTaps.get(id);
    if (!t) return;
    try { t.from.disconnect(t.analyser); } catch { /* already gone */ }
    ampTaps.delete(id);
  }

  // The live waveform at one amp, plus its RMS. The array is reused between
  // calls — read it now, don't keep it.
  function ampScope(id) {
    const t = ampTaps.get(id);
    if (!t) return null;
    const { wave } = t.scope;
    t.analyser.getFloatTimeDomainData(wave);
    let sum = 0;
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
    t.scope.rms = Math.sqrt(sum / wave.length);
    return t.scope;
  }

  // The volume knob on a tone post (input trim) or an amp (output level).
  function setPostVolume(id, v) {
    if (!ctx) return;
    const t = ctx.currentTime, level = vol(v);
    const src = sources.get(id);
    if (src) { src.bus.gain.setTargetAtTime(level, t, 0.05); return; }
    const amp = ampGains.get(id);
    if (!amp) return;
    // one knob, both ways in — the speaker and the direct feed move together
    amp.speaker.gain.setTargetAtTime(level, t, 0.05);
    amp.direct.gain.setTargetAtTime(level, t, 0.05);
  }

  function disposeSource(id) {
    const s = sources.get(id);
    if (!s) return;
    stopLoop(s);
    dropGuitar(s);
    try { s.bus.disconnect(); } catch { /* ok */ }
    sources.delete(id);
  }

  function stopLoop(s) {
    if (!s.loop) return;
    try { s.loop.src.stop(); } catch { /* ok */ }
    s.loop.src.disconnect();
    s.loop.g.disconnect();
    for (const n of s.loop.voicing || []) { try { n.disconnect(); } catch { /* ok */ } }
    s.loop.strings?.dispose();
    s.loop = null;
  }

  function dropGuitar(s) {
    if (!s.guitar) return;
    s.guitar.trim.disconnect();
    s.guitar.srcNode.disconnect();
    s.guitar.stream.getTracks().forEach((t) => t.stop());
    s.guitar = null;
  }

  // A drummer is not a guitarist: the kit must not go through a single-coil
  // pickup, a wooden body or sympathetic strings. It arrives already mixed
  // and already in a room, so all it wants on the way out is a little glue —
  // and an EQ that hands the guitar its own ground back.
  //
  // The carve is the other half of the guitar's voicing, band for band:
  //   under 32 Hz   nobody — rumble that only eats headroom
  //   40-200 Hz     the kit's (kick and snare body); the guitar is filtered out
  //   420 Hz        dipped: this is where the guitar's fundamentals live
  //   1 kHz         lifted: the guitar cabinet digs a hole here, so fill it
  //   5 kHz         lifted: stick and snare crack, above the cabinet's rolloff
  //   9 kHz up      the kit's alone — a guitar speaker makes nothing up there
  function startDrums(s, state) {
    const pattern = DRUM_PATTERNS[state.drumPattern] || DRUM_PATTERNS.rock;
    const src = ctx.createBufferSource();
    src.buffer = makeDrumBuffer(ctx, pattern, state.drumKit, beatSeconds(state));
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.85;
    const eq = [
      ['highpass', 32, 0.7, 0],
      ['peaking', 110, 1.0, -2.0],   // the bass's fundamental; the kick keeps 50-90
      ['peaking', 420, 0.9, -3.0],   // out of the guitar's way
      ['peaking', 1000, 0.8, 1.5],   // into the hole the cabinet leaves
      ['peaking', 5000, 0.9, 2.5],   // crack, where the cabinet has given up
      ['highshelf', 9000, 0.7, 2.5], // air, which is the kit's alone
    ].map(([type, hz, q, dB]) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = hz; f.Q.value = q; f.gain.value = dB;
      return f;
    });
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18; glue.ratio.value = 3;
    glue.attack.value = 0.008; glue.release.value = 0.14;
    let node = src.connect(g);
    for (const f of eq) node = node.connect(f);
    node.connect(glue).connect(s.bus);
    startInPhase(src, beatSeconds(state), state.sync);
    s.loop = { src, g, kind: 'drums', voicing: [...eq, glue] };
  }

  // All tone modes are seamless Karplus-Strong loops: 'chord' is a strummed
  // chord (in the chosen style), 'arp' a picked pattern — both in any key —
  // and 'interval' is a dyad of the root plus any interval in cents, which
  // is what opens the door to microtones (neutral thirds, quarter tones…).
  // A bass is the third seat in the band and the hardest one to fit: it wants
  // the same octave as the kick and the same low mids as the guitar. The
  // voicing is what keeps all three apart — see startDrums() and the guitar's
  // voicing below; the three carves are designed as one and edited as one.
  //
  //   under 35 Hz   nobody
  //   60 Hz         dipped: the kick's thump, and there's only room for one
  //   95 Hz         lifted: the bass's own fundamentals
  //   400 Hz        dipped: the guitar's low mids
  //   800 Hz        lifted: string definition, so it reads on small speakers
  //   over 3.5 kHz  gone: a bass has no business in the guitar's presence
  function startBass(s, state) {
    const root = (state.root || 0) + (state.detune || 0) / 100;
    const prog = PROGRESSIONS[state.progression]?.steps || null;
    const src = ctx.createBufferSource();
    src.buffer = makeBassBuffer(ctx, root, state.bassLine, state.bassTone,
      beatSeconds(state), state.bassFollow === false ? null : prog);
    src.loop = true;
    const g = ctx.createGain();
    // Balanced K-weighted against the other stems, not guessed. History:
    // 0.9 buried the band (+6.5 dB — equal-peak loops favour whatever
    // sustains), 0.5 fixed that, and the mono choke then cost the line
    // ~2.5 dB of sustained energy, which this buys back.
    g.gain.value = 0.65;
    const eq = [
      ['highpass', 35, 0.7, 0],
      ['peaking', 60, 1.0, -2.5],
      ['peaking', 95, 1.2, 2.0],
      ['peaking', 400, 0.9, -2.5],
      ['peaking', 800, 1.0, 2.5],
      ['lowpass', 2200, 0.7, 0], // above here is the guitar's, and only its
    ].map(([type, hz, q, dB]) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = hz; f.Q.value = q; f.gain.value = dB;
      return f;
    });
    // a bass is always compressed; without it the loud notes are the only
    // ones anybody hears
    const squeeze = ctx.createDynamicsCompressor();
    squeeze.threshold.value = -20; squeeze.ratio.value = 4;
    squeeze.attack.value = 0.012; squeeze.release.value = 0.16;
    let node = src.connect(g);
    for (const f of eq) node = node.connect(f);
    node.connect(squeeze).connect(s.bus);
    startInPhase(src, beatSeconds(state), state.sync);
    s.loop = { src, g, kind: 'bass', voicing: [...eq, squeeze] };
  }

  function startLoop(s, kind, state) {
    if (kind === 'drums') { startDrums(s, state); return; }
    if (kind === 'bass') { startBass(s, state); return; }
    // detune is cents — a fractional semitone that rides the whole pitch
    // pipeline, so any input can sit e.g. a quarter tone off standard
    const root = (state.root || 0) + (state.detune || 0) / 100;
    // 'dyad' voices the microtonal interval across three octaves, so strums
    // and arpeggios can play it like any chord (fractional semitones are fine)
    const ic = (state.interval ?? 350) / 100;
    const shape = state.chord === 'dyad'
      ? [0, ic, 12, 12 + ic, 24, 24 + ic]
      : (CHORDS[state.chord] || CHORDS.major);
    const semis = shape.map((x) => x + root);
    // a progression makes the strum walk through changes instead of hanging
    const prog = PROGRESSIONS[state.progression]?.steps || null;
    const spb = beatSeconds(state);
    const src = ctx.createBufferSource();
    src.buffer = kind === 'arp' ? makeArpBuffer(ctx, semis, state.arpPattern, spb)
      : kind === 'interval' ? makeIntervalBuffer(ctx, root, state.interval ?? 350, spb)
      : kind === 'riff' ? makeRiffBuffer(ctx, root, state.riff ?? 'rock', spb,
          state.riffFollow === false ? null : prog)
      : makeStrumBuffer(ctx, semis, state.strumStyle, spb, prog, root);
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = kind === 'arp' ? 0.8 : 0.9;
    // Single-coil voicing: tight lows, scooped mids, glassy presence, plus a
    // wooden body resonance and the gentle squash a real pickup+string gives.
    // It is also half of the guitar-vs-drums carve — see startDrums() for the
    // other half. The two must be edited together or they'll start colliding.
    const hp = ctx.createBiquadFilter();
    // 110, not 85: below this is the kick's, and a guitar loses nothing but mud
    hp.type = 'highpass'; hp.frequency.value = 110; hp.Q.value = 0.6;
    const wood = ctx.createBiquadFilter();
    // body at 165 rather than 196, which is where a snare's fundamental lives
    // narrow on purpose: a broad low-mid lift is the guitar spreading into the
    // kick's and the floor tom's ground for no tonal gain
    wood.type = 'peaking'; wood.frequency.value = 165; wood.Q.value = 2.2; wood.gain.value = 2.0;
    const pocket = ctx.createBiquadFilter();
    // and a small hollow left deliberately for the snare and the rack tom —
    // the cabinet lifts 200-230 by 3-4 dB, which is exactly the wrong place
    pocket.type = 'peaking'; pocket.frequency.value = 230; pocket.Q.value = 1.2; pocket.gain.value = -2.0;
    const scoop = ctx.createBiquadFilter();
    scoop.type = 'peaking'; scoop.frequency.value = 650; scoop.Q.value = 0.8; scoop.gain.value = -2.5;
    const spark = ctx.createBiquadFilter();
    spark.type = 'peaking'; spark.frequency.value = 3300; spark.Q.value = 1.0; spark.gain.value = 3.0;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf'; air.frequency.value = 7000; air.gain.value = -6; // no synthetic sizzle
    const squash = ctx.createDynamicsCompressor();
    squash.threshold.value = -22; squash.ratio.value = 2.5;
    squash.attack.value = 0.006; squash.release.value = 0.18;
    // the other strings ring in sympathy with whatever is being played
    const strings = createStrings(ctx);
    src.connect(g).connect(hp).connect(wood).connect(pocket).connect(scoop)
       .connect(spark).connect(air).connect(squash).connect(strings.in);
    strings.out.connect(s.bus);
    // synced inputs enter exactly where the shared clock already is, so a loop
    // is in phase from its first sample however long it took to build
    startInPhase(src, spb, state.sync);
    s.loop = { src, g, kind, strings, voicing: [hp, wood, pocket, scoop, spark, air, squash] };
  }

  // Rebuild whichever loop is playing after chord/key/style changes.
  function refreshTone(id, state) {
    const s = sources.get(id);
    if (!s || !s.loop) return;
    const kind = s.loop.kind;
    stopLoop(s);
    startLoop(s, kind, state);
  }

  // Mode: 'chord' | 'arp' | 'interval' | 'off' | 'guitar'. Mutates state,
  // returns a HUD label (or null). Throws if the mic is refused.
  async function setSourceMode(id, mode, state) {
    const s = sources.get(id);
    if (!s || !ctx) return null;
    const t = ctx.currentTime;

    if (mode === 'guitar') {
      const noProcessing = {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      };
      let stream = await navigator.mediaDevices.getUserMedia({ audio: noProcessing });
      const devices = await navigator.mediaDevices.enumerateDevices();
      const scarlett = devices.find((d) =>
        d.kind === 'audioinput' && /focusrite|scarlett/i.test(d.label));
      const defaultLabel = stream.getAudioTracks()[0]?.label || '';
      if (scarlett && !/focusrite|scarlett/i.test(defaultLabel)) {
        stream.getTracks().forEach((tr) => tr.stop());
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...noProcessing, deviceId: { exact: scarlett.deviceId } } });
      }
      const srcNode = ctx.createMediaStreamSource(stream);
      const split = ctx.createChannelSplitter(2);
      const trim = ctx.createGain();
      const ch = Math.min(1, Math.max(0, state.channel || 0)); // Scarlett input 1 or 2
      srcNode.connect(split);
      split.connect(trim, ch, 0);
      trim.connect(s.bus);
      stopLoop(s);
      s.guitar = { stream, srcNode, trim };
      state.mode = 'guitar';
      return `GUITAR INPUT ${ch + 1} — ${stream.getAudioTracks()[0]?.label || 'default input'}`;
    }

    dropGuitar(s);
    if (mode === 'off') {
      stopLoop(s);
      state.mode = 'off';
      return 'UNPLUGGED';
    }
    const kind = ['arp', 'interval', 'riff', 'drums', 'bass'].includes(mode) ? mode : 'chord';
    if (!s.loop || s.loop.kind !== kind) {
      stopLoop(s);
      startLoop(s, kind, state);
    }
    state.mode = kind;
    if (kind === 'drums') {
      const p = DRUM_PATTERNS[state.drumPattern] || DRUM_PATTERNS.rock;
      return `DRUMS — ${p.label.toUpperCase()}`;
    }
    if (kind === 'bass') {
      const l = BASS_LINES[state.bassLine] || BASS_LINES.pump;
      const t = BASS_TONES[state.bassTone] || BASS_TONES.finger;
      return `BASS — ${l.label.toUpperCase()} · ${t.label.toUpperCase()}`;
    }
    if (kind === 'interval') return `DYAD — ROOT + ${state.interval ?? 350}¢`;
    return `${(state.chord || 'major').toUpperCase()}${kind === 'arp' ? ' ARPEGGIO' : ''}`;
  }

  function applyMode(id, state) {
    setSourceMode(id, state.mode, state).catch(() => {});
  }

  /* -------------------------------------------------------- pedal rigs -- */

  function createRig(id, spec, state) {
    if (!ctx) return;
    disposeRig(id);
    const pedalIn = ctx.createGain();
    const wet = ctx.createGain();
    const bypass = ctx.createGain();
    const out = ctx.createGain();
    const modules = {};
    let node = pedalIn;
    for (const m of spec.chain) {
      const def = MODULES[m.type];
      if (!def) { console.warn('[audio] unknown module type', m.type); continue; }
      const mod = def.create(ctx);
      modules[m.id] = mod;
      node.connect(mod.in);
      node = mod.out;
    }
    node.connect(wet).connect(out);
    pedalIn.connect(bypass).connect(out);
    // Real pedals have finite headroom. Without this, one generated chain
    // that stacks a compressor and an EQ can hand the next pedal +20dB.
    const guard = ctx.createDynamicsCompressor();
    guard.threshold.value = -12;
    guard.knee.value = 6;
    guard.ratio.value = 12;
    guard.attack.value = 0.004;
    guard.release.value = 0.15;
    out.connect(guard);
    let tail = guard, cab = null, directIn = null;
    if (spec.kind === 'amp') { // a baked amp is a head AND a speaker
      cab = createCabinet(ctx);
      guard.connect(cab.in);
      // same two ways in as the endpoint amp: through the cone, or past it
      // for a full-range source that a guitar speaker would only ruin
      directIn = ctx.createGain();
      tail = ctx.createGain();
      cab.out.connect(tail);
      directIn.connect(tail);
    }
    rigs.set(id, { pedalIn, wet, bypass, out, guard, tail, cab, directIn, modules });
    if (spec.kind === 'amp') openTap(id, tail);
    applyRig(id, spec, state);
  }

  function applyRig(id, spec, state) {
    const rig = rigs.get(id);
    if (!rig) return;
    const t = ctx.currentTime;
    rig.wet.gain.setTargetAtTime(state.on ? 1 : 0, t, 0.05);
    // pedals bypass dry when off; an amp on standby is simply silent
    rig.bypass.gain.setTargetAtTime(state.on || spec.kind === 'amp' ? 0 : 1, t, 0.05);
    const set = (target, value) => {
      const [mid, param] = String(target).split('.');
      rig.modules[mid]?.set(param, value);
    };
    for (const c of spec.controls) set(c.target, state.values[c.id]);
    for (const sw of spec.switches || []) set(sw.target, state.switches[sw.id] ? sw.on : sw.off);
  }

  function disposeRig(id) {
    const rig = rigs.get(id);
    if (!rig) return;
    for (const m of Object.values(rig.modules)) m.dispose();
    rig.cab?.dispose();
    for (const n of [rig.pedalIn, rig.wet, rig.bypass, rig.out, rig.guard,
      rig.directIn, rig.tail]) {
      try { n?.disconnect(); } catch { /* ok */ }
    }
    closeTap(id);
    rigs.delete(id);
  }

  /* ------------------------------------------------------ chain routing -- */

  // chains: [{ source: sourceId, pedals: [pedalId, ...] }] — only complete
  // source->amp paths. Everything not in a chain stays silent.
  function setChain(chains) {
    if (!ctx) return;
    for (const s of sources.values()) { try { s.bus.disconnect(); } catch { /* ok */ } }
    for (const [id, rig] of rigs) {
      // Rebuild each rig's internal tail from scratch. Disconnecting `out`
      // alone severs out -> guard, which is created once at build time and
      // was never restored — every pedal in a chain went silent.
      try { rig.out.disconnect(); } catch { /* ok */ }
      try { rig.guard.disconnect(); } catch { /* ok */ }
      try { rig.cab?.out.disconnect(); } catch { /* ok */ }
      try { rig.directIn?.disconnect(); } catch { /* ok */ }
      try { if (rig.tail !== rig.guard) rig.tail.disconnect(); } catch { /* ok */ }
      rig.out.connect(rig.guard);
      if (rig.cab) {                              // re-arm both ways in
        rig.guard.connect(rig.cab.in);
        rig.cab.out.connect(rig.tail);
        rig.directIn.connect(rig.tail);
      }
      armTap(id);                                 // …and the scope behind it
    }
    // internal source wiring survives disconnect() of the bus outputs only —
    // reconnect generators to their bus is not needed (they feed INTO bus)
    for (const chain of chains) {
      const s = sources.get(chain.source);
      if (!s) continue;
      let node = s.bus;
      let ok = true;
      for (const pid of chain.pedals) {
        const rig = rigs.get(pid);
        if (!rig) { ok = false; break; }
        node.connect(rig.pedalIn);
        node = rig.guard ?? rig.out;
      }
      if (!ok) continue;
      // A full-range source takes the direct way in — see createAmp(). Pedals
      // still apply; it's only the guitar speaker that gets skipped, because
      // its 85 Hz highpass would take the bass's bottom two octaves and its
      // 5 kHz rolloff would take the kit's top one.
      const fullRange = s.loop?.kind === 'drums' || s.loop?.kind === 'bass';
      const ampRig = rigs.get(chain.amp); // a baked amp: route through its tone stack
      if (ampRig) {
        node.connect(fullRange && ampRig.directIn ? ampRig.directIn : ampRig.pedalIn);
        (ampRig.tail ?? ampRig.out).connect(master);
      } else {
        const amp = ampGains.get(chain.amp);
        node.connect(amp ? (fullRange ? amp.direct : amp.speaker) : master);
      }
    }
    console.log('[audio] chains:', chains.length
      ? chains.map((c) => [c.source, ...c.pedals].join(' → ') + ' → amp').join('  |  ')
      : 'none (silence)');
  }

  function setTransportBpm(bpm) {
    transport.bpm = Math.max(40, Math.min(220, bpm));
  }

  /* -------------------------------------------------------- the recorder --
     Splits the last node before the speakers into a MediaStreamDestination
     and lets MediaRecorder encode it. A take is exactly what the room heard
     — every amp, every player's gear, limiter and soft clip included. */

  let recorder = null, recDest = null, recChunks = [], recStarted = 0;

  const REC_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

  function canRecord() {
    return typeof MediaRecorder !== 'undefined'
      && REC_TYPES.some((t) => MediaRecorder.isTypeSupported(t));
  }

  function startRecording() {
    if (!ctx || recorder) return false;
    recDest = ctx.createMediaStreamDestination();
    speakers.connect(recDest);
    const mimeType = REC_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(recDest.stream, mimeType ? { mimeType } : undefined);
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.start(1000); // flush every second so a long take can't be lost whole
    recStarted = ctx.currentTime;
    return true;
  }

  // resolves to { blob, type, seconds }, or null if nothing was recording
  function stopRecording() {
    return new Promise((resolve) => {
      if (!recorder) { resolve(null); return; }
      const r = recorder;
      const seconds = ctx.currentTime - recStarted;
      r.onstop = () => {
        try { speakers.disconnect(recDest); } catch { /* ok */ }
        recDest = null;
        recorder = null;
        const type = r.mimeType || 'audio/webm';
        resolve({ blob: new Blob(recChunks, { type }), type, seconds });
        recChunks = [];
      };
      r.stop();
    });
  }

  return {
    setMasterVolume: (v) => {
      savedVolume = Math.min(1, Math.max(0, v));
      localStorage.setItem('masterVolume', String(savedVolume));
      if (userVolume) userVolume.gain.setTargetAtTime(savedVolume, ctx.currentTime, 0.02);
    },
    masterVolume: () => savedVolume,
    panic: () => { // instant silence, for when something goes wrong
      savedVolume = 0;
      localStorage.setItem('masterVolume', '0');
      if (userVolume) userVolume.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    },
    start, createSource, disposeSource, createAmp, disposeAmp,
    setPaused, paused: () => paused,
    setSourceMode, refreshTone, setPostVolume,
    registerRiff: (id, riff) => EXTRA_RIFFS.set(id, riff), setTransportBpm,
    transportBpm: () => transport.bpm,
    // where the shared clock is right now, in beats since it started — every
    // synced loop entered on one of these, so a playhead drawn from it lands
    // on the same grid the loops did
    transportBeat: () => (ctx ? (ctx.currentTime - transport.origin) * transport.bpm / 60 : 0),
    createRig, applyRig, disposeRig, setChain, ampScope,
    canRecord, startRecording, stopRecording,
    recording: () => !!recorder,
    recordedSeconds: () => (recorder ? ctx.currentTime - recStarted : 0),
    started: () => !!ctx,
    contextState: () => (ctx ? ctx.state : 'uninitialized'),
  };
}

/* ------------------------------------------------------ tone generators -- */

// Strumming styles — all times in BEATS so BPM and sync work everywhere.
// dir 1 = downstroke (low strings first), -1 = upstroke (top strings, softer).
// strings: 'low'/'high' restricts an event to part of the chord (boom-chick).
// sweep = seconds between strings in one stroke (rasgueado wants it tight).
export const STRUM_STYLES = {
  ring: { label: 'Ring out', beats: 16, ring: 9.0, damp: 0.999,
    events: [{ t: 0, dir: 1, g: 1 }] },
  steady: { label: 'Steady', beats: 8, ring: 4.0, damp: 0.9985,
    events: [{ t: 0, dir: 1, g: 1 }, { t: 2, dir: 1, g: 0.85 },
             { t: 4, dir: 1, g: 0.95 }, { t: 6, dir: 1, g: 0.85 }] },
  ballad: { label: 'Ballad', beats: 8, ring: 7.0, damp: 0.999,
    events: [{ t: 0, dir: 1, g: 0.95 }, { t: 4, dir: 1, g: 0.7 }] },
  folk: { label: 'Folk', beats: 4, ring: 2.6, damp: 0.998, // D D U _ U D U
    events: [{ t: 0, dir: 1, g: 1 }, { t: 1, dir: 1, g: 0.8 },
             { t: 1.5, dir: -1, g: 0.6 }, { t: 2.5, dir: -1, g: 0.6 },
             { t: 3, dir: 1, g: 0.85 }, { t: 3.5, dir: -1, g: 0.6 }] },
  waltz: { label: 'Waltz', beats: 3, ring: 1.6, damp: 0.998,
    events: [{ t: 0, dir: 1, g: 1 }, { t: 1, dir: -1, g: 0.55 },
             { t: 2, dir: -1, g: 0.55 }] },
  chop: { label: 'Chop', beats: 4, ring: 0.34, damp: 0.988,
    events: Array.from({ length: 8 }, (_, i) =>
      ({ t: i * 0.5, dir: i % 2 ? -1 : 1, g: i % 2 ? 0.7 : 1 })) },
  reggae: { label: 'Reggae', beats: 4, ring: 0.3, damp: 0.986,
    events: [0.5, 1.5, 2.5, 3.5].map((t) => ({ t, dir: -1, g: 0.85, strings: 'high' })) },
  punk: { label: 'Punk', beats: 4, ring: 0.5, damp: 0.99, sweep: 0.02,
    events: Array.from({ length: 8 }, (_, i) =>
      ({ t: i * 0.5, dir: 1, g: i % 2 ? 0.85 : 1 })) },
  flamenco: { label: 'Flamenco', beats: 4, ring: 2.2, damp: 0.9975, sweep: 0.018,
    events: [{ t: 0, dir: 1, g: 0.7 }, { t: 0.125, dir: -1, g: 0.7 },
             { t: 0.25, dir: 1, g: 0.8 }, { t: 0.375, dir: 1, g: 1 },
             { t: 2, dir: -1, g: 0.6 }, { t: 2.125, dir: 1, g: 0.9 }] },
  train: { label: 'Train', beats: 2, ring: 0.9, damp: 0.993,
    events: [{ t: 0, dir: 1, g: 1, strings: 'low' },
             { t: 0.5, dir: -1, g: 0.6, strings: 'high' },
             { t: 1, dir: 1, g: 0.9, strings: 'low' },
             { t: 1.5, dir: -1, g: 0.6, strings: 'high' }] },
  shuffle: { label: 'Shuffle', beats: 4, ring: 0.7, damp: 0.994, // swung eighths
    events: [0, 1, 2, 3].flatMap((b) => [
      { t: b, dir: 1, g: 1 }, { t: b + 0.66, dir: -1, g: 0.55 }]) },
  disco: { label: 'Disco', beats: 4, ring: 0.22, damp: 0.985, sweep: 0.012,
    events: Array.from({ length: 16 }, (_, i) =>
      ({ t: i * 0.25, dir: i % 2 ? -1 : 1, g: i % 4 === 0 ? 1 : 0.6, strings: 'high' })) },
  surf: { label: 'Surf', beats: 4, ring: 0.5, damp: 0.99, sweep: 0.01, // tremolo burst
    events: [...Array.from({ length: 8 }, (_, i) =>
      ({ t: i * 0.125, dir: i % 2 ? -1 : 1, g: 0.7, strings: 'high' })),
      { t: 2, dir: 1, g: 1 }] },
  country: { label: 'Country', beats: 2, ring: 0.8, damp: 0.995, // boom-chicka
    events: [{ t: 0, dir: 1, g: 1, strings: 'low' },
             { t: 0.5, dir: 1, g: 0.75 }, { t: 0.75, dir: -1, g: 0.5 },
             { t: 1, dir: 1, g: 0.9, strings: 'low' },
             { t: 1.5, dir: 1, g: 0.75 }, { t: 1.75, dir: -1, g: 0.5 }] },
  bossa: { label: 'Bossa', beats: 4, ring: 1.2, damp: 0.997,
    events: [{ t: 0, dir: 1, g: 0.9 }, { t: 1.5, dir: -1, g: 0.6 },
             { t: 2, dir: 1, g: 0.8 }, { t: 3.5, dir: -1, g: 0.6 }] },
  doom: { label: 'Doom', beats: 8, ring: 5.0, damp: 0.9985,
    events: [{ t: 0, dir: 1, g: 1, strings: 'low' },
             { t: 6, dir: 1, g: 0.7, strings: 'low' }] },
  blackmetal: { label: 'Black metal', beats: 4, ring: 0.3, damp: 0.988, sweep: 0.008,
    // relentless tremolo picking, an icy wall of sixteenths
    events: Array.from({ length: 16 }, (_, i) =>
      ({ t: i * 0.25, dir: i % 2 ? -1 : 1, g: 0.85, strings: 'high' })) },
  deathmetal: { label: 'Death metal', beats: 4, ring: 0.15, damp: 0.978, sweep: 0.01,
    // palm-muted chug clusters with an open accent on the downbeat
    events: [{ t: 0, dir: 1, g: 1.15 },
      ...[0, 1, 2, 3].flatMap((b) => [
        { t: b + 0.25, dir: 1, g: 0.9, strings: 'low' },
        { t: b + 0.5, dir: 1, g: 0.85, strings: 'low' },
        { t: b + 0.75, dir: 1, g: 0.9, strings: 'low' }])] },
  metal: { label: 'Metal', beats: 4, ring: 0.3, damp: 0.985, sweep: 0.012,
    // the gallop: da-da-DUM on the low strings
    events: [0, 1, 2, 3].flatMap((b) => [
      { t: b, dir: 1, g: 1, strings: 'low' },
      { t: b + 0.5, dir: 1, g: 0.75, strings: 'low' },
      { t: b + 0.75, dir: 1, g: 0.8, strings: 'low' }]) },
  stoner: { label: 'Stoner', beats: 8, ring: 2.5, damp: 0.998,
    events: [{ t: 0, dir: 1, g: 1 }, { t: 2.5, dir: 1, g: 0.7, strings: 'low' },
             { t: 3.5, dir: -1, g: 0.6 }, { t: 4, dir: 1, g: 0.9 },
             { t: 6.5, dir: 1, g: 0.75, strings: 'low' }] },
  garage: { label: 'Garage', beats: 4, ring: 0.8, damp: 0.995, sweep: 0.06,
    // sloppy, wide, uneven — all downstroke attitude
    events: [1, 0.7, 0.85, 0.65, 0.95, 0.7, 0.8, 0.6].map((g, i) =>
      ({ t: i * 0.5, dir: i % 2 ? -1 : 1, g })) },
  grunge: { label: 'Grunge', beats: 4, ring: 1.0, damp: 0.996,
    events: [{ t: 0, dir: 1, g: 1 }, { t: 1, dir: 1, g: 0.8 },
             { t: 1.5, dir: -1, g: 0.6 }, { t: 2.5, dir: 1, g: 1 },
             { t: 3, dir: 1, g: 0.8 }, { t: 3.5, dir: -1, g: 0.6 }] },
  funk: { label: 'Funk', beats: 2, ring: 0.15, damp: 0.975, sweep: 0.01,
    // scratchy sixteenth chops with ghost notes on the top strings
    events: [{ t: 0, dir: 1, g: 1, strings: 'high' },
             { t: 0.25, dir: -1, g: 0.4, strings: 'high' },
             { t: 0.5, dir: 1, g: 0.5, strings: 'high' },
             { t: 0.75, dir: -1, g: 0.95, strings: 'high' },
             { t: 1.25, dir: -1, g: 0.4, strings: 'high' },
             { t: 1.5, dir: 1, g: 0.9, strings: 'high' },
             { t: 1.75, dir: -1, g: 0.45, strings: 'high' }] },
};

// Arpeggio patterns: string order inside the loop. step is BEATS per note
// (default an eighth = 0.5); ring is seconds each note sustains.
export const ARP_PATTERNS = {
  up:      { label: 'Up', order: [0, 1, 2, 3, 4, 5] },
  down:    { label: 'Down', order: [5, 4, 3, 2, 1, 0] },
  updown:  { label: 'Up-down', order: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1] },
  picked:  { label: 'Picked', order: [0, 3, 2, 4, 1, 4, 2, 3] },
  outside: { label: 'Outside', order: [0, 5, 1, 4, 2, 3] },
  cascade: { label: 'Cascade', order: [0, 1, 2, 0, 2, 3, 2, 3, 4, 3, 4, 5], step: 0.25 },
  pedal:   { label: 'Pedal', order: [0, 5, 0, 4, 0, 3, 0, 2] },
  gallop:  { label: 'Gallop', order: [0, 2, 4, 0, 2, 5, 0, 2, 4, 0, 2, 3], step: 0.25, ring: 0.9 },
  harp:    { label: 'Harp', order: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1], step: 0.25, ring: 2.4 },
};

// One Karplus-Strong pluck rendered into a wrap-around loop buffer.
// The loop is tuned to a fraction of a sample with a first-order allpass —
// an integer delay line alone quantizes pitch by up to ~10 cents up high,
// which would smear the microtone intervals this engine now supports.
//
// A real string vibrates in two planes at once: the vertical polarization is
// loud and dies fast, the horizontal one is quieter, darker and outlives it,
// a few cents away so the upper partials shimmer against each other. Every
// pluck therefore renders TWO loops — that compound decay and slow breathing
// is most of the difference between a note and a beep.
//
// Options (all optional):
//   bright  pluck brightness floor — a bass overrides the guitar's assumption
//   click   attack transient amount (a fingerpad has almost none)
//   tone    top end kept per trip round the string (wound strings < 1)
//   choke   seconds after the pluck when a finger lands on the string
//   release how fast the choke closes (default 35 ms — a mute, not a gate)
//   jitter  timing slop override (default ±6 ms; a locked-in bassist wants less)
//   lean    constant offset off the grid (sitting behind the kick is a choice)
function pluckInto(out, sr, len, f, startSec, ringSec, damp, gain, o = {}) {
  // Humanise: no two plucks of a real guitar share timing, tuning or force,
  // and perfectly quantised repeats are the main tell of a synthetic player.
  const jitter = (Math.random() - 0.5) * 2 * (o.jitter ?? 0.006);
  const detuneCents = (Math.random() - 0.5) * 8; // ±4 cents — nobody frets exactly
  const velocity = gain * (1 + (Math.random() - 0.5) * 0.16);
  const start = Math.max(0, Math.floor(sr * (startSec + jitter + (o.lean ?? 0))));
  // Harder picking is brighter, not merely louder — that link is most of what
  // makes a line sound played rather than sequenced. Pitch matters too: the
  // low strings on a guitar are wound and comparatively dull with a metallic
  // zing, the top strings are plain steel and bright.
  const wound = Math.min(1, Math.max(0, (330 - f) / 250)); // 1 = low E, 0 above E4
  const bright = o.bright !== undefined
    ? Math.max(0.08, Math.min(0.9, o.bright + velocity * 0.18))
    : Math.max(0.3, Math.min(0.88, 0.35 + velocity * 0.35 + (1 - wound) * 0.2));
  // where the pick meets the string wanders a little between strokes
  const combPos = 0.16 * (1 + (Math.random() - 0.5) * 0.25);
  const tone = o.tone ?? 1;
  const chokeAt = o.choke !== undefined
    ? Math.floor(sr * Math.max(0.01, o.choke)) : Infinity;
  const chokeK = Math.exp(-1 / (sr * (o.release ?? 0.035)));

  // pick attack: a short bright click before the string settles, which is
  // most of what the ear uses to identify a plucked instrument
  const clickLen = Math.min(Math.floor(sr * 0.004), len);
  const click = (o.click ?? 0.5) * velocity;
  for (let j = 0; j < clickLen; j++) {
    const p = (start + j) % len;
    out[p] += click * (Math.random() * 2 - 1) * (1 - j / clickLen) ** 2;
  }

  const renderLoop = (cents, dampX, ampX, brightX, ringX) => {
    // the two-tap average delays N - 0.5 samples; the allpass adds frac more,
    // kept in [0.3, 1.3) so its pole stays well inside the unit circle
    const exact = sr / (f * Math.pow(2, cents / 1200)) + 0.5;
    const N = Math.max(4, Math.floor(exact - 0.3));
    const frac = Math.max(0.1, exact - N);
    const C = (1 - frac) / (1 + frac);
    const ring = new Float32Array(N);
    const seed = new Float32Array(N);
    let prev = 0;
    for (let j = 0; j < N; j++) {
      const white = Math.random() * 2 - 1;
      prev = (1 - brightX) * prev + brightX * white;
      seed[j] = prev;
    }
    const comb = Math.max(1, Math.round(N * combPos)); // pickup-position comb -> quack
    for (let j = 0; j < N; j++) ring[j] = seed[j] - 0.9 * seed[(j - comb + N) % N];
    // Wound strings ring with a fine metallic zing over the fundamental. It is
    // alternating-sign noise, i.e. energy right at Nyquist, so it has to scale
    // with how bright the string is — at full strength on a bass it is the
    // only thing you'd hear.
    const zing = (o.bright !== undefined ? brightX * 0.22 : 0.16);
    if (wound > 0.05) {
      for (let j = 0; j < N; j++) {
        ring[j] += wound * zing * (Math.random() * 2 - 1) * (j % 2 ? 1 : -1);
      }
    }
    let idx = 0;
    let apX = 0, apY = 0; // allpass state
    let loopLp = 0;       // extra in-loop damping, for strings that lose highs
    let chokeEnv = 1;
    const dur = Math.min(len, Math.floor(sr * ringX));
    for (let j = 0; j < dur; j++) {
      const p = (start + j) % len; // tail wraps -> seamless loop
      const next = (idx + 1) % N;
      const avg = 0.5 * (ring[idx] + ring[next]);
      apY = C * avg + apX - C * apY;
      apX = avg;
      let v = dampX * apY;
      if (tone < 1) { loopLp += tone * (v - loopLp); v = loopLp; }
      ring[idx] = v;
      if (j >= chokeAt) {
        chokeEnv *= chokeK;
        if (chokeEnv < 1e-4) break; // inaudible; the finger has won
      }
      out[p] += velocity * ampX * ring[idx] * chokeEnv;
      idx = next;
    }
  };
  renderLoop(detuneCents + 1.6, damp, 1, bright, ringSec);
  renderLoop(detuneCents - 1.6, Math.min(0.99995, damp + (1 - damp) * 0.45),
    0.38, Math.max(0.08, bright * 0.75), ringSec * 1.4);
}

function normalize(out, target) {
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const s = peak > 0 ? target / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= s;
}

// A strummed electric guitar chord in the chosen style — every hit sweeps
// across the strings (down or up), rings naturally, and the tails wrap so
// the loop never goes silent.
function makeStrumBuffer(ctx, semis, styleKey, spb, prog, root) {
  const style = STRUM_STYLES[styleKey] || STRUM_STYLES.ring;
  const sr = ctx.sampleRate;
  // with a progression, the loop is as long as the whole sequence and each
  // step re-voices the chord; without one it's a single repeating bar
  const steps = prog && prog.length
    ? prog.map((st) => ({ semis: (CHORDS[st.q] || CHORDS.major).map((x) => x + root + st.d),
                          beats: (st.b || 1) * 4 }))
    : [{ semis, beats: style.beats }];
  const totalBeats = steps.reduce((a, st) => a + st.beats, 0);
  // several passes with fresh humanisation, so the loop never plays the same
  // bar the same way twice
  const cycles = Math.max(1, Math.min(8, Math.round(32 / totalBeats)));
  const len = Math.floor(sr * totalBeats * cycles * spb);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  for (let c = 0; c < cycles; c++) {
    let beatCursor = c * totalBeats;
    for (const step of steps) {
      // With changes, the player damps the strings as the next chord comes —
      // the old chord must not keep ringing over it (measured: it used to sit
      // only 1.8 dB down through the whole next bar). Without a progression
      // there is nothing to damp for, and the tails wrap to seam the loop.
      const chokeBeat = prog && prog.length ? beatCursor + step.beats : undefined;
      renderStrumSpan(out, sr, len, step.semis, style, spb, beatCursor, step.beats, chokeBeat);
      if (chokeBeat !== undefined) {
        // the hand landing is audible: a tiny muted 'chick' before the change
        for (const s of [0, 1]) {
          pluckInto(out, sr, len, E2 * Math.pow(2, step.semis[s] / 12),
            chokeBeat * spb - 0.045 + s * 0.012, 0.05, 0.9, 0.11,
            { bright: 0.75, click: 0.8, jitter: 0.004 });
        }
      }
      beatCursor += step.beats;
    }
  }
  normalize(out, CHORD_LEVEL * 1.5);
  return buf;
}

// Lay one chord's worth of strumming into the buffer, starting at a beat.
// Events past the span are dropped — the next chord plays its own bar. (They
// used to render anyway: with a progression, every style longer than the bar
// was strumming two chords at once and wrapping wrong-chord strums onto the
// loop's downbeat.)
function renderStrumSpan(out, sr, len, semis, style, spb, beatOffset, spanBeats, chokeBeat) {
  const sweep = style.sweep ?? 0.045;
  const reps = Math.max(1, Math.round(spanBeats / style.beats));
  for (const evBase of style.events) {
   for (let rep = 0; rep < reps; rep++) {
    const local = evBase.t + rep * style.beats;
    if (local >= spanBeats) continue;
    const ev = { ...evBase, t: local + beatOffset };
    let order = semis.map((_, i) => i);
    if (ev.strings === 'low') order = order.slice(0, 3);
    else if (ev.strings === 'high') order = order.slice(2);
    else if (ev.dir < 0) order = order.slice(2); // upstrokes skip low strings
    if (ev.dir < 0) order = [...order].reverse();
    order.forEach((stringIdx, k) => {
      const f = E2 * Math.pow(2, semis[stringIdx] / 12);
      const startSec = ev.t * spb + k * sweep;
      pluckInto(out, sr, len, f, startSec, style.ring, style.damp,
        (CHORD_GAINS[stringIdx] ?? 0.15) * 2.2 * ev.g,
        chokeBeat === undefined ? {}
          : { choke: Math.max(0.06, chokeBeat * spb - startSec + 0.08) });
    });
   }
  }
}

// Several bars of a groove, rendered once and looped. Long enough that the
// ear stops hearing the repeat — every bar is humanised separately and the
// last one gets a fill, so it never lands twice the same way.
function makeDrumBuffer(ctx, pattern, kitKey, spb) {
  const sr = ctx.sampleRate;
  const bars = drumBars(pattern);
  const len = Math.max(1, Math.floor(sr * bars * pattern.beats * spb));
  // stereo: the kit is a stage, not a point — hat left, ride right, toms
  // sweeping across, kick and snare holding the middle
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  renderDrumsStereo(L, R, sr, spb, pattern, kitFor(kitKey, pattern), bars);
  // Peak-normalised like every other loop (a brushed jazz kit lands well
  // below a metal one, exactly as it should) — but by the SHARED peak:
  // normalising the channels separately would drag the stage back to mono.
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const s = peak > 0 ? (CHORD_LEVEL * 1.5) / peak : 1;
  for (let i = 0; i < len; i++) { L[i] *= s; R[i] *= s; }
  return buf;
}

// A bass line is written against the CHORD, not the key, so walking it
// through a progression is just a matter of transposing each bar to the step
// it lands on. Everything is an octave under the guitar (E1, not E2).
function makeBassBuffer(ctx, rootSemi, lineKey, toneKey, spb, prog) {
  const line = BASS_LINES[lineKey] || BASS_LINES.pump;
  const tone = BASS_TONES[toneKey] || BASS_TONES.finger;
  const sr = ctx.sampleRate;
  const steps = prog && prog.length
    ? prog.map((st) => ({ shift: st.d, quality: st.q, beats: (st.b || 1) * 4 }))
    : [{ shift: 0, quality: 'major', beats: line.beats }];
  const totalBeats = steps.reduce((a, st) => a + st.beats, 0);
  // several passes with fresh humanisation — a frozen one-bar loop is the
  // most machine thing a bassline can do
  const cycles = Math.max(1, Math.min(8, Math.round(32 / totalBeats)));
  const len = Math.floor(sr * totalBeats * cycles * spb);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);

  // first the notes, as data — the walk logic needs its step context here
  const events = [];
  for (let c = 0; c < cycles; c++) {
    let cursor = c * totalBeats;
    steps.forEach((step, si) => {
      const reps = Math.max(1, Math.round(step.beats / line.beats));
      // a pedal line ignores the changes and sits on the key's root; every
      // other line moves with them
      const shift = line.pedal ? 0 : step.shift;
      const minor = /min|dim|m6|m7/.test(step.quality || '');
      for (let r = 0; r < reps; r++) {
        const base = cursor + r * line.beats;
        for (const n of line.notes) {
          if (n.t >= step.beats - r * line.beats) continue; // don't spill past the change
          let s = n.s;
          // the walking line borrows its third from the chord, and its last
          // note leans a semitone into wherever comes next — including the
          // loop wrapping around to the top, which is also a change
          if (line.walk) {
            if (s === 4 && minor) s = 3;
            if (n.t === line.beats - 1) {
              const next = steps[(si + 1) % steps.length];
              s = (line.pedal ? 0 : next.shift) - shift - 1;
            }
          }
          events.push({
            beat: swingBeat(n.t, line.swing) + base,
            f: (E2 / 2) * Math.pow(2, (rootSemi + shift + s) / 12),
            g: n.g,
          });
        }
      }
      cursor += step.beats;
    });
  }

  // Then the playing. A bass is monophonic: fretting the next note mutes the
  // one before it, which is most of what makes a line read as notes instead
  // of a pad (measured: only 5.5 dB of movement between notes before this).
  // Ghosts are dead notes — a thumb on the string, thud not tone. And the
  // whole instrument runs tighter than a guitarist and a hair behind the
  // kick: that lock is the pocket.
  events.sort((a, b) => a.beat - b.beat);
  events.forEach((e, i) => {
    const nextBeat = i + 1 < events.length
      ? events[i + 1].beat
      : totalBeats * cycles + events[0].beat; // the loop's next pass
    const gap = (nextBeat - e.beat) * spb;
    const dead = e.g < 0.35;
    pluckInto(out, sr, len, e.f, e.beat * spb, line.ring ?? tone.ring, tone.damp,
      0.85 * e.g, {
        bright: tone.bright, click: tone.click, tone: tone.tone,
        choke: dead ? 0.06 : Math.max(0.08, gap * 0.85),
        release: dead ? 0.025 : 0.04,
        jitter: 0.0025, lean: 0.003,
      });
  });
  normalize(out, CHORD_LEVEL * 1.5);
  return buf;
}

// offbeat eighths land late when a line swings (0.5 straight, 2/3 triplet)
function swingBeat(t, swing) {
  if (!swing || swing === 0.5) return t;
  const beat = Math.floor(t), frac = t - beat;
  return Math.abs(frac - 0.5) < 1e-6 ? beat + swing : t;
}

// A riff is note data, not a chord: each entry has its own beat position,
// pitch and pick strength, so rests and phrasing survive into the loop.
const EXTRA_RIFFS = new Map(); // riffs baked at runtime, by id

function makeRiffBuffer(ctx, rootSemi, riffKey, spb, prog) {
  const riff = EXTRA_RIFFS.get(riffKey) || RIFFS[riffKey] || RIFFS.rock;
  const sr = ctx.sampleRate;
  // Following a progression moves the whole riff shape to each new root, the
  // way a player transposes a lick across the changes. Each step lasts as
  // long as the progression says, with the riff repeating to fill it.
  const steps = prog && prog.length
    ? prog.map((st) => ({ shift: st.d, beats: (st.b || 1) * 4 }))
    : [{ shift: 0, beats: riff.beats }];
  const totalBeats = steps.reduce((a, st) => a + st.beats, 0);
  // fresh humanisation every pass — see makeStrumBuffer
  const cycles = Math.max(1, Math.min(8, Math.round(32 / totalBeats)));
  const len = Math.floor(sr * totalBeats * cycles * spb);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  for (let c = 0; c < cycles; c++) {
    let cursor = c * totalBeats;
    for (const step of steps) {
      const stepEnd = cursor + step.beats;
      const reps = Math.max(1, Math.round(step.beats / riff.beats));
      for (let r = 0; r < reps; r++) {
        const base = cursor + r * riff.beats;
        for (const n of riff.notes) {
          if (n.t + r * riff.beats >= step.beats) continue; // don't spill past the change
          const f = E2 * Math.pow(2, (rootSemi + step.shift + n.s) / 12);
          const startSec = (base + n.t) * spb;
          pluckInto(out, sr, len, f, startSec, n.r ?? riff.ring,
            riff.damp ?? 0.996, 0.55 * (n.g ?? 1),
            // with changes, damp the lick as the next chord arrives
            prog && prog.length
              ? { choke: Math.max(0.06, stepEnd * spb - startSec + 0.08) } : {});
        }
      }
      cursor += step.beats;
    }
  }
  normalize(out, CHORD_LEVEL * 1.6);
  return buf;
}

// Plucked Karplus-Strong arpeggio over the chord shape in the chosen
// pattern, looping seamlessly — the transient-rich source that makes
// drives, delays and comps audible.
function makeArpBuffer(ctx, semis, patternKey, spb) {
  const pattern = ARP_PATTERNS[patternKey] || ARP_PATTERNS.up;
  const sr = ctx.sampleRate;
  const step = (pattern.step ?? 0.5) * spb; // beats -> seconds
  const ring = pattern.ring ?? 1.7;
  const cycleBeats = (pattern.step ?? 0.5) * pattern.order.length;
  const cycles = Math.max(1, Math.min(8, Math.round(32 / cycleBeats)));
  const len = Math.floor(sr * step * pattern.order.length * cycles);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  for (let c = 0; c < cycles; c++) {
    pattern.order.forEach((noteIdx, i) => {
      const semi = semis[noteIdx] ?? semis[semis.length - 1];
      pluckInto(out, sr, len, E2 * Math.pow(2, semi / 12),
        step * (i + c * pattern.order.length), ring, 0.9965, 0.5);
    });
  }
  normalize(out, 0.7);
  return buf;
}

// A microtone dyad over an 8-beat loop: the root alone, the chosen interval
// alone, then both together — melodic first, harmonic second, so the ear
// can grab the interval's size before hearing how it beats. `cents` is any
// value, not a 12-TET multiple: 350 = neutral third, 969 = harmonic seventh.
function makeIntervalBuffer(ctx, rootSemi, cents, spb) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 8 * spb);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const root = 2 * E2 * Math.pow(2, rootSemi / 12); // E3 register reads clearest
  const upper = root * Math.pow(2, cents / 1200);
  const ring = 6.0, damp = 0.999;
  pluckInto(out, sr, len, root, 0, ring, damp, 0.6);
  pluckInto(out, sr, len, upper, 2 * spb, ring, damp, 0.5);
  pluckInto(out, sr, len, root, 4 * spb, ring, damp, 0.55);
  pluckInto(out, sr, len, upper, 4 * spb + 0.03, ring, damp, 0.48);
  normalize(out, CHORD_LEVEL * 1.4);
  return buf;
}
