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
  power: [0, 7, 12, 19, 24, 31],
};
