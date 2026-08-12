// ---------------------------------------------------------------------------
// Bass — lines, and the four ways of getting a note out of the instrument.
//
// Data only, like riffs.js: makeBassBuffer() in audio.js turns this into
// sound. Each note is { t, s, g }: t in BEATS, s in semitones above the
// CHORD's root (not the key's), g how hard it was plucked. A line therefore
// transposes itself through a progression for free — which is most of what a
// bass player does.
//
// s = 0 is the open low E an octave under the guitar. Bass lines live on the
// root, the fifth (7) and the octave (12); thirds are left to the walking
// line, which is the only one that needs to know major from minor.
// ---------------------------------------------------------------------------

const on = (times, s, g) => times.map((t) => ({ t, s, g }));
const run = (n, step, s, g) =>
  Array.from({ length: n }, (_, i) => ({ t: i * step, s, g: g - (i % 2) * 0.12 }));

export const BASS_LINES = {
  roots: {
    label: 'Roots', beats: 4,
    // one note a bar, held — the line that never gets in the way
    notes: [{ t: 0, s: 0, g: 1 }],
  },

  pump: {
    label: 'Pump', beats: 4,
    // quarter notes on the root: the engine room of most rock records
    notes: on([0, 1, 2, 3], 0, 0.95).map((n, i) => ({ ...n, g: i ? 0.82 : 1 })),
  },

  eighths: {
    label: 'Driving 8ths', beats: 4,
    notes: run(8, 0.5, 0, 0.95),
  },

  gallop: {
    label: 'Gallop', beats: 4, // locks to the metal riff
    notes: [0, 1, 2, 3].flatMap((b) => [
      { t: b, s: 0, g: 1 }, { t: b + 0.5, s: 0, g: 0.78 }, { t: b + 0.75, s: 0, g: 0.84 },
    ]),
  },

  octaves: {
    label: 'Octaves', beats: 4,
    // root-up-root-up: disco, and every dance record since
    notes: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => ({
      t, s: i % 2 ? 12 : 0, g: i % 2 ? 0.78 : 0.98 })),
  },

  walking: {
    label: 'Walking', beats: 4, swing: 0.655, walk: true,
    // one note a beat, climbing to the next chord — see makeBassBuffer, which
    // rewrites the last note as a chromatic approach to whatever comes next
    notes: [{ t: 0, s: 0, g: 0.95 }, { t: 1, s: 4, g: 0.82 },
            { t: 2, s: 7, g: 0.88 }, { t: 3, s: 9, g: 0.82 }],
  },

  shuffle: {
    label: 'Shuffle', beats: 4, swing: 0.645,
    notes: [{ t: 0, s: 0, g: 1 }, { t: 0.5, s: 7, g: 0.7 },
            { t: 1, s: 0, g: 0.85 }, { t: 1.5, s: 9, g: 0.72 },
            { t: 2, s: 0, g: 0.95 }, { t: 2.5, s: 7, g: 0.7 },
            { t: 3, s: 0, g: 0.85 }, { t: 3.5, s: 10, g: 0.75 }],
  },

  country: {
    label: 'Root-fifth', beats: 4,
    // boom-chick: the root on one, the fifth on three, forever
    notes: [{ t: 0, s: 0, g: 1 }, { t: 1, s: 7, g: 0.8 },
            { t: 2, s: 0, g: 0.95 }, { t: 3, s: 7, g: 0.8 }],
  },

  funk: {
    label: 'Funk', beats: 4,
    // sixteenths, ghost notes, an octave pop and a lot of deliberate silence
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0.25, s: 0, g: 0.22 },
      { t: 0.75, s: 12, g: 0.85 }, { t: 1.25, s: 0, g: 0.3 },
      { t: 1.5, s: 0, g: 0.9 }, { t: 2.25, s: 10, g: 0.7 },
      { t: 2.5, s: 12, g: 0.8 }, { t: 3, s: 7, g: 0.75 },
      { t: 3.25, s: 0, g: 0.25 }, { t: 3.75, s: 0, g: 0.8 },
    ],
  },

  motown: {
    label: 'Motown', beats: 4,
    // melodic and busy, always moving somewhere
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0.5, s: 7, g: 0.75 }, { t: 1, s: 12, g: 0.8 },
      { t: 1.5, s: 10, g: 0.72 }, { t: 2, s: 7, g: 0.85 }, { t: 2.5, s: 5, g: 0.7 },
      { t: 3, s: 3, g: 0.78 }, { t: 3.5, s: 2, g: 0.7 },
    ],
  },

  reggae: {
    label: 'Dub', beats: 4,
    // the space is the instrument; nothing on the one
    notes: [
      { t: 0.5, s: 0, g: 0.95 }, { t: 1, s: 0, g: 0.8 },
      { t: 2.5, s: 10, g: 0.9 }, { t: 3, s: 7, g: 0.85 },
    ],
  },

  surf: {
    label: 'Surf', beats: 4,
    notes: run(8, 0.5, 0, 0.9).map((n, i) => (i === 5 ? { ...n, s: 7 } : n)),
  },

  ballad: {
    label: 'Ballad', beats: 8,
    // whole notes, the fifth halfway through to stop it sitting still
    notes: [{ t: 0, s: 0, g: 0.9 }, { t: 4, s: 7, g: 0.75 }],
  },

  doom: {
    label: 'Doom', beats: 8,
    notes: [{ t: 0, s: 0, g: 1 }, { t: 3, s: 3, g: 0.85 }, { t: 5.5, s: 5, g: 0.85 }],
  },

  pedal: {
    label: 'Pedal note', beats: 4,
    // stays on the key's root through every change — see makeBassBuffer
    notes: run(8, 0.5, 0, 0.88), pedal: true,
  },
};

/* ------------------------------------------------------------- the tone --
   How the note is produced, rather than which note it is.
     ring   seconds the note is allowed to sound
     damp   Karplus-Strong loop loss per period — higher sustains longer
     bright how much top end is in the pluck itself
     tone   how much top end survives ONE trip round the string. This is the
            one that makes a bass a bass: a wound string is a low-pass filter
            you hit, and without it you get a very large guitar.
     click  the attack transient — a fingerpad has almost none, a pick plenty */

export const BASS_TONES = {
  finger: { label: 'Fingered', ring: 2.6, damp: 0.9985, bright: 0.16, tone: 0.30, click: 0.14 },
  pick:   { label: 'Picked', ring: 2.0, damp: 0.9975, bright: 0.34, tone: 0.52, click: 0.45 },
  muted:  { label: 'Palm muted', ring: 0.42, damp: 0.988, bright: 0.18, tone: 0.26, click: 0.26 },
  flat:   { label: 'Flatwound', ring: 3.2, damp: 0.9988, bright: 0.10, tone: 0.18, click: 0.07 },
};

/* --------------------------------------------------- matching the band -- */

const RIFF_BASS = {
  rock: 'pump', blues: 'shuffle', surf: 'surf', reggae: 'reggae', metal: 'gallop',
  punk: 'eighths', funk: 'funk', country: 'country', jazz: 'walking', doom: 'doom',
  spanish: 'roots', postrock: 'ballad', grunge: 'pump', disco: 'octaves',
  slacker: 'motown', desert: 'pedal',
};

const STRUM_BASS = {
  ring: 'ballad', steady: 'pump', ballad: 'ballad', folk: 'country', waltz: 'roots',
  chop: 'funk', reggae: 'reggae', punk: 'eighths', flamenco: 'roots',
  train: 'country', shuffle: 'shuffle', disco: 'octaves', surf: 'surf',
  country: 'country', bossa: 'roots', doom: 'doom', blackmetal: 'gallop',
  deathmetal: 'gallop', metal: 'gallop', stoner: 'doom', garage: 'pump',
  grunge: 'pump', funk: 'funk',
};

// What should the bass player play behind a source in this state? Same shape
// as drumsFor() in drums.js, and deliberately so — including the fallback to
// a baked riff's own genre, since its id is meaningless to this table.
export function bassFor(state, riff) {
  if (!state) return null;
  if (state.mode === 'riff') {
    return RIFF_BASS[state.riff] || RIFF_BASS[riff?.genre]
      || (BASS_LINES[riff?.genre] ? riff.genre : 'pump');
  }
  if (state.mode === 'chord') return STRUM_BASS[state.strumStyle] || 'pump';
  if (state.mode === 'arp') return 'ballad';
  if (state.mode === 'guitar') return 'roots'; // stay out of the way
  return null;
}
