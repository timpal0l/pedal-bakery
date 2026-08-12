// ---------------------------------------------------------------------------
// timeline.js — what every player on the board is about to play, as data.
//
// The note math here mirrors the buffer builders in audio.js: same
// progression walk, same transposition, same swing. It is a second copy on
// purpose — audio.js writes samples and cannot be asked what it wrote, and a
// picture that disagrees with the speakers is worse than no picture. If you
// change how a loop is built there, change it here.
//
// Pure data: no DOM, no 3D, no Web Audio. Beats in, notes out; the caller
// turns notes into pixels.
// ---------------------------------------------------------------------------

import { RIFFS, PROGRESSIONS } from './riffs.js';
import { DRUM_PATTERNS, drumBars } from './drums.js';
import { BASS_LINES } from './bass.js';
import { STRUM_STYLES, ARP_PATTERNS } from './audio.js';
import { CHORDS } from './config.js';

// the engine tunes semitone 0 to E2 (MIDI 40); a bass plays an octave under
const GUITAR_MIDI = 40;
const BASS_MIDI = 28;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi) {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

// same rule as audio.js: only the offbeat eighth moves
function swingBeat(t, swing) {
  if (!swing || swing === 0.5) return t;
  const beat = Math.floor(t), frac = t - beat;
  return Math.abs(frac - 0.5) < 1e-6 ? beat + swing : t;
}

function stepsFor(prog, fallbackBeats) {
  return prog && prog.length
    ? prog.map((st) => ({ shift: st.d, quality: st.q, beats: (st.b || 1) * 4 }))
    : [{ shift: 0, quality: 'major', beats: fallbackBeats }];
}

const total = (steps) => steps.reduce((a, s) => a + s.beats, 0);
const progOf = (state, following) =>
  (following === false ? null : PROGRESSIONS[state.progression]?.steps || null);

/* ------------------------------------------------------------ the parts -- */

function riffLane(state, riff) {
  const steps = stepsFor(progOf(state, state.riffFollow), riff.beats);
  const notes = [];
  let cursor = 0;
  for (const step of steps) {
    const reps = Math.max(1, Math.round(step.beats / riff.beats));
    for (let r = 0; r < reps; r++) {
      const base = cursor + r * riff.beats;
      for (const n of riff.notes) {
        if (n.t + r * riff.beats >= step.beats) continue;
        notes.push({ t: base + n.t, g: n.g ?? 1,
          midi: GUITAR_MIDI + (state.root || 0) + step.shift + n.s });
      }
    }
    cursor += step.beats;
  }
  return { beats: total(steps), notes };
}

function bassLane(state) {
  const line = BASS_LINES[state.bassLine] || BASS_LINES.pump;
  const steps = stepsFor(progOf(state, state.bassFollow), line.beats);
  const notes = [];
  let cursor = 0;
  steps.forEach((step, si) => {
    const reps = Math.max(1, Math.round(step.beats / line.beats));
    const shift = line.pedal ? 0 : step.shift;
    const minor = /min|dim|m6|m7/.test(step.quality || '');
    for (let r = 0; r < reps; r++) {
      const base = cursor + r * line.beats;
      const lastRep = si === steps.length - 1 ? r === reps - 1 : false;
      for (const n of line.notes) {
        if (n.t >= step.beats - r * line.beats) continue;
        let s = n.s;
        if (line.walk) {
          if (s === 4 && minor) s = 3;
          if (n.t === line.beats - 1 && !lastRep) {
            const next = steps[(si + 1) % steps.length];
            s = (line.pedal ? 0 : next.shift) - shift - 1;
          }
        }
        notes.push({ t: base + swingBeat(n.t, line.swing), g: n.g ?? 1,
          midi: BASS_MIDI + (state.root || 0) + shift + s });
      }
    }
    cursor += step.beats;
  });
  return { beats: total(steps), notes };
}

function drumLane(state) {
  const pattern = DRUM_PATTERNS[state.drumPattern] || DRUM_PATTERNS.rock;
  const bars = drumBars(pattern);
  const notes = [];
  for (let bar = 0; bar < bars; bar++) {
    const base = bar * pattern.beats;
    const last = bar === bars - 1;
    // the fill replaces everything from fillFrom on, but only in the last bar
    const from = last && pattern.fill ? pattern.fillFrom ?? pattern.beats : pattern.beats;
    for (const n of pattern.notes) {
      if (n.t >= from) continue;
      notes.push({ t: base + swingBeat(n.t, pattern.swing), g: n.g, voice: n.d });
    }
    if (bar === 0) for (const n of pattern.top || []) notes.push({ t: base + n.t, g: n.g, voice: n.d });
    if (last) for (const n of pattern.fill || []) notes.push({ t: base + n.t, g: n.g, voice: n.d });
  }
  return { beats: bars * pattern.beats, notes, label: pattern.label };
}

function chordShape(state) {
  const ic = (state.interval ?? 350) / 100;
  return state.chord === 'dyad'
    ? [0, ic, 12, 12 + ic, 24, 24 + ic]
    : (CHORDS[state.chord] || CHORDS.major);
}

function strumLane(state) {
  const style = STRUM_STYLES[state.strumStyle] || STRUM_STYLES.ring;
  const root = state.root || 0;
  const prog = progOf(state, undefined);
  const steps = prog && prog.length
    ? prog.map((st) => ({ semis: (CHORDS[st.q] || CHORDS.major).map((x) => x + root + st.d),
                          beats: (st.b || 1) * 4 }))
    : [{ semis: chordShape(state).map((x) => x + root), beats: style.beats }];
  const notes = [];
  let cursor = 0;
  for (const step of steps) {
    const reps = Math.max(1, Math.round(step.beats / style.beats));
    for (const ev of style.events) {
      for (let r = 0; r < reps; r++) {
        // a strum is one event but six strings; the picture shows the chord
        let order = step.semis.map((_, i) => i);
        if (ev.strings === 'low') order = order.slice(0, 3);
        else if (ev.strings === 'high' || ev.dir < 0) order = order.slice(2);
        for (const i of order) {
          notes.push({ t: cursor + ev.t + r * style.beats, g: ev.g ?? 1,
            midi: GUITAR_MIDI + step.semis[i] });
        }
      }
    }
    cursor += step.beats;
  }
  return { beats: total(steps), notes, label: style.label };
}

function arpLane(state) {
  const pattern = ARP_PATTERNS[state.arpPattern] || ARP_PATTERNS.up;
  const step = pattern.step ?? 0.5;
  const semis = chordShape(state).map((x) => x + (state.root || 0));
  const notes = pattern.order.map((idx, i) => ({
    t: i * step, g: 0.8,
    midi: GUITAR_MIDI + (semis[idx] ?? semis[semis.length - 1]),
  }));
  return { beats: pattern.order.length * step, notes, label: pattern.label };
}

/* ------------------------------------------------------------- the lane -- */

// One source post -> one lane, or null for the modes that play nothing we
// can draw (a real guitar, or silence).
export function laneFor(post, riffOf) {
  const st = post.state;
  let part = null, title = '', sub = '';
  if (st.mode === 'riff') {
    const riff = riffOf?.(st.riff) || RIFFS[st.riff] || RIFFS.rock;
    part = riffLane(st, riff);
    title = riff.label || riff.name || st.riff;
    sub = 'riff';
  } else if (st.mode === 'bass') {
    part = bassLane(st);
    title = (BASS_LINES[st.bassLine] || BASS_LINES.pump).label;
    sub = 'bass';
  } else if (st.mode === 'drums') {
    part = drumLane(st);
    title = part.label;
    sub = 'drums';
  } else if (st.mode === 'chord') {
    part = strumLane(st);
    title = part.label;
    sub = 'strum';
  } else if (st.mode === 'arp') {
    part = arpLane(st);
    title = part.label;
    sub = 'arpeggio';
  }
  if (!part || !part.notes.length) return null;
  const pitched = part.notes.some((n) => n.midi !== undefined);
  const midis = part.notes.filter((n) => n.midi !== undefined).map((n) => n.midi);
  return {
    id: post.id,
    kind: st.mode,
    title,
    sub,
    beats: part.beats,
    sync: st.sync !== false,
    pitched,
    lo: pitched ? Math.min(...midis) : 0,
    hi: pitched ? Math.max(...midis) : 0,
    notes: part.notes,
  };
}

// The order the kit is drawn in, low to high, the way a drummer would read it
export const DRUM_VOICES = ['kick', 'tom3', 'tom2', 'tom1', 'snare', 'rim',
  'ride', 'hat', 'ohat', 'crash'];

// A signature that changes exactly when the picture would: cheap enough to
// compare every frame, so nothing has to remember to invalidate it.
export function boardSignature(posts, bpm) {
  const parts = [String(bpm)];
  for (const p of posts) {
    const s = p.state;
    parts.push([p.id, s.mode, s.riff, s.drumPattern, s.bassLine, s.chord,
      s.strumStyle, s.arpPattern, s.progression, s.root, s.riffFollow,
      s.bassFollow, s.interval, s.sync, s.bpm].join('|'));
  }
  return parts.join('#');
}
