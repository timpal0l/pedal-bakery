// ---------------------------------------------------------------------------
// Riffs — short genre phrases, written as note data rather than chords.
//
// Each note is { t, s, g }: t = start in BEATS, s = semitones above the
// source's root, g = pick strength. Rests are simply gaps in t, which is
// what makes these read as playing rather than strumming. Everything is
// beat-relative, so KEY, BPM and transport sync all apply for free.
//
// s = 0 is the low root (E2 register), 12 the octave, 19 the fifth above
// that — roughly where a guitar's low and middle strings sit.
// ---------------------------------------------------------------------------

// helper: repeat a note figure across several beats
const every = (count, step, make) =>
  Array.from({ length: count }, (_, i) => make(i * step, i)).flat();

export const RIFFS = {
  rock: {
    label: 'Rock', beats: 4, ring: 0.9, damp: 0.9955,
    // the boogie: root drone with the fifth/sixth walking underneath it
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0, s: 12, g: 0.55 }, { t: 0.5, s: 7, g: 0.85 },
      { t: 1, s: 0, g: 0.9 }, { t: 1.5, s: 9, g: 0.85 },
      { t: 2, s: 0, g: 1 }, { t: 2, s: 12, g: 0.55 }, { t: 2.5, s: 7, g: 0.85 },
      { t: 3, s: 0, g: 0.9 }, { t: 3.5, s: 9, g: 0.85 },
    ],
  },

  blues: {
    label: 'Blues', beats: 8, ring: 1.1, damp: 0.9965,
    // shuffle feel: swung eighths, turnaround on the flat seventh
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0.66, s: 7, g: 0.8 }, { t: 1.33, s: 9, g: 0.85 },
      { t: 2, s: 10, g: 0.9 }, { t: 2.66, s: 9, g: 0.8 }, { t: 3.33, s: 7, g: 0.75 },
      { t: 4, s: 0, g: 1 }, { t: 4.66, s: 7, g: 0.8 }, { t: 5.33, s: 9, g: 0.85 },
      { t: 6, s: 7, g: 0.8 }, { t: 6.66, s: 3, g: 0.7 }, { t: 7.33, s: 0, g: 0.95 },
    ],
  },

  surf: {
    label: 'Surf', beats: 8, ring: 0.55, damp: 0.993,
    // phrygian run, double-picked the way surf leads are
    notes: [0, 1, 4, 5, 7, 5, 4, 1].flatMap((s, i) => [
      { t: i * 0.5, s: s + 12, g: 0.95 },
      { t: i * 0.5 + 0.25, s: s + 12, g: 0.6 },
    ]).concat([
      { t: 4, s: 12, g: 1 }, { t: 4.5, s: 11, g: 0.8 }, { t: 5, s: 9, g: 0.8 },
      { t: 5.5, s: 8, g: 0.8 }, { t: 6, s: 7, g: 0.9 }, { t: 7, s: 0, g: 1 },
    ]),
  },

  reggae: {
    label: 'Reggae', beats: 4, ring: 0.5, damp: 0.991,
    // bass on the one, skank chords on the offbeats, space everywhere else
    notes: [
      { t: 0, s: 0, g: 1 },
      { t: 0.5, s: 12, g: 0.5 }, { t: 0.5, s: 16, g: 0.5 }, { t: 0.5, s: 19, g: 0.45 },
      { t: 1.5, s: 12, g: 0.5 }, { t: 1.5, s: 16, g: 0.5 }, { t: 1.5, s: 19, g: 0.45 },
      { t: 2, s: 7, g: 0.85 },
      { t: 2.5, s: 12, g: 0.5 }, { t: 2.5, s: 16, g: 0.5 }, { t: 2.5, s: 19, g: 0.45 },
      { t: 3.5, s: 12, g: 0.5 }, { t: 3.5, s: 16, g: 0.5 }, { t: 3.5, s: 19, g: 0.45 },
    ],
  },

  metal: {
    label: 'Metal', beats: 4, ring: 0.3, damp: 0.986,
    // palm-muted gallop on the root, chromatic stabs answering it
    notes: every(4, 1, (t) => [
      { t, s: 0, g: 1 }, { t: t + 0.5, s: 0, g: 0.8 }, { t: t + 0.75, s: 0, g: 0.85 },
    ]).concat([
      { t: 1.5, s: 1, g: 0.9 }, { t: 3.25, s: 6, g: 0.9 }, { t: 3.5, s: 5, g: 0.85 },
    ]),
  },

  punk: {
    label: 'Punk', beats: 4, ring: 0.6, damp: 0.992,
    // relentless downstroke power chords, no subtlety intended
    notes: every(8, 0.5, (t, i) => [
      { t, s: 0, g: i % 2 ? 0.85 : 1 }, { t, s: 7, g: i % 2 ? 0.7 : 0.85 },
    ]),
  },

  funk: {
    label: 'Funk', beats: 4, ring: 0.22, damp: 0.98,
    // sixteenth syncopation: ghost notes, octave pops, lots of air
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0.25, s: 0, g: 0.35 },
      { t: 0.75, s: 12, g: 0.9 }, { t: 1, s: 15, g: 0.6 },
      { t: 1.5, s: 0, g: 0.85 }, { t: 1.75, s: 0, g: 0.3 },
      { t: 2.25, s: 12, g: 0.95 }, { t: 2.5, s: 10, g: 0.6 },
      { t: 3, s: 7, g: 0.8 }, { t: 3.25, s: 0, g: 0.35 }, { t: 3.75, s: 12, g: 0.7 },
    ],
  },

  country: {
    label: 'Country', beats: 4, ring: 0.8, damp: 0.995,
    // alternating bass under a chicken-pickin' double stop
    notes: [
      { t: 0, s: 0, g: 1 },
      { t: 0.5, s: 16, g: 0.7 }, { t: 0.5, s: 19, g: 0.65 },
      { t: 1, s: 7, g: 0.9 },
      { t: 1.5, s: 16, g: 0.7 }, { t: 1.5, s: 19, g: 0.65 },
      { t: 2, s: 0, g: 1 }, { t: 2.5, s: 17, g: 0.7 }, { t: 2.75, s: 16, g: 0.6 },
      { t: 3, s: 7, g: 0.9 }, { t: 3.5, s: 19, g: 0.7 },
    ],
  },

  jazz: {
    label: 'Jazz', beats: 8, ring: 1.0, damp: 0.9965,
    // walking bass line, one note per beat, chromatic approach into the turn
    notes: [0, 4, 7, 9, 10, 9, 7, 4].map((s, i) => ({ t: i, s, g: i % 2 ? 0.75 : 0.9 })),
  },

  doom: {
    label: 'Doom', beats: 8, ring: 4.5, damp: 0.9985,
    // vast spaces between very few notes
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0, s: 7, g: 0.7 },
      { t: 3, s: 3, g: 0.9 }, { t: 3, s: 10, g: 0.6 },
      { t: 5.5, s: 5, g: 0.9 }, { t: 7, s: 0, g: 0.8 },
    ],
  },

  spanish: {
    label: 'Spanish', beats: 8, ring: 1.4, damp: 0.997,
    // the Andalusian cadence: i - VII - VI - V, descending
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0.5, s: 12, g: 0.7 }, { t: 1, s: 15, g: 0.7 },
      { t: 2, s: 10, g: 0.95 }, { t: 2.5, s: 22, g: 0.6 },
      { t: 4, s: 8, g: 0.95 }, { t: 4.5, s: 20, g: 0.6 },
      { t: 6, s: 7, g: 1 }, { t: 6.5, s: 19, g: 0.7 }, { t: 7, s: 20, g: 0.6 },
      { t: 7.5, s: 19, g: 0.6 },
    ],
  },

  postrock: {
    label: 'Post-rock', beats: 8, ring: 2.6, damp: 0.998,
    // high, spacious, delay-friendly — written to be drowned in reverb
    notes: [
      { t: 0, s: 19, g: 0.9 }, { t: 0.75, s: 24, g: 0.8 }, { t: 1.5, s: 22, g: 0.75 },
      { t: 2.5, s: 19, g: 0.85 }, { t: 3.25, s: 26, g: 0.7 },
      { t: 4, s: 17, g: 0.9 }, { t: 4.75, s: 24, g: 0.75 }, { t: 5.5, s: 21, g: 0.7 },
      { t: 6.5, s: 12, g: 0.85 }, { t: 7.25, s: 19, g: 0.7 },
    ],
  },

  grunge: {
    label: 'Grunge', beats: 8, ring: 1.2, damp: 0.995,
    // sludgy power chords with a tritone that refuses to resolve
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 0, s: 7, g: 0.8 },
      { t: 1.5, s: 0, g: 0.9 }, { t: 1.5, s: 7, g: 0.7 },
      { t: 2.5, s: 3, g: 0.95 }, { t: 2.5, s: 10, g: 0.75 },
      { t: 4, s: 6, g: 1 }, { t: 4, s: 13, g: 0.8 },
      { t: 5.5, s: 5, g: 0.9 }, { t: 6.5, s: 0, g: 1 }, { t: 6.5, s: 7, g: 0.8 },
    ],
  },

  disco: {
    label: 'Disco', beats: 4, ring: 0.35, damp: 0.985,
    // octave pops on the sixteenths, the Chic school
    notes: every(8, 0.5, (t, i) => (i % 2
      ? [{ t, s: 12, g: 0.8 }, { t: t + 0.25, s: 16, g: 0.45 }]
      : [{ t, s: 0, g: 0.95 }, { t: t + 0.25, s: 12, g: 0.55 }])),
  },

  desert: {
    label: 'Desert', beats: 8, ring: 1.6, damp: 0.997,
    // hypnotic dorian loop, deliberately repetitive but never static
    notes: [
      { t: 0, s: 0, g: 1 }, { t: 1, s: 3, g: 0.8 }, { t: 1.75, s: 5, g: 0.85 },
      { t: 2.5, s: 3, g: 0.7 }, { t: 3, s: 0, g: 0.9 },
      { t: 4, s: 10, g: 0.85 }, { t: 4.75, s: 12, g: 0.9 }, { t: 5.5, s: 10, g: 0.7 },
      { t: 6, s: 5, g: 0.85 }, { t: 7, s: 3, g: 0.75 },
    ],
  },
};


// ---------------------------------------------------------------------------
// Chord progressions — the source moves through changes instead of hanging on
// one chord. Each step is { d (degree: semitones above the key root),
// q (chord quality), b (how many bars it lasts) }. The strum style and BPM
// still apply, so "Doo-wop at 85 with a Ballad strum" just works.
// ---------------------------------------------------------------------------

export const PROGRESSIONS = {
  none:    { label: 'Off (one chord)', steps: null },
  I_V_vi_IV: { label: 'I–V–vi–IV', steps: [
    { d: 0, q: 'major', b: 1 }, { d: 7, q: 'major', b: 1 },
    { d: 9, q: 'minor', b: 1 }, { d: 5, q: 'major', b: 1 }] },
  doowop:  { label: 'Doo-wop I–vi–IV–V', steps: [
    { d: 0, q: 'major', b: 1 }, { d: 9, q: 'minor', b: 1 },
    { d: 5, q: 'major', b: 1 }, { d: 7, q: 'major', b: 1 }] },
  blues12: { label: '12-bar blues', steps: [
    { d: 0, q: '7th', b: 4 }, { d: 5, q: '7th', b: 2 }, { d: 0, q: '7th', b: 2 },
    { d: 7, q: '7th', b: 1 }, { d: 5, q: '7th', b: 1 }, { d: 0, q: '7th', b: 1 },
    { d: 7, q: '7th', b: 1 }] },
  ii_V_I:  { label: 'ii–V–I (jazz)', steps: [
    { d: 2, q: 'min7', b: 1 }, { d: 7, q: '7th', b: 1 }, { d: 0, q: 'maj7', b: 2 }] },
  andalusian: { label: 'Andalusian i–VII–VI–V', steps: [
    { d: 0, q: 'minor', b: 1 }, { d: 10, q: 'major', b: 1 },
    { d: 8, q: 'major', b: 1 }, { d: 7, q: 'major', b: 1 }] },
  canon:   { label: 'Pachelbel', steps: [
    { d: 0, q: 'major', b: 1 }, { d: 7, q: 'major', b: 1 },
    { d: 9, q: 'minor', b: 1 }, { d: 4, q: 'minor', b: 1 },
    { d: 5, q: 'major', b: 1 }, { d: 0, q: 'major', b: 1 },
    { d: 5, q: 'major', b: 1 }, { d: 7, q: 'major', b: 1 }] },
  minor_pop: { label: 'i–VI–III–VII', steps: [
    { d: 0, q: 'minor', b: 1 }, { d: 8, q: 'major', b: 1 },
    { d: 3, q: 'major', b: 1 }, { d: 10, q: 'major', b: 1 }] },
  grunge:  { label: 'i–IV (grunge)', steps: [
    { d: 0, q: 'power', b: 2 }, { d: 5, q: 'power', b: 1 }, { d: 3, q: 'power', b: 1 }] },
  reggae:  { label: 'i–VII (reggae)', steps: [
    { d: 0, q: 'minor', b: 2 }, { d: 10, q: 'major', b: 2 }] },
  folk:    { label: 'I–IV–V', steps: [
    { d: 0, q: 'major', b: 2 }, { d: 5, q: 'major', b: 1 }, { d: 7, q: 'major', b: 1 }] },
  sad:     { label: 'vi–IV–I–V', steps: [
    { d: 9, q: 'minor', b: 1 }, { d: 5, q: 'major', b: 1 },
    { d: 0, q: 'major', b: 1 }, { d: 7, q: 'major', b: 1 }] },
};
