// ---------------------------------------------------------------------------
// Shared constants. Everything pedal-specific lives in spec JSON files
// (see specs/) — this is only what the sound engine itself needs.
// ---------------------------------------------------------------------------

export const CHORD_LEVEL = 0.45;
export const E2 = 82.407; // low E, the root of every chord

// per-voice gains, low string to high
export const CHORD_GAINS = [0.30, 0.24, 0.20, 0.16, 0.14, 0.12];

// selectable keys: label + semitone offset from E
export const KEYS = [
  ['E', 0], ['F', 1], ['F#', 2], ['G', 3], ['G#', 4], ['A', 5],
  ['A#', 6], ['B', 7], ['C', 8], ['C#', 9], ['D', 10], ['D#', 11],
];

// Interval palette for the microtone dyad input: cents above the root.
// 12-TET anchors sit beside their just and quarter-tone neighbours so the
// microtonal differences are easy to A/B. [label, cents, sub-caption?]
export const INTERVALS = [
  ['Unison', 0],            ['Quarter sharp', 50],      ['Minor 2nd', 100],
  ['Neutral 2nd', 150],     ['Major 2nd', 200],         ['Septimal 3rd', 267, '7:6 · 267¢'],
  ['Minor 3rd', 300],       ['Neutral 3rd', 350],       ['Just major 3rd', 386, '5:4 · 386¢'],
  ['Major 3rd', 400],       ['Fourth', 500],            ['Harmonic 11th', 551, '11:8 · 551¢'],
  ['Tritone', 600],         ['Fifth', 700],             ['Minor 6th', 800],
  ['Neutral 6th', 850],     ['Major 6th', 900],         ['Harmonic 7th', 969, '7:4 · 969¢'],
  ['Minor 7th', 1000],      ['Neutral 7th', 1050],      ['Octave', 1200],
];

// fine-tune chips: cents offsets applied to a whole tone input
export const DETUNES = [-50, -25, -10, 0, 10, 25, 50];

// six-voice chord shapes as semitone offsets from the chosen root
export const CHORDS = {
  major: [0, 7, 12, 16, 19, 24],
  minor: [0, 7, 12, 15, 19, 24],
  '7th': [0, 7, 10, 16, 19, 24],
  maj7:  [0, 7, 11, 16, 19, 24],
  min7:  [0, 7, 10, 15, 19, 24],
  sus4:  [0, 7, 12, 17, 19, 24],
  sus2:  [0, 7, 12, 14, 19, 24],
  aug:   [0, 8, 12, 16, 20, 24],
  dim:   [0, 6, 12, 15, 18, 24],
  dim7:  [0, 6, 9, 12, 15, 21],
  power: [0, 7, 12, 19, 24, 31],
  '6':   [0, 7, 12, 16, 21, 24],
  m6:    [0, 7, 12, 15, 21, 24],
  '9':   [0, 7, 10, 14, 16, 24],
  maj9:  [0, 7, 11, 14, 16, 24],
  add9:  [0, 7, 12, 14, 16, 24],
  '7sus4': [0, 7, 10, 17, 19, 24],
  '13':  [0, 7, 10, 16, 21, 24],
};
