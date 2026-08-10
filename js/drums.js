// ---------------------------------------------------------------------------
// Drums — a synthesised kit, and the grooves to play on it.
//
// No samples. Every voice is built from the same maths as the guitar: an
// envelope on an oscillator, or noise through a resonant filter. What makes
// it sound like a drummer rather than a drum machine is everything a grid
// leaves out — the weak hand hits softer and a hair late, ghost notes fill
// the gaps between backbeats, an open hat is choked by the next closed one,
// no two bars are identical, and the whole kit is heard in a room.
//
// Patterns are note data, like riffs.js: { t, d, g } — t in BEATS, d the
// drum, g how hard it was hit. Beat-relative, so KEY doesn't apply but BPM
// and transport sync do, for free.
//
// Nothing here touches Web Audio: renderDrums() writes floats into an array
// the caller owns, which is what lets the same code be rendered and measured
// outside a browser.
// ---------------------------------------------------------------------------

/* ------------------------------------------------------------- the kits --
   Each kit is a full set of numbers rather than a delta, because reading one
   should tell you what it sounds like. Frequencies in Hz, times in seconds. */

export const DRUM_KITS = {
  studio: {
    label: 'Studio',
    kickF: 52, kickSweep: 3.4, kickBend: 0.030, kickDecay: 0.30, kickClick: 0.55,
    snareF: 195, snareBody: 0.55, snareWire: 0.95, snareNoise: 1900, snareTail: 0.155,
    hatF: 8200, hatDecay: 0.042, hatOpen: 0.30,
    tomF: [230, 165, 108], tomDecay: 0.36,
    rideF: 520, crashF: 1100,
    drive: 1.25, room: 0.16, size: 0.011, tail: 0.10,
  },
  room: {
    label: 'Big room',
    kickF: 48, kickSweep: 3.8, kickBend: 0.036, kickDecay: 0.40, kickClick: 0.45,
    snareF: 180, snareBody: 0.62, snareWire: 1.0, snareNoise: 1750, snareTail: 0.24,
    hatF: 7600, hatDecay: 0.055, hatOpen: 0.42,
    tomF: [210, 150, 96], tomDecay: 0.52,
    rideF: 480, crashF: 980,
    drive: 1.15, room: 0.42, size: 0.021, tail: 0.34,
  },
  vintage: {
    label: 'Vintage',
    kickF: 58, kickSweep: 2.8, kickBend: 0.024, kickDecay: 0.20, kickClick: 0.35,
    snareF: 215, snareBody: 0.70, snareWire: 0.72, snareNoise: 1500, snareTail: 0.105,
    hatF: 6800, hatDecay: 0.034, hatOpen: 0.22,
    tomF: [260, 190, 125], tomDecay: 0.26,
    rideF: 560, crashF: 1250,
    drive: 1.7, room: 0.12, size: 0.008, tail: 0.05,
  },
  jazz: {
    label: 'Jazz',
    kickF: 66, kickSweep: 2.4, kickBend: 0.022, kickDecay: 0.17, kickClick: 0.28,
    snareF: 245, snareBody: 0.45, snareWire: 1.05, snareNoise: 2600, snareTail: 0.115,
    hatF: 9000, hatDecay: 0.030, hatOpen: 0.24,
    tomF: [290, 205, 140], tomDecay: 0.28,
    rideF: 610, crashF: 1400,
    drive: 1.0, room: 0.22, size: 0.014, tail: 0.16,
  },
  heavy: {
    label: 'Heavy',
    kickF: 46, kickSweep: 4.6, kickBend: 0.018, kickDecay: 0.16, kickClick: 1.0,
    snareF: 205, snareBody: 0.40, snareWire: 1.15, snareNoise: 2300, snareTail: 0.13,
    hatF: 8800, hatDecay: 0.030, hatOpen: 0.26,
    tomF: [225, 158, 100], tomDecay: 0.28,
    rideF: 540, crashF: 1050,
    drive: 2.1, room: 0.20, size: 0.013, tail: 0.12,
  },
};

// 'auto' lets the groove bring its own kit — a jazz ride pattern on a heavy
// kit is nobody's idea of jazz.
export function kitFor(kitKey, pattern) {
  if (kitKey && kitKey !== 'auto' && DRUM_KITS[kitKey]) return DRUM_KITS[kitKey];
  return DRUM_KITS[pattern && pattern.kit] || DRUM_KITS.studio;
}

/* ---------------------------------------------------------- the grooves --
   beats  = length of one bar in quarter notes
   swing  = where the offbeat eighth lands (0.5 straight, 0.667 full triplet)
   drag   = seconds the whole kit sits behind the click (negative = pushing)
   notes  = every bar; top = added to the first bar only (that's the crash);
   fill   = replaces everything from fillFrom onward, on the last bar only */

const at = (times, d, g) => times.map((t) => ({ t, d, g }));
const eighths = (n, d, strong, weak) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 0.5, d, g: i % 2 ? weak : strong }));
const sixteenths = (n, d, gains) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 0.25, d, g: gains[i % gains.length] }));

export const DRUM_PATTERNS = {
  rock: {
    label: 'Rock', beats: 4, kit: 'studio',
    // the one everybody knows: backbeat on 2 and 4, eighths on the hat
    notes: [
      ...at([0, 2.5], 'kick', 0.95), ...at([1, 3], 'snare', 0.9),
      ...eighths(8, 'hat', 0.6, 0.4),
    ],
    top: at([0], 'crash', 0.7),
    fillFrom: 3,
    fill: [{ t: 3, d: 'snare', g: 0.8 }, { t: 3.25, d: 'tom1', g: 0.75 },
           { t: 3.5, d: 'tom2', g: 0.8 }, { t: 3.75, d: 'tom3', g: 0.9 }],
  },

  punk: {
    label: 'Punk', beats: 4, kit: 'vintage', drag: -0.006, // always rushing
    notes: [
      ...at([0, 0.5, 2, 2.5], 'kick', 0.9), ...at([1, 3], 'snare', 1),
      ...eighths(8, 'hat', 0.72, 0.52),
    ],
    top: at([0], 'crash', 0.8),
    fillFrom: 3,
    fill: at([3, 3.25, 3.5, 3.75], 'snare', 0.9),
  },

  metal: {
    label: 'Metal', beats: 4, kit: 'heavy',
    // gallop kick under a hard backbeat
    notes: [
      ...at([0, 0.25, 0.75, 1.5, 2, 2.25, 2.75, 3.5], 'kick', 0.92),
      ...at([1, 3], 'snare', 1), ...eighths(8, 'hat', 0.65, 0.5),
    ],
    top: at([0], 'crash', 0.85),
    fillFrom: 3,
    fill: [...at([3, 3.25], 'tom1', 0.85), ...at([3.5], 'tom2', 0.9),
           ...at([3.75], 'tom3', 1), ...at([3, 3.5], 'kick', 0.9)],
  },

  blast: {
    label: 'Blast beat', beats: 4, kit: 'heavy', drag: -0.004,
    // kick and snare alternating on the sixteenths, ride riding it out
    notes: [
      ...sixteenths(16, 'kick', [0.9, 0, 0.85, 0]).filter((n) => n.g),
      ...sixteenths(16, 'snare', [0, 0.8, 0, 0.75]).filter((n) => n.g),
      ...eighths(8, 'ride', 0.5, 0.4),
    ],
    top: at([0], 'crash', 0.9),
  },

  blues: {
    label: 'Blues shuffle', beats: 4, kit: 'vintage', swing: 0.645,
    notes: [
      ...at([0, 2.5], 'kick', 0.9), ...at([1, 3], 'snare', 0.92),
      ...at([1.5, 3.5], 'snare', 0.16), // ghosts, the shuffle's whole feel
      ...eighths(8, 'hat', 0.55, 0.38),
    ],
    fillFrom: 3.5,
    fill: [{ t: 3.5, d: 'snare', g: 0.7 }, { t: 3.75, d: 'snare', g: 0.85 }],
  },

  jazz: {
    label: 'Jazz ride', beats: 4, kit: 'jazz', swing: 0.655, drag: 0.008,
    // spang-a-lang on the ride, hats closing under 2 and 4, kick feathered
    notes: [
      ...at([0, 1, 2, 3], 'ride', 0.55), ...at([1.5, 3.5], 'ride', 0.42),
      ...at([1, 3], 'hat', 0.45),
      ...at([0, 1, 2, 3], 'kick', 0.1),
      { t: 2.5, d: 'snare', g: 0.28 }, { t: 0.5, d: 'snare', g: 0.14 },
    ],
    fillFrom: 3,
    fill: [{ t: 3, d: 'snare', g: 0.45 }, { t: 3.5, d: 'tom1', g: 0.4 },
           { t: 3.75, d: 'snare', g: 0.5 }, { t: 3, d: 'hat', g: 0.4 }],
  },

  funk: {
    label: 'Funk', beats: 4, kit: 'studio',
    // sixteenth hats, ghosted snare, kick pushing off the grid
    notes: [
      ...at([0, 0.75, 2.5, 3], 'kick', 0.92), ...at([1, 3], 'snare', 0.95),
      ...at([0.5, 1.75, 2.25, 3.5], 'snare', 0.16),
      ...sixteenths(16, 'hat', [0.55, 0.26, 0.4, 0.26]),
      { t: 1.5, d: 'ohat', g: 0.45 },
    ],
    fillFrom: 3.5,
    fill: [{ t: 3.5, d: 'snare', g: 0.3 }, { t: 3.75, d: 'snare', g: 0.75 }],
  },

  disco: {
    label: 'Disco', beats: 4, kit: 'studio',
    notes: [
      ...at([0, 1, 2, 3], 'kick', 0.9), ...at([1, 3], 'snare', 0.82),
      ...at([0.5, 1.5, 2.5, 3.5], 'ohat', 0.5), ...at([0, 1, 2, 3], 'hat', 0.4),
      ...sixteenths(16, 'shaker', [0.16, 0.1, 0.13, 0.1]),
    ],
    top: at([0], 'crash', 0.55),
  },

  reggae: {
    label: 'One drop', beats: 4, kit: 'vintage',
    // nothing on the one — the kick and the rim land together on three
    notes: [
      { t: 2, d: 'kick', g: 0.95 }, { t: 2, d: 'rim', g: 0.8 },
      ...eighths(8, 'hat', 0.38, 0.26), ...at([1.5, 3.5], 'ohat', 0.3),
    ],
    fillFrom: 3.5,
    fill: [{ t: 3.5, d: 'tom2', g: 0.5 }, { t: 3.75, d: 'tom3', g: 0.6 }],
  },

  surf: {
    label: 'Surf', beats: 4, kit: 'vintage', drag: -0.004,
    // floor tom driving under the backbeat, the Wipe Out engine room
    notes: [
      ...at([0, 2], 'kick', 0.9), ...at([1, 3], 'snare', 0.95),
      ...eighths(8, 'tom3', 0.4, 0.28), ...eighths(8, 'ride', 0.35, 0.24),
    ],
    top: at([0], 'crash', 0.7),
    fillFrom: 3,
    fill: [...at([3, 3.25, 3.5, 3.75], 'tom2', 0.7), ...at([3, 3.5], 'tom3', 0.6)],
  },

  country: {
    label: 'Train beat', beats: 4, kit: 'vintage',
    // sixteenths on the snare with the accents doing the backbeat work
    notes: [
      ...at([0, 2], 'kick', 0.88),
      ...sixteenths(16, 'snare', [0.5, 0.22, 0.34, 0.22]),
      { t: 1, d: 'snare', g: 0.9 }, { t: 3, d: 'snare', g: 0.9 },
    ],
  },

  doom: {
    label: 'Doom', beats: 8, kit: 'room',
    // half time, all the space in the world
    notes: [
      ...at([0, 4, 4.75], 'kick', 0.95), ...at([2, 6], 'snare', 1),
      ...at([0, 1, 2, 3, 4, 5, 6, 7], 'ride', 0.32),
    ],
    top: at([0], 'crash', 0.8),
    fillFrom: 7,
    fill: [{ t: 7, d: 'tom2', g: 0.8 }, { t: 7.5, d: 'tom3', g: 0.9 }],
  },

  postrock: {
    label: 'Post-rock', beats: 8, kit: 'room',
    // cross-stick verse turning over into the snare, the way the build works
    notes: [
      ...at([0, 3, 4, 6.5], 'kick', 0.8), { t: 2, d: 'rim', g: 0.5 },
      { t: 6, d: 'snare', g: 0.7 },
      ...eighths(16, 'hat', 0.3, 0.2),
    ],
    fillFrom: 7,
    fill: [...at([7, 7.25], 'tom1', 0.6), ...at([7.5], 'tom2', 0.7),
           ...at([7.75], 'tom3', 0.8)],
  },

  grunge: {
    label: 'Grunge', beats: 4, kit: 'room', drag: 0.006, // dragging on purpose
    notes: [
      ...at([0, 0.75, 2.5], 'kick', 0.95), ...at([1, 3], 'snare', 1),
      ...at([0, 1, 2, 3], 'ohat', 0.5), ...at([0.5, 1.5, 2.5, 3.5], 'hat', 0.4),
    ],
    top: at([0], 'crash', 0.85),
    fillFrom: 3,
    fill: [{ t: 3, d: 'snare', g: 0.9 }, { t: 3.5, d: 'tom2', g: 0.8 },
           { t: 3.75, d: 'tom3', g: 0.95 }],
  },

  slacker: {
    label: 'Slacker', beats: 4, kit: 'jazz', drag: 0.016, // way behind the beat
    notes: [
      ...at([0, 2.5], 'kick', 0.8), ...at([1, 3], 'rim', 0.55),
      ...eighths(8, 'hat', 0.3, 0.2),
      ...sixteenths(16, 'shaker', [0.12, 0.07, 0.1, 0.07]),
    ],
  },

  bossa: {
    label: 'Bossa', beats: 4, kit: 'jazz',
    // the clave on the rim, brushes underneath, kick barely there
    notes: [
      ...at([0, 0.75, 1.5, 2.5, 3], 'rim', 0.55),
      ...at([0, 1.5, 2, 3.5], 'kick', 0.4),
      ...eighths(8, 'hat', 0.28, 0.2),
    ],
  },

  desert: {
    label: 'Desert', beats: 4, kit: 'room',
    // tom-led and hypnotic, the snare only marking the turn
    notes: [
      ...at([0, 1.5], 'tom3', 0.7), { t: 2, d: 'tom3', g: 0.6 },
      { t: 2.5, d: 'tom2', g: 0.55 },
      ...at([0, 2.5], 'kick', 0.85), ...at([1, 3], 'snare', 0.6),
      ...sixteenths(16, 'shaker', [0.14, 0.08, 0.11, 0.08]),
    ],
  },

  ballad: {
    label: 'Ballad', beats: 4, kit: 'room',
    notes: [
      ...at([0, 2.5], 'kick', 0.75), { t: 2, d: 'rim', g: 0.55 },
      ...eighths(8, 'hat', 0.26, 0.18),
    ],
    fillFrom: 3.5,
    fill: [{ t: 3.5, d: 'tom2', g: 0.45 }, { t: 3.75, d: 'tom3', g: 0.55 }],
  },

  waltz: {
    label: 'Waltz', beats: 3, kit: 'jazz',
    notes: [
      { t: 0, d: 'kick', g: 0.8 }, ...at([1, 2], 'snare', 0.45),
      ...at([0, 1, 2], 'hat', 0.32),
    ],
  },
};

/* -------------------------------------------------- matching the band --
   Which groove goes with what the rest of the room is playing. Riff genres
   mostly share a name with a groove; strum styles need a translation. */

const STRUM_DRUMS = {
  ring: 'ballad', steady: 'rock', ballad: 'ballad', folk: 'country',
  waltz: 'waltz', chop: 'funk', reggae: 'reggae', punk: 'punk',
  flamenco: 'bossa', train: 'country', shuffle: 'blues', disco: 'disco',
  surf: 'surf', country: 'country', bossa: 'bossa', doom: 'doom',
  blackmetal: 'blast', deathmetal: 'blast', metal: 'metal', stoner: 'doom',
  garage: 'rock', grunge: 'grunge', funk: 'funk',
};

// What should the drummer play behind a source in this state? Riffs win over
// strums because a riff is the more specific statement of a genre.
export function drumsFor(state) {
  if (!state) return null;
  if (state.mode === 'riff') {
    const key = state.riff || 'rock';
    return DRUM_PATTERNS[key] ? key : 'rock';
  }
  if (state.mode === 'chord') return STRUM_DRUMS[state.strumStyle] || 'rock';
  if (state.mode === 'arp') return 'ballad';
  if (state.mode === 'guitar') return 'rock'; // no idea what they'll play
  return null;
}

/* ------------------------------------------------------------- the kit --
   Voices, in the order a drummer would name them. Each writes into `out`
   with the start index wrapped, so a tail that runs past the loop point
   comes back in at the top and the loop is seamless. */

// Topology-preserving state variable filter — stable at any cutoff, which
// matters when a hi-hat wants 9 kHz out of a 44.1 kHz buffer.
function svf(sr, fc, Q) {
  const g = Math.tan(Math.PI * Math.min(0.49, fc / sr));
  const k = 1 / Q;
  const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
  let ic1 = 0, ic2 = 0;
  return {
    lp: 0, bp: 0, hp: 0,
    run(x) {
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      this.bp = v1; this.lp = v2; this.hp = x - k * v1 - v2;
    },
  };
}

const noise = () => Math.random() * 2 - 1;

function kick(out, sr, start, g, k) {
  const decay = k.kickDecay * (0.72 + 0.5 * g);
  const n = Math.min(out.length, Math.floor(sr * (decay * 4 + 0.02)));
  const fEnd = k.kickF, fStart = fEnd * k.kickSweep;
  const click = svf(sr, 2600, 0.8);
  let ph = 0;
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    // the beater drives the head sharp for an instant, then it settles
    const f = fEnd + (fStart - fEnd) * Math.exp(-t / k.kickBend);
    ph += (2 * Math.PI * f) / sr;
    let s = Math.sin(ph) * Math.exp(-t / decay);
    if (t < 0.007) {
      click.run(noise());
      s += click.hp * (1 - t / 0.007) * k.kickClick * 0.6;
    }
    out[(start + j) % out.length] += Math.tanh(s * g * k.drive * 1.5) * 0.72;
  }
}

function snare(out, sr, start, g, k) {
  // harder hits are brighter and ring longer — that link is most of what
  // separates a backbeat from a ghost note
  const bodyDec = 0.075 * (0.65 + 0.6 * g);
  const wireDec = k.snareTail * (0.45 + 0.85 * g);
  const n = Math.min(out.length, Math.floor(sr * (Math.max(bodyDec, wireDec) * 4 + 0.01)));
  const band = svf(sr, k.snareNoise * (0.7 + 0.5 * g), 0.85);
  const snap = svf(sr, 5200, 0.7);
  const w1 = (2 * Math.PI * k.snareF) / sr, w2 = (2 * Math.PI * k.snareF * 1.63) / sr;
  let p1 = 0, p2 = 0;
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    const head = (Math.sin(p1) * 0.72 + Math.sin(p2) * 0.4) * Math.exp(-t / bodyDec);
    p1 += w1; p2 += w2;
    const nz = noise();
    band.run(nz);
    snap.run(nz);
    const wires = band.bp * Math.exp(-t / wireDec) * k.snareWire;
    const stick = t < 0.02 ? snap.hp * Math.exp(-t / 0.006) * 0.55 * g : 0;
    out[(start + j) % out.length] +=
      Math.tanh((head * k.snareBody + wires + stick) * g * k.drive) * 0.55;
  }
}

// cross-stick: the click of wood on a rim, with the shell answering underneath
function rim(out, sr, start, g, k) {
  const n = Math.min(out.length, Math.floor(sr * 0.14));
  const body = svf(sr, 840, 7);
  const click = svf(sr, 3400, 0.8);
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    const nz = noise();
    body.run(nz * (t < 0.003 ? 1 : 0));
    click.run(nz);
    const s = body.bp * 2.2 * Math.exp(-t / 0.045)
      + (t < 0.004 ? click.hp * (1 - t / 0.004) * 0.5 : 0);
    out[(start + j) % out.length] += s * g * 0.5;
  }
}

// one function for closed and open: a cymbal is a cymbal, it's the foot that
// decides how long it rings. maxDur is how long until the next hat chokes it.
function cymbalHat(out, sr, start, g, k, decay, maxDur) {
  const dur = Math.min(decay * 4 + 0.005, maxDur);
  const n = Math.min(out.length, Math.floor(sr * dur));
  const hp = svf(sr, k.hatF, 0.7);
  const r1 = svf(sr, k.hatF * 1.47, 5);
  const r2 = svf(sr, k.hatF * 2.13, 7);
  const choke = maxDur < decay * 4 ? maxDur : Infinity; // fade, don't cut
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    const nz = noise();
    hp.run(nz); r1.run(nz); r2.run(nz);
    let a = Math.exp(-t / decay);
    if (t < 0.0008) a *= t / 0.0008;                      // no click on attack
    if (choke !== Infinity && t > choke - 0.006) a *= Math.max(0, (choke - t) / 0.006);
    const s = (hp.hp * 0.8 + r1.bp * 0.22 + r2.bp * 0.18) * a;
    out[(start + j) % out.length] += s * g * 0.42;
  }
}

function ride(out, sr, start, g, k) {
  const n = Math.min(out.length, Math.floor(sr * 1.1));
  const wash = svf(sr, 3600, 0.6);
  // a ride is a ping riding on a wash — the inharmonic partials are the ping
  const parts = [1, 1.51, 2.34, 3.17].map((m) => (2 * Math.PI * k.rideF * m) / sr);
  const ph = [0, 0, 0, 0];
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    let ping = 0;
    for (let p = 0; p < parts.length; p++) {
      ph[p] += parts[p];
      ping += Math.sin(ph[p]) * (0.5 / (p + 1));
    }
    wash.run(noise());
    const s = ping * Math.exp(-t / 0.34) * 0.5
      + wash.hp * Math.exp(-t / 0.75) * 0.35;
    out[(start + j) % out.length] += s * g * 0.32;
  }
}

function crash(out, sr, start, g, k) {
  const n = Math.min(out.length, Math.floor(sr * 2.4));
  const hp = svf(sr, k.crashF, 0.5);
  const r1 = svf(sr, k.crashF * 2.7, 3);
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    const nz = noise();
    hp.run(nz); r1.run(nz);
    // a crash takes a few milliseconds to bloom, and dies slowly
    const a = Math.min(1, t / 0.006) * Math.exp(-t / 0.62);
    out[(start + j) % out.length] += (hp.hp * 0.7 + r1.bp * 0.3) * a * g * 0.3;
  }
}

function tom(out, sr, start, g, k, which) {
  const f = k.tomF[which];
  const decay = k.tomDecay * (0.7 + 0.5 * g);
  const n = Math.min(out.length, Math.floor(sr * (decay * 4 + 0.01)));
  const w1 = (2 * Math.PI * f) / sr, w2 = (2 * Math.PI * f * 1.58) / sr;
  const skin = svf(sr, 3000, 0.8);
  let p1 = 0, p2 = 0;
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    const bend = 1 + 0.14 * Math.exp(-t / 0.045); // heads bend sharp when struck
    p1 += w1 * bend; p2 += w2 * bend;
    let s = (Math.sin(p1) * 0.8 + Math.sin(p2) * 0.25) * Math.exp(-t / decay);
    if (t < 0.005) {
      skin.run(noise());
      s += skin.hp * (1 - t / 0.005) * 0.35;
    }
    out[(start + j) % out.length] += Math.tanh(s * g * k.drive) * 0.5;
  }
}

function shaker(out, sr, start, g) {
  const n = Math.min(out.length, Math.floor(sr * 0.09));
  const hp = svf(sr, 5200, 0.8);
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    hp.run(noise());
    // beads accelerate into the shell and stop dead — attack, then nothing
    const a = Math.min(1, t / 0.004) * Math.exp(-t / 0.022);
    out[(start + j) % out.length] += hp.hp * a * g * 0.32;
  }
}

const VOICES = {
  kick, snare, rim, ride, crash, shaker,
  hat: (out, sr, s, g, k, choke) => cymbalHat(out, sr, s, g, k, k.hatDecay * (0.6 + 0.7 * g), choke),
  ohat: (out, sr, s, g, k, choke) => cymbalHat(out, sr, s, g, k, k.hatOpen, choke),
  tom1: (out, sr, s, g, k) => tom(out, sr, s, g, k, 0),
  tom2: (out, sr, s, g, k) => tom(out, sr, s, g, k, 1),
  tom3: (out, sr, s, g, k) => tom(out, sr, s, g, k, 2),
};

/* ---------------------------------------------------------------- room --
   Close mics alone sound like a kit in an anechoic box. Early reflections
   off a few surfaces, then a short damped tail, is what says "a room".
   Every delay wraps around the buffer, so the room survives the loop point. */

function addRoom(out, sr, k) {
  const len = out.length;
  if (!k.room || len < 64) return;
  // each bounce eats the top end, so reflect a darkened copy, not the dry one
  const dark = new Float32Array(len);
  const a = Math.exp((-2 * Math.PI * 3200) / sr);
  let lp = 0;
  for (let i = 0; i < len; i++) { lp = lp * a + out[i] * (1 - a); dark[i] = lp; }
  for (const [m, gain] of [[1, 0.62], [1.7, 0.5], [2.6, 0.4], [3.9, 0.3], [5.3, 0.22], [7.1, 0.16]]) {
    const d = Math.round(k.size * m * sr) % len;
    for (let i = 0; i < len; i++) out[i] += dark[(i - d + len) % len] * gain * k.room;
  }
  if (!k.tail) return;
  // two damped combs, run twice so the decay is already in flight at sample 0
  const wet = new Float32Array(len);
  for (const [ms, fb] of [[0.037, 0.62], [0.051, 0.57]]) {
    const d = Math.max(1, Math.round(ms * sr) % len);
    const buf = new Float32Array(d);
    let p = 0, damp = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < len; i++) {
        const y = buf[p];
        damp = damp * 0.42 + y * 0.58;
        buf[p] = dark[i] + damp * fb;
        p = (p + 1) % d;
        if (pass) wet[i] += y;
      }
    }
  }
  for (let i = 0; i < len; i++) out[i] += wet[i] * k.tail * 0.35;
}

/* ------------------------------------------------------------ the player --
   How a person differs from a grid. Per drum: how far it sits off the click
   on average, how much that wanders, and how much the force varies. */

const FEEL = {
  kick:  { push: -0.003, jit: 0.006, vel: 0.07 },
  snare: { push: 0.003, jit: 0.007, vel: 0.10 },
  rim:   { push: 0.002, jit: 0.006, vel: 0.10 },
  hat:   { push: -0.001, jit: 0.004, vel: 0.13 },
  ohat:  { push: -0.001, jit: 0.005, vel: 0.12 },
  ride:  { push: 0.001, jit: 0.005, vel: 0.12 },
  crash: { push: -0.002, jit: 0.005, vel: 0.08 },
  tom1:  { push: 0.001, jit: 0.006, vel: 0.09 },
  tom2:  { push: 0.001, jit: 0.006, vel: 0.09 },
  tom3:  { push: 0.002, jit: 0.006, vel: 0.09 },
  shaker: { push: 0, jit: 0.004, vel: 0.16 },
};
const DEFAULT_FEEL = { push: 0, jit: 0.005, vel: 0.1 };

// swing: the offbeat eighth lands late. 0.5 is straight, 2/3 is a full triplet.
function swung(t, swing) {
  if (!swing || swing === 0.5) return t;
  const beat = Math.floor(t), frac = t - beat;
  return Math.abs(frac - 0.5) < 1e-6 ? beat + swing : t;
}

/* --------------------------------------------------------------- render --
   Writes `bars` bars of `pattern` into `out`. The caller owns the array and
   has already sized it to bars * pattern.beats * spb seconds. */

export function renderDrums(out, sr, spb, pattern, kit, bars) {
  const k = kit;
  const beats = pattern.beats;
  const events = [];

  for (let bar = 0; bar < bars; bar++) {
    const last = bar === bars - 1;
    const from = last && pattern.fill ? (pattern.fillFrom ?? 0) : Infinity;
    const notes = pattern.notes.filter((n) => n.t < from)
      .concat(last && pattern.fill ? pattern.fill : [])
      .concat(bar === 0 && pattern.top ? pattern.top : []);
    // the weak hand is softer and a shade late; count each drum's hits per bar
    const hand = {};
    for (const n of notes.slice().sort((x, y) => x.t - y.t)) {
      const feel = FEEL[n.d] || DEFAULT_FEEL;
      const i = (hand[n.d] = (hand[n.d] || 0) + 1) - 1;
      const weak = i % 2 === 1 && (n.d === 'hat' || n.d === 'shaker' || n.d === 'ride');
      const beat = bar * beats + swung(n.t, pattern.swing);
      const jitter = (Math.random() - 0.5) * 2 * feel.jit;
      events.push({
        at: beat * spb + feel.push + jitter + (pattern.drag || 0) + (weak ? 0.0015 : 0),
        d: n.d,
        g: Math.max(0.02, n.g * (weak ? 0.88 : 1)
          * (1 + (Math.random() - 0.5) * 2 * feel.vel)),
      });
    }
  }
  events.sort((x, y) => x.at - y.at);

  // an open hat rings until the foot comes down on the next one
  const loopSec = bars * beats * spb;
  for (let i = 0; i < events.length; i++) {
    if (events[i].d !== 'ohat') continue;
    let next = loopSec + events[0].at; // wraps: the first hat of the next pass
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].d === 'hat' || events[j].d === 'ohat') { next = events[j].at; break; }
    }
    events[i].choke = Math.max(0.03, next - events[i].at);
  }

  for (const e of events) {
    const voice = VOICES[e.d];
    if (!voice) continue;
    const start = ((Math.round(e.at * sr) % out.length) + out.length) % out.length;
    voice(out, sr, start, e.g, k, e.choke ?? Infinity);
  }
  addRoom(out, sr, k);
}

// how many bars to render into one loop: long enough that the ear stops
// hearing the repeat, short enough not to eat memory at slow tempos
export function drumBars(pattern) {
  return Math.max(2, Math.min(4, Math.round(16 / pattern.beats)));
}
