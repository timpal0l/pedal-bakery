/* presets.js — a whole board as portable data.
 *
 * A preset is a room with the player-scoped ids swapped for local refs
 * ("s1", "a2", "p1"), which is the only reason one board can be loaded into
 * another. Loading mints fresh ids and comes out as ordinary spawn / connect
 * ops, so the op layer stays the single path for every mutation and the
 * server needs no new op type to replay a preset.
 *
 * Pure data. Knows nothing about 3D, audio or the wire. */

export async function fetchPresets() {
  const res = await fetch('/presets');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function savePreset(doc) {
  const res = await fetch('/preset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.preset;
}

/* the op list that builds a preset on the board. `mintId(kind)` hands out
   fresh ids ('s' | 'a' | 'p'); posts land before pedals and cables last, the
   same order a snapshot rebuilds in, so nothing is ever cabled to a node
   that doesn't exist yet. */
export function presetOps(doc, mintId) {
  const ids = new Map(); // ref -> the id it got here
  const ops = [];
  // tempo first: a synced source bakes its loop against the clock it spawns
  // into, so setting the transport afterwards would re-bake every one of them
  if (doc.bpm) ops.push({ type: 'bpm', value: doc.bpm });
  for (const p of doc.posts || []) {
    const id = mintId(p.ptype === 'source' ? 's' : 'a');
    ids.set(p.ref, id);
    ops.push({ type: 'spawnPost', id, ptype: p.ptype,
      st: clone(p.st), pos: clone(p.pos) });
  }
  for (const p of doc.pedals || []) {
    const id = mintId('p');
    ids.set(p.ref, id);
    ops.push({ type: 'spawn', id, spec: clone(p.spec),
      st: clone(p.st), pos: clone(p.pos) });
  }
  for (const [from, to] of doc.cables || []) {
    if (ids.has(from) && ids.has(to)) {
      ops.push({ type: 'connect', from: ids.get(from), to: ids.get(to) });
    }
  }
  return ops;
}

/* the reverse: the live board as a preset doc. `nodes` is what main.js can
   see — { id, kind: 'source' | 'amp' | 'pedal', st, pos, spec? } — plus the
   cables between them, by id. */
export function boardToPreset({ name, tagline, bpm, nodes, cables }) {
  const refs = new Map();
  const counts = { source: 0, amp: 0, pedal: 0 };
  for (const n of nodes) {
    refs.set(n.id, `${n.kind[0]}${++counts[n.kind]}`);
  }
  return {
    name, tagline, bpm,
    posts: nodes.filter((n) => n.kind !== 'pedal').map((n) => ({
      ref: refs.get(n.id), ptype: n.kind, st: clone(n.st), pos: round(n.pos) })),
    pedals: nodes.filter((n) => n.kind === 'pedal').map((n) => ({
      ref: refs.get(n.id), spec: stripSpec(n.spec), st: clone(n.st), pos: round(n.pos) })),
    cables: cables.filter(([a, b]) => refs.has(a) && refs.has(b))
      .map(([a, b]) => [refs.get(a), refs.get(b)]),
  };
}

function clone(v) { return JSON.parse(JSON.stringify(v ?? {})); }
function round(pos) {
  return { x: Math.round((pos?.x || 0) * 100) / 100, z: Math.round((pos?.z || 0) * 100) / 100 };
}
function stripSpec(spec) {
  const out = clone(spec);
  delete out._mtime; // a shelf-file timestamp means nothing inside a preset
  return out;
}
