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
import { MODULES, createCabinet } from './modules.js';
import { RIFFS, PROGRESSIONS } from './riffs.js';

export function createAudio() {
  let ctx = null;     // created on the first user gesture, then permanent
  let master = null;
  const transport = { origin: 0, bpm: 100 }; // the shared clock for synced inputs

  function beatSeconds(state) {
    return 60 / (state.sync ? transport.bpm : (state.bpm || 100));
  }
  // next beat boundary of the shared clock, a hair in the future
  function nextBeatTime() {
    const spb = 60 / transport.bpm;
    const now = ctx.currentTime + 0.06;
    return transport.origin + Math.ceil((now - transport.origin) / spb) * spb;
  }
  const rigs = new Map();     // pedal instanceId -> rig
  const sources = new Map();  // source post id -> { bus, loop, guitar }
  const ampGains = new Map(); // amp post id -> gain (its volume knob)
  const ampCabs = new Map();  // amp post id -> speaker cabinet

  function vol(v) { return Math.pow((v ?? 5) / 10, 1.5) * 2; }

  // Browsers only allow sound after a user gesture, so call this from a click.
  function start() {
    if (ctx) { ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    transport.origin = ctx.currentTime;
    console.log('[audio] started');
  }

  /* ------------------------------------------------------- source posts -- */

  function createSource(id, state) {
    if (!ctx || sources.has(id)) return;
    const bus = ctx.createGain();
    bus.gain.value = vol(state.volume);
    sources.set(id, { bus, loop: null, guitar: null });
    applyMode(id, state);
  }

  function createAmp(id, state) {
    if (!ctx || ampGains.has(id)) return;
    const g = ctx.createGain();
    g.gain.value = vol(state?.volume);
    // every amp has a speaker in it — the biggest single step toward
    // sounding like a real rig instead of a synth patch
    const cab = createCabinet(ctx);
    g.connect(cab.in);
    cab.out.connect(master);
    ampGains.set(id, g);
    ampCabs.set(id, cab);
  }

  function disposeAmp(id) {
    const g = ampGains.get(id);
    if (!g) return;
    try { g.disconnect(); } catch { /* ok */ }
    ampCabs.get(id)?.dispose();
    ampCabs.delete(id);
    ampGains.delete(id);
  }

  // The volume knob on a tone post (input trim) or an amp (output level).
  function setPostVolume(id, v) {
    if (!ctx) return;
    const target = sources.get(id)?.bus.gain ?? ampGains.get(id)?.gain;
    target?.setTargetAtTime(vol(v), ctx.currentTime, 0.05);
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
    s.loop = null;
  }

  function dropGuitar(s) {
    if (!s.guitar) return;
    s.guitar.trim.disconnect();
    s.guitar.srcNode.disconnect();
    s.guitar.stream.getTracks().forEach((t) => t.stop());
    s.guitar = null;
  }

  // All tone modes are seamless Karplus-Strong loops: 'chord' is a strummed
  // chord (in the chosen style), 'arp' a picked pattern — both in any key —
  // and 'interval' is a dyad of the root plus any interval in cents, which
  // is what opens the door to microtones (neutral thirds, quarter tones…).
  function startLoop(s, kind, state) {
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
      : kind === 'riff' ? makeRiffBuffer(ctx, root, state.riff ?? 'rock', spb)
      : makeStrumBuffer(ctx, semis, state.strumStyle, spb, prog, root);
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = kind === 'arp' ? 0.8 : 0.9;
    // single-coil voicing: tight lows, scooped mids, glassy presence, plus a
    // wooden body resonance and the gentle squash a real pickup+string gives
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.6;
    const wood = ctx.createBiquadFilter();
    wood.type = 'peaking'; wood.frequency.value = 196; wood.Q.value = 1.6; wood.gain.value = 2.5;
    const scoop = ctx.createBiquadFilter();
    scoop.type = 'peaking'; scoop.frequency.value = 650; scoop.Q.value = 0.8; scoop.gain.value = -3.5;
    const spark = ctx.createBiquadFilter();
    spark.type = 'peaking'; spark.frequency.value = 3300; spark.Q.value = 1.0; spark.gain.value = 3.0;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf'; air.frequency.value = 7000; air.gain.value = -6; // no synthetic sizzle
    const squash = ctx.createDynamicsCompressor();
    squash.threshold.value = -22; squash.ratio.value = 2.5;
    squash.attack.value = 0.006; squash.release.value = 0.18;
    src.connect(g).connect(hp).connect(wood).connect(scoop).connect(spark)
       .connect(air).connect(squash).connect(s.bus);
    // synced inputs enter exactly on the shared clock's next beat — loops of
    // integer beat lengths then stay locked (or politely polymetric) forever
    src.start(state.sync ? nextBeatTime() : undefined);
    s.loop = { src, g, kind, voicing: [hp, wood, scoop, spark, air, squash] };
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
    const kind = ['arp', 'interval', 'riff'].includes(mode) ? mode : 'chord';
    if (!s.loop || s.loop.kind !== kind) {
      stopLoop(s);
      startLoop(s, kind, state);
    }
    state.mode = kind;
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
    let tail = out, cab = null;
    if (spec.kind === 'amp') { // a baked amp is a head AND a speaker
      cab = createCabinet(ctx);
      out.connect(cab.in);
      tail = cab.out;
    }
    rigs.set(id, { pedalIn, wet, bypass, out, tail, cab, modules });
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
    for (const n of [rig.pedalIn, rig.wet, rig.bypass, rig.out]) {
      try { n.disconnect(); } catch { /* ok */ }
    }
    rigs.delete(id);
  }

  /* ------------------------------------------------------ chain routing -- */

  // chains: [{ source: sourceId, pedals: [pedalId, ...] }] — only complete
  // source->amp paths. Everything not in a chain stays silent.
  function setChain(chains) {
    if (!ctx) return;
    for (const s of sources.values()) { try { s.bus.disconnect(); } catch { /* ok */ } }
    for (const rig of rigs.values()) {
      try { rig.out.disconnect(); } catch { /* ok */ }
      try { rig.cab?.out.disconnect(); } catch { /* ok */ }
      if (rig.cab) rig.out.connect(rig.cab.in); // re-arm the speaker path
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
        node = rig.out;
      }
      if (!ok) continue;
      const ampRig = rigs.get(chain.amp); // a baked amp: route through its tone stack
      if (ampRig) {
        node.connect(ampRig.pedalIn);
        (ampRig.tail ?? ampRig.out).connect(master);
      } else {
        node.connect(ampGains.get(chain.amp) ?? master);
      }
    }
    console.log('[audio] chains:', chains.length
      ? chains.map((c) => [c.source, ...c.pedals].join(' → ') + ' → amp').join('  |  ')
      : 'none (silence)');
  }

  function setTransportBpm(bpm) {
    transport.bpm = Math.max(40, Math.min(220, bpm));
  }

  return {
    start, createSource, disposeSource, createAmp, disposeAmp,
    setSourceMode, refreshTone, setPostVolume, setTransportBpm,
    transportBpm: () => transport.bpm,
    createRig, applyRig, disposeRig, setChain,
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
// A real string is two coupled strings' worth of complexity: the pick makes a
// transient click, the string decays inharmonically, and no two plucks are
// identical. This renders one pluck with all three.
function pluckInto(out, sr, len, f, startSec, ringSec, damp, gain) {
  // Humanise: no two plucks of a real guitar share timing, tuning or force,
  // and perfectly quantised repeats are the main tell of a synthetic player.
  const jitter = (Math.random() - 0.5) * 0.012;       // +/-6ms of feel
  const detune = 1 + (Math.random() - 0.5) * 0.0046;  // +/-4 cents
  const velocity = gain * (1 + (Math.random() - 0.5) * 0.16);
  const start = Math.max(0, Math.floor(sr * (startSec + jitter)));
  // the two-tap average delays N - 0.5 samples; the allpass adds frac more,
  // kept in [0.3, 1.3) so its pole stays well inside the unit circle
  const exact = sr / (f * detune) + 0.5;
  const N = Math.max(4, Math.floor(exact - 0.3));
  const frac = Math.max(0.1, exact - N);
  const C = (1 - frac) / (1 + frac);
  const ring = new Float32Array(N);
  const seed = new Float32Array(N);
  // harder picking is brighter, not merely louder — that link is most of what
  // makes a line sound played rather than sequenced
  const bright = Math.min(0.85, 0.45 + velocity * 0.5);
  let prev = 0;
  for (let j = 0; j < N; j++) {
    const white = Math.random() * 2 - 1;
    prev = (1 - bright) * prev + bright * white;
    seed[j] = prev;
  }
  const comb = Math.max(1, Math.round(N * 0.16)); // pickup-position comb -> quack
  for (let j = 0; j < N; j++) ring[j] = seed[j] - 0.9 * seed[(j - comb + N) % N];
  // pick attack: a short bright click before the string settles, which is
  // most of what the ear uses to identify a plucked instrument
  const clickLen = Math.min(Math.floor(sr * 0.004), len);
  for (let j = 0; j < clickLen; j++) {
    const p = (start + j) % len;
    out[p] += velocity * 0.5 * (Math.random() * 2 - 1) * (1 - j / clickLen) ** 2;
  }
  let idx = 0;
  let apX = 0, apY = 0; // allpass state
  const dur = Math.min(len, Math.floor(sr * ringSec));
  for (let j = 0; j < dur; j++) {
    const p = (start + j) % len; // tail wraps -> seamless loop
    const next = (idx + 1) % N;
    const avg = 0.5 * (ring[idx] + ring[next]);
    apY = C * avg + apX - C * apY;
    apX = avg;
    ring[idx] = damp * apY;
    out[p] += velocity * ring[idx];
    idx = next;
  }
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
  const len = Math.floor(sr * totalBeats * spb);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  let beatCursor = 0;
  for (const step of steps) {
    renderStrumSpan(out, sr, len, step.semis, style, spb, beatCursor, step.beats);
    beatCursor += step.beats;
  }
  normalize(out, CHORD_LEVEL * 1.5);
  return buf;
}

// lay one chord's worth of strumming into the buffer, starting at a beat
function renderStrumSpan(out, sr, len, semis, style, spb, beatOffset, spanBeats) {
  const sweep = style.sweep ?? 0.045;
  const reps = Math.max(1, Math.round(spanBeats / style.beats));
  for (const evBase of style.events) {
   for (let rep = 0; rep < reps; rep++) {
    const ev = { ...evBase, t: evBase.t + beatOffset + rep * style.beats };
    let order = semis.map((_, i) => i);
    if (ev.strings === 'low') order = order.slice(0, 3);
    else if (ev.strings === 'high') order = order.slice(2);
    else if (ev.dir < 0) order = order.slice(2); // upstrokes skip low strings
    if (ev.dir < 0) order = [...order].reverse();
    order.forEach((stringIdx, k) => {
      const f = E2 * Math.pow(2, semis[stringIdx] / 12);
      pluckInto(out, sr, len, f, ev.t * spb + k * sweep, style.ring, style.damp,
        (CHORD_GAINS[stringIdx] ?? 0.15) * 2.2 * ev.g);
    });
   }
  }
}

// A riff is note data, not a chord: each entry has its own beat position,
// pitch and pick strength, so rests and phrasing survive into the loop.
function makeRiffBuffer(ctx, rootSemi, riffKey, spb) {
  const riff = RIFFS[riffKey] || RIFFS.rock;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * riff.beats * spb);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  for (const n of riff.notes) {
    const f = E2 * Math.pow(2, (rootSemi + n.s) / 12);
    pluckInto(out, sr, len, f, n.t * spb, n.r ?? riff.ring,
      riff.damp ?? 0.996, 0.55 * (n.g ?? 1));
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
  const len = Math.floor(sr * step * pattern.order.length);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  pattern.order.forEach((noteIdx, i) => {
    const semi = semis[noteIdx] ?? semis[semis.length - 1];
    pluckInto(out, sr, len, E2 * Math.pow(2, semi / 12), step * i, ring, 0.9965, 0.5);
  });
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
