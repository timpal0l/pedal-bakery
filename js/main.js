// ---------------------------------------------------------------------------
// The wiring — start reading here.
// Owns the board state (pedals + source posts + amps + cables) and connects
// shelf UI -> spawns, mouse -> knobs / dragging / Reason-style patching,
// board -> parallel audio chains, and (multiplayer) every mutation -> the
// room. The rule that keeps sync honest: each mutation is an OP — applied
// through the same applyOp() path whether it came from this mouse or from
// another player, and broadcast only when it was ours.
// ---------------------------------------------------------------------------

import { createAudio } from './audio.js';
import { createScene, GRID_HALF, SNAP, sourceLook } from './scene.js';
import { createBoard } from './board.js';
import { CHORDS, KEYS, INTERVALS, DETUNES } from './config.js';
import { STRUM_STYLES, ARP_PATTERNS } from './audio.js';
import { RIFFS, PROGRESSIONS } from './riffs.js';
import { DRUM_KITS, DRUM_PATTERNS, drumsFor } from './drums.js';
import { BASS_LINES, BASS_TONES, bassFor } from './bass.js';
import { createNet, playerIdentity, savedBakeries, rememberBakery, forgetBakery } from './net.js';
import { fetchPresets, savePreset, presetOps, boardToPreset } from './presets.js';

const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const bakeInput = document.getElementById('bake-input');
const bakeButton = document.getElementById('bake-button');
const bakeStatus = document.getElementById('bake-status');
const shelfList = document.getElementById('shelf-list');
const shelfTools = document.getElementById('shelf-tools');
const shelfSearch = document.getElementById('shelf-search');
const shelfSortBar = document.getElementById('shelf-sort');

const audio = createAudio();
const view = createScene(canvas);
const board = createBoard();

const instances = new Map(); // pedal id -> { id, spec, state, view }
const posts = new Map();     // endpoint id -> { id, type: 'source'|'amp', state?, view }
const others = new Map();    // remote player id -> { id, name, color }
const armedGuitar = new Set(); // source ids where THIS client granted the mic
// source modes that are a baked, looping buffer — the ones that re-bake when
// the chord, the style or the clock changes. 'guitar' and 'off' are neither.
const LOOP_MODES = ['chord', 'arp', 'interval', 'riff', 'drums', 'bass'];
// modes that play themselves rather than being played — they follow the band
const BAND_MODES = ['drums', 'bass'];
const myId = playerIdentity();
let counter = 0;

function nextId(kind) { return `${myId}-${kind}${++counter}`; }

// ids carry their creator's prefix; after a reload the same player id comes
// back, so the counter must clear anything of ours already in the room
function bumpCounter(id) {
  const m = /^(.+)-[psa](\d+)$/.exec(id);
  if (m && m[1] === myId) counter = Math.max(counter, Number(m[2]));
}

/* HUD — transient messages only; hides itself when idle */
let hudTimer = null;
function showHud(text, sticky) {
  hud.textContent = text;
  hud.style.display = 'block';
  if (hudTimer) clearTimeout(hudTimer);
  if (!sticky) hudTimer = setTimeout(() => { hud.style.display = 'none'; }, 2600);
}

/* ------------------------------------------------------------- the wire -- */

const net = createNet({
  onRenamed(msg) { setRoomName(msg.name || ''); showHud(`bakery renamed: ${msg.name}`); },
  onWelcome(msg) {
    try {
      setRoomName(msg.name || '');
      enterRoom(msg);
    } catch (err) {
      // a broken snapshot must not strand the player on a dead lobby
      console.error('[net] failed to enter room', err);
      if (document.body.contains(overlay)) {
        setLobbyBusy(false);
        lobbyError.textContent = 'failed to load the bakery — try again';
      } else {
        showHud('bakery load hit an error — some gear may be missing', true);
      }
    }
  },
  onOp(op) { applyOp(op); },
  onPos(msg) { view.movePlayerMarker(msg.player, msg.x, msg.z, msg.cx, msg.cz); },
  onJoin(player) {
    others.set(player.id, player);
    view.setPlayerMarker(player.id, player);
    updateBadge();
    lastSent = null; // re-announce our position so the newcomer can place us
    showHud(`${player.name.toUpperCase()} IS IN THE BAKERY`);
  },
  onLeave(playerId) {
    const p = others.get(playerId);
    others.delete(playerId);
    view.removePlayerMarker(playerId);
    updateBadge();
    if (p) showHud(`${p.name.toUpperCase()} LEFT`);
  },
  onShelf() { loadShelf(); },
  onStatus(status, detail) {
    if (status === 'reconnecting') showHud('connection lost — rejoining the bakery…', true);
    if (status === 'refused') showHud(`disconnected: ${detail || 'refused'} — reload to rejoin`, true);
  },
});

/* ------------------------------------------------------- board plumbing -- */

// Every jack on the board, so clicks can snap to the nearest one instead of
// demanding a pixel-perfect hit.
function allJacks() {
  const list = [];
  for (const p of posts.values()) {
    list.push({ node: p.id, kind: p.view.jack.kind, jack: p.view.jack });
  }
  for (const i of instances.values()) {
    for (const kind of ['in', 'out']) {
      const j = i.view.jack(kind);
      if (j) list.push({ node: i.id, kind, jack: j });
    }
  }
  return list;
}

// nearest jack to a screen point, within maxPx; optionally only one kind
function nearestJack(x, y, maxPx, wantKind, excludeNode) {
  let best = null, bestD = maxPx;
  for (const j of allJacks()) {
    if (wantKind && j.kind !== wantKind) continue;
    if (excludeNode && j.node === excludeNode) continue;
    const p = view.project(j.jack.pos());
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}

function endpointOf(node, kind) {
  const j = posts.get(node)?.view.jack ?? instances.get(node)?.view.jack(kind);
  if (!j) return null; // node vanished (remote remove racing a connect)
  return () => ({ pos: j.pos(), dir: j.dir });
}

function boardChains() {
  const sourceIds = [...posts.values()].filter((p) => p.type === 'source').map((p) => p.id);
  const ampIds = new Set([...posts.values()].filter((p) => p.type === 'amp').map((p) => p.id));
  for (const inst of instances.values()) {
    if (inst.spec.kind === 'amp') ampIds.add(inst.id); // baked amps terminate chains
  }
  return board.chains(sourceIds, ampIds);
}

const liveCables = new Set();
function refreshBoard() {
  const wanted = new Set();
  for (const c of board.connections()) {
    const a = endpointOf(c.from, 'out'), b = endpointOf(c.to, 'in');
    if (!a || !b) { board.disconnectJack(c.from, 'out'); continue; } // ghost cable
    wanted.add(c.id);
    view.setCable(c.id, a, b);
  }
  for (const id of [...liveCables]) {
    if (!wanted.has(id)) { view.removeCable(id); liveCables.delete(id); }
  }
  for (const id of wanted) liveCables.add(id);
  audio.setChain(boardChains());
}

/* -------------------------------------------------- ops: the one true path
   applyOp() performs a mutation without broadcasting — remote ops and
   snapshot entries come through here. Local interactions call the same
   apply functions and then hand the op to the wire. Every apply tolerates
   missing nodes: a ghost op racing a concurrent remove is a no-op, never a
   crash. ------------------------------------------------------------------ */

function applyOp(op) {
  switch (op.type) {
    case 'spawn': applySpawn(op); break;
    case 'spawnPost': applySpawnPost(op); break;
    case 'remove': applyRemove(op.id); break;
    case 'move': applyMove(op); break;
    case 'connect': // both ends must still exist (remove can race the relay)
      if ((instances.has(op.from) || posts.has(op.from))
          && (instances.has(op.to) || posts.has(op.to))) {
        board.connect(op.from, op.to);
        refreshBoard();
      }
      break;
    case 'disconnect': board.disconnectJack(op.node, op.kind); refreshBoard(); break;
    case 'knob': applyKnob(op); break;
    case 'toggle': applyToggle(op); break;
    case 'bypass': applyBypass(op); break;
    case 'volume': applyVolume(op); break;
    case 'tone': applyTone(op); break;
    case 'bpm': applyBpm(op); break;
    default: console.warn('[net] unknown op', op);
  }
}

function applySpawn(op) {
  if (instances.has(op.id)) return;
  bumpCounter(op.id);
  const state = op.st;
  const pedalView = view.buildPedal(op.id, op.spec, state, op.pos);
  instances.set(op.id, { id: op.id, spec: op.spec, state, view: pedalView });
  audio.createRig(op.id, op.spec, state);
  refreshBoard();
}

function applySpawnPost(op) {
  if (posts.has(op.id)) return;
  bumpCounter(op.id);
  const state = op.st;
  if (op.ptype === 'source') {
    posts.set(op.id, { id: op.id, type: 'source',
      state, view: view.buildSourcePost(op.id, op.pos, sourceLook(state.mode)) });
    // a guitar can only come through the interface of whoever armed it;
    // everyone else keeps the state (for the menu) but hears silence
    if (state.mode === 'guitar' && !armedGuitar.has(op.id)) {
      audio.createSource(op.id, { ...state, mode: 'off' });
    } else {
      audio.createSource(op.id, state);
    }
  } else {
    posts.set(op.id, { id: op.id, type: 'amp', state, view: view.buildAmp(op.id, op.pos) });
    audio.createAmp(op.id, state);
  }
  posts.get(op.id).view.setKnobValue(state.volume ?? 5);
  refreshBoard();
  syncDrums(); // a new player on the board is something to play along with
}

function applyRemove(id) {
  if (patching?.from === id) cancelPatch();
  // a remote remove can land mid-drag; the pointer handlers must never
  // wake up holding a reference to a disposed node
  if (dragPedal?.id === id) dragPedal = null;
  if (dragEndpoint?.id === id) dragEndpoint = null;
  if (dragKnob?.pedal === id) dragKnob = null;
  if (dragPostKnob?.id === id) dragPostKnob = null;
  freeCamera();
  const inst = instances.get(id);
  if (inst) {
    if (selected === id) selected = null;
    board.removeNode(id);
    audio.disposeRig(id);
    inst.view.dispose();
    instances.delete(id);
    refreshBoard();
    return inst;
  }
  const post = posts.get(id);
  if (post) {
    if (menuTarget === id) hideSourceMenu();
    board.removeNode(id);
    if (post.type === 'source') { audio.disposeSource(id); armedGuitar.delete(id); }
    else audio.disposeAmp(id);
    post.view.dispose();
    posts.delete(id);
    refreshBoard();
    syncDrums(); // whoever the drummer was following may have just left
  }
  return post;
}

function applyMove(op) {
  const node = instances.get(op.id) ?? posts.get(op.id);
  node?.view.setPosition(op.x, op.z);
}

function applyKnob(op) {
  const inst = instances.get(op.id);
  if (!inst || !(op.control in inst.state.values)) return;
  inst.state.values[op.control] = op.value;
  inst.view.setKnobValue(op.control, op.value);
  audio.applyRig(op.id, inst.spec, inst.state);
}

function applyToggle(op) {
  const inst = instances.get(op.id);
  if (!inst || !(op.sw in inst.state.switches)) return;
  inst.state.switches[op.sw] = op.on;
  inst.view.setToggle(op.sw, op.on);
  audio.applyRig(op.id, inst.spec, inst.state);
}

function applyBypass(op) {
  const inst = instances.get(op.id);
  if (!inst) return;
  inst.state.on = op.on;
  inst.view.setLed(op.on);
  inst.view.pressFootswitch();
  audio.applyRig(op.id, inst.spec, inst.state);
}

function applyVolume(op) {
  const post = posts.get(op.id);
  if (!post) return;
  post.state.volume = op.value;
  post.view.setKnobValue(op.value);
  audio.setPostVolume(op.id, op.value);
}

function applyTone(op) {
  const post = posts.get(op.id);
  if (!post || post.type !== 'source') return;
  const st = post.state;
  Object.assign(st, op.patch);
  if ('mode' in op.patch) {
    if (st.mode === 'guitar' && !armedGuitar.has(op.id)) {
      audio.setSourceMode(op.id, 'off', { ...st }).catch(() => {});
      st.mode = 'guitar'; // truthful menu, silent speaker — it's their guitar
    } else {
      armedGuitar.delete(op.id);
      audio.setSourceMode(op.id, st.mode, st).catch(() => {});
    }
    // drums take a different way into the amp than a guitar does, so a mode
    // change is a re-wire, not just a new sound
    refreshBoard();
    post.view.setKind?.(sourceLook(st.mode)); // and the post wears the change
  } else if (LOOP_MODES.includes(st.mode)) {
    audio.refreshTone(op.id, st);
  }
  syncDrums(); // somebody changed what they're playing — the drummer follows
  if (menuTarget === op.id && sourceMenu.style.display === 'flex') renderSourceMenu();
}

function applyBpm(op) {
  audio.setTransportBpm(op.value);
  for (const post of posts.values()) { // synced loops re-bake to the new clock
    if (post.type === 'source' && post.state.sync
        && LOOP_MODES.includes(post.state.mode)) {
      audio.refreshTone(post.id, post.state);
    }
  }
}

/* ------------------------------------------- the rhythm section listens --
   A following drum or bass post plays whatever suits the rest of the room.
   This is DERIVED state, not a board mutation: every client runs the same
   function over the same synced source states and lands on the same answer,
   so it needs no op and can't desync. Picking by hand turns follow off, and
   that choice IS an op like everything else. */

// whoever the rhythm section is playing along with: the melodic sources, in
// id order — NOT insertion order, because a late joiner rebuilds the board
// from the snapshot in the server's order, which need not match the order the
// ops arrived here. Sorting by id is the one ordering every client agrees on.
function bandLeader(selfId) {
  return [...posts.values()]
    .filter((p) => p.type === 'source' && p.id !== selfId
      && !BAND_MODES.includes(p.state.mode) && p.state.mode !== 'off')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The rhythm section reads the riff itself, not just its id: a baked riff has
// an id no lookup table can know ("skank-chop"), and only its own record says
// what genre it is.
function riffRecord(id) { return bakedRiffs.get(id) || RIFFS[id] || null; }

function bandGroove(drummerId) {
  for (const post of bandLeader(drummerId)) {
    const groove = drumsFor(post.state, riffRecord(post.state.riff));
    if (groove) return groove;
  }
  return null;
}

function bandBassLine(bassistId) {
  for (const post of bandLeader(bassistId)) {
    const line = bassFor(post.state, riffRecord(post.state.riff));
    if (line) return line;
  }
  return null;
}

// A following bass takes the band's key and changes too, not just its line —
// a bass playing the right figure in the wrong key is worse than no bass.
function bandHarmony(bassistId) {
  for (const post of bandLeader(bassistId)) {
    if (['chord', 'arp', 'riff', 'interval'].includes(post.state.mode)) {
      return { root: post.state.root || 0, progression: post.state.progression || 'none' };
    }
  }
  return null;
}

function syncDrums() {
  for (const post of posts.values()) {
    const st = post.state;
    if (post.type !== 'source') continue;
    if (st.mode === 'drums' && st.drumFollow !== false) {
      const groove = bandGroove(post.id);
      if (groove && groove !== st.drumPattern) {
        st.drumPattern = groove;
        audio.refreshTone(post.id, st);
      }
    } else if (st.mode === 'bass' && st.bassFollow !== false) {
      const line = bandBassLine(post.id);
      const harmony = bandHarmony(post.id);
      const wantRoot = harmony ? harmony.root : st.root;
      const wantProg = harmony ? harmony.progression : st.progression;
      if ((line && line !== st.bassLine) || wantRoot !== st.root
          || wantProg !== st.progression) {
        if (line) st.bassLine = line;
        st.root = wantRoot;
        st.progression = wantProg;
        audio.refreshTone(post.id, st);
      }
    }
  }
}

/* ------------------------------------------------------------- spawning -- */

function makeState(spec) {
  const values = {};
  for (const c of spec.controls) {
    const [modId, param] = c.target.split('.');
    const mod = spec.chain.find((m) => m.id === modId);
    values[c.id] = mod?.params?.[param] ?? 5;
  }
  const switches = {};
  for (const s of spec.switches || []) switches[s.id] = false;
  return { values, switches, on: true };
}

function findFreeSlot(spec) {
  const w = spec.enclosure.width + 1.2, d = spec.enclosure.depth + 0.8;
  // keep clear of the default source (~x 7.6) and amp (~x -7.4) columns
  for (const z of [0, 3.5, -3.5, 7, -7]) {
    for (let x = 5; x >= -5; x -= 1) {
      const clash = [...instances.values()].some((i) => {
        const p = i.view.position();
        return Math.abs(p.x - x) < (i.view.bounds.w + w) / 2
            && Math.abs(p.z - z) < (i.view.bounds.d + d) / 2;
      });
      if (!clash) return { x: Math.round(x / SNAP) * SNAP, z };
    }
  }
  return { x: 0, z: 0 };
}

function spawnPedal(spec, at) {
  const op = { type: 'spawn', id: nextId('p'), spec,
    st: makeState(spec), pos: at ?? findFreeSlot(spec) };
  applySpawn(op);
  net.sendOp(op);
  showHud(`${spec.name.toUpperCase()} on the floor — patch it in`);
  return op.id;
}

function spawnSource(at, mode) {
  const all = [...posts.values()].filter((p) => p.type === 'source');
  // the cap is on things that could want an interface channel; a drummer
  // doesn't, so drums never cost you a guitar input
  const n = all.filter((p) => !BAND_MODES.includes(p.state.mode)).length;
  if (!BAND_MODES.includes(mode) && n >= 2) {
    showHud('two inputs max for now'); return null;
  }
  const op = { type: 'spawnPost', id: nextId('s'), ptype: 'source',
    pos: at ?? { x: 7.6, z: [0, 3.5, -3.5, 7, -7][all.length % 5] },
    st: { mode: mode || 'chord', chord: 'major', root: 0, strumStyle: 'ring',
      arpPattern: 'up', riff: 'rock', progression: 'none', riffFollow: true, interval: 350, detune: 0, volume: 5,
      drumKit: 'auto', drumPattern: 'rock', drumFollow: true,
      bassLine: 'pump', bassTone: 'finger', bassFollow: true,
      bpm: 100, sync: true, // inputs join the shared clock by default
      channel: n } }; // post N maps to interface input N+1
  if (mode === 'drums') op.st.drumPattern = bandGroove(op.id) || 'rock';
  if (mode === 'bass') op.st.bassLine = bandBassLine(op.id) || 'pump';
  applySpawnPost(op);
  net.sendOp(op);
  showHud(mode === 'drums' ? 'DRUMS added — cable them to an amp'
    : mode === 'bass' ? 'BASS added — it follows the band; cable it to an amp'
    : 'TONE IN added — click it to pick a chord');
  return op.id;
}

function spawnDrums(at) { return spawnSource(at, 'drums'); }

function spawnBass(at) { return spawnSource(at, 'bass'); }

function spawnAmp(at) {
  const n = [...posts.values()].filter((p) => p.type === 'amp').length;
  const op = { type: 'spawnPost', id: nextId('a'), ptype: 'amp',
    pos: at ?? { x: -7.4, z: [0, 3.5, -3.5, 7, -7][n % 5] },
    st: { volume: 5 } };
  applySpawnPost(op);
  net.sendOp(op);
  showHud('AMP added');
  return op.id;
}

function removePedal(id) {
  const inst = applyRemove(id);
  if (!inst) return;
  net.sendOp({ type: 'remove', id });
  showHud(`${inst.spec.name.toUpperCase()} removed`);
}

function removeEndpoint(id) {
  const post = applyRemove(id);
  if (!post) return;
  net.sendOp({ type: 'remove', id });
  showHud(post.type !== 'source' ? 'amp removed'
    : post.state.mode === 'drums' ? 'drummer sent home'
    : post.state.mode === 'bass' ? 'bass player sent home' : 'tone removed');
}

/* ------------------------------------------------------------ the shelf -- */

for (const [label, fn] of [['+ TONE IN', spawnSource], ['+ DRUMS', spawnDrums],
  ['+ BASS', spawnBass], ['+ AMP', spawnAmp]]) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = label;
  b.addEventListener('click', () => fn());
  shelfTools.appendChild(b);
}

let shelfSpecs = [];
let shelfSort = localStorage.getItem('shelfSort') || 'custom';
let customOrder = JSON.parse(localStorage.getItem('shelfOrder') || '[]');
const thumbCache = new Map(); // spec name -> dataURL (survives re-renders)
let thumbQueue = Promise.resolve(); // 3D snapshots render one at a time

const SORTS = [['custom', 'MINE'], ['az', 'A–Z'], ['new', 'NEW'], ['type', 'TYPE']];
for (const [key, label] of SORTS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.sort = key;
  b.addEventListener('click', () => {
    shelfSort = key;
    localStorage.setItem('shelfSort', key);
    renderShelf();
  });
  shelfSortBar.appendChild(b);
}
shelfSearch.addEventListener('input', renderShelf);

function sortedSpecs() {
  const arr = [...shelfSpecs];
  if (shelfSort === 'az') arr.sort((a, b) => a.name.localeCompare(b.name));
  else if (shelfSort === 'new') arr.sort((a, b) => (b._mtime || 0) - (a._mtime || 0));
  else if (shelfSort === 'type') {
    arr.sort((a, b) => (a.kind || 'pedal').localeCompare(b.kind || 'pedal')
      || a.name.localeCompare(b.name));
  } else {
    arr.sort((a, b) => {
      const ia = customOrder.indexOf(a.name), ib = customOrder.indexOf(b.name);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.name.localeCompare(b.name);
    });
  }
  const q = shelfSearch.value.trim().toLowerCase();
  if (!q) return arr;
  return arr.filter((sp) =>
    `${sp.name} ${sp.tagline || ''} ${sp.chain.map((m) => m.type).join(' ')}`
      .toLowerCase().includes(q));
}

function renderShelf() {
  for (const b of shelfSortBar.children) {
    b.classList.toggle('active', b.dataset.sort === shelfSort);
  }
  shelfList.innerHTML = '';
  for (const spec of sortedSpecs()) addShelfItem(spec);
}

async function loadShelf() {
  try {
    const res = await fetch('/specs');
    shelfSpecs = await res.json();
    renderShelf();
  } catch (err) {
    console.error('[shelf] failed to load specs', err);
    shelfList.innerHTML = '<div class="shelf-error">shelf unavailable — is bakery/server.py running?</div>';
  }
}

function addShelfItem(spec) {
  const item = document.createElement('button');
  item.className = 'shelf-item';
  item.dataset.name = spec.name;
  item.title = `${spec.tagline || ''}\n${spec.chain.map((m) => m.type).join(' → ')}`.trim();
  const img = document.createElement('img');
  img.className = 'si-icon';
  img.alt = '';
  const name = document.createElement('div');
  name.className = 'si-name';
  name.textContent = spec.name;
  if (spec.kind === 'amp') {
    const badge = document.createElement('span');
    badge.className = 'si-badge';
    badge.textContent = 'AMP';
    name.appendChild(badge);
  }
  item.append(img, name);
  item.addEventListener('click', () => spawnPedal(spec));
  item.draggable = true; // drag onto the floor to spawn, or within the list to reorder
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-pedal-spec', JSON.stringify(spec));
    e.dataTransfer.setData('application/x-shelf-name', spec.name);
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  item.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-shelf-name')) return;
    e.preventDefault();
    item.classList.add('drop-above');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drop-above'));
  item.addEventListener('drop', (e) => {
    const dragged = e.dataTransfer.getData('application/x-shelf-name');
    item.classList.remove('drop-above');
    if (!dragged || dragged === spec.name) return;
    e.preventDefault();
    e.stopPropagation();
    // adopt the current visual order, then move `dragged` before this item
    const order = sortedSpecs().map((s) => s.name).filter((n) => n !== dragged);
    order.splice(order.indexOf(spec.name), 0, dragged);
    customOrder = order;
    shelfSort = 'custom';
    localStorage.setItem('shelfOrder', JSON.stringify(customOrder));
    localStorage.setItem('shelfSort', 'custom');
    renderShelf();
  });
  shelfList.appendChild(item);
  if (thumbCache.has(spec.name)) {
    img.src = thumbCache.get(spec.name);
  } else {
    // a big library must not render 100 previews at boot: each thumbnail is
    // rendered the first time its row scrolls into view, then cached forever
    item.dataset.thumb = 'pending';
    thumbObserver.observe(item);
    thumbJobs.set(item, { spec, img });
  }
}

const thumbJobs = new Map(); // shelf row -> { spec, img } awaiting a render
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const job = thumbJobs.get(e.target);
    thumbObserver.unobserve(e.target);
    thumbJobs.delete(e.target);
    if (!job) continue;
    thumbQueue = thumbQueue.then(async () => {
      if (thumbCache.has(job.spec.name)) { job.img.src = thumbCache.get(job.spec.name); return; }
      try {
        const url = await view.snapshotPedal(job.spec, makeState(job.spec));
        thumbCache.set(job.spec.name, url);
        job.img.src = url;
      } catch (err) {
        console.warn('[shelf] thumbnail failed for', job.spec.name, err);
      }
    });
  }
}, { root: shelfList, rootMargin: '300px' });

/* ---------------------------------------------------------- interaction -- */

let dragKnob = null;     // { pedal, id, startY, startVal }
let dragPostKnob = null; // { id, startY, startVal } — volume knob on a post/amp
let dragPedal = null;    // { id, grab }
let dragEndpoint = null; // { id, grab, moved }
let patching = null;     // { from: nodeId } — cable dangling from an output jack
let selected = null;     // pedal id highlighted for the Delete key
let menuTarget = null;   // which source post the chord menu applies to
let cursorGround = new BABYLON.Vector3(0, 0, 0);
let lastHoverPick = 0;
const lastPointer = { x: 0, y: 0 };

function selectPedal(id) { // pedals, amps and tone posts all select the same way
  if (selected === id) return;
  (instances.get(selected) ?? posts.get(selected))?.view.setSelected?.(false);
  selected = id;
  (instances.get(selected) ?? posts.get(selected))?.view.setSelected?.(true);
  if (id) openPanel(id);
  else hidePanel(); // clicking empty floor closes whatever panel is open
}

// The camera is held while dragging an object or pulling a cable — a
// window-level pointerup backstop guarantees it always comes back.
let camHeld = false;
function holdCamera() {
  if (!camHeld) { view.camera.detachControl(); camHeld = true; }
}
function freeCamera() {
  if (camHeld && !dragKnob && !dragPostKnob && !dragPedal && !dragEndpoint && !patching) {
    view.camera.attachControl(canvas, true);
    camHeld = false;
  }
}
window.addEventListener('pointerup', (e) => {
  // drag-and-drop patching: a release that travelled lands the cable on the
  // nearest compatible jack. A release that didn't move leaves it in hand.
  if (patching && Math.hypot(e.clientX - patching.x, e.clientY - patching.y) > 14) {
    const want = patching.kind === 'out' ? 'in' : 'out';
    const near = nearestJack(e.clientX, e.clientY, 90, want, patching.node);
    if (near) completePatch(near.node);
  }
  dragKnob = null;
  dragPostKnob = null;
  dragPedal = null;
  dragEndpoint = null;
  net.flushOps();
  freeCamera();
});

function pendingEndpoint() {
  return () => ({ pos: cursorGround.add(new BABYLON.Vector3(0, 0.12, 0)),
                  dir: new BABYLON.Vector3(0, 0, 0) });
}

// A patch can start at either end of the cable: from an OUTPUT you're
// looking for an input to land in, from an INPUT you're looking for a source.
function refreshJackHints() {
  if (!patching) { view.setJackHints([]); return; }
  const want = patching.kind === 'out' ? 'in' : 'out';
  view.setJackHints(allJacks()
    .filter((j) => j.kind === want && j.node !== patching.node)
    .map((j) => j.jack.pos()));
}

function startPatch(node, kind, x = 0, y = 0) {
  // remember where the grab began: releasing without moving means "click to
  // pick up" (finish with a second click), moving means drag-and-drop
  patching = { node, kind, x, y };
  const held = endpointOf(node, kind);
  const loose = pendingEndpoint();
  // the dangling end always trails the cursor, whichever end you grabbed
  view.setCable('__pending', kind === 'out' ? held : loose,
    kind === 'out' ? loose : held, 0.15);
  refreshJackHints();
  showHud(kind === 'out'
    ? 'cable out — drop it near an INPUT jack'
    : 'cable in — drop it near an OUTPUT jack', true);
}

function cancelPatch() {
  if (!patching) return;
  patching = null;
  view.setJackHints([]);
  view.removeCable('__pending');
  freeCamera();
  showHud('cable dropped');
}

function completePatch(otherNode) {
  // whichever end was grabbed, the connection is always out -> in
  const from = patching.kind === 'out' ? patching.node : otherNode;
  const to = patching.kind === 'out' ? otherNode : patching.node;
  board.connect(from, to);
  patching = null;
  view.setJackHints([]);
  view.removeCable('__pending');
  freeCamera();
  refreshBoard();
  net.sendOp({ type: 'connect', from, to });
  showHud(boardChains().length ? 'connected — signal flows' : 'connected — no complete chain yet');
}

function jackClicked(jack) {
  const { node, kind } = jack;
  if (patching) {
    // land it on the complementary jack kind; anything else drops the cable
    if (kind !== patching.kind && node !== patching.node) completePatch(node);
    else cancelPatch();
    return;
  }
  if (board.jackUsed(node, kind)) {
    board.disconnectJack(node, kind);
    refreshBoard();
    net.sendOp({ type: 'disconnect', node, kind });
    showHud('cable pulled');
  } else {
    startPatch(node, kind, lastPointer.x, lastPointer.y);
  }
}

function dyadName(st) {
  const cents = st.interval ?? 350;
  return INTERVALS.find(([, c]) => c === cents)?.[0] ?? `${cents}¢`;
}

function toneLabel(st) {
  if (st.mode === 'bass') {
    const l = BASS_LINES[st.bassLine] || BASS_LINES.pump;
    const t = BASS_TONES[st.bassTone] || BASS_TONES.finger;
    const key = KEYS.find((k) => k[1] === (st.root || 0))?.[0] ?? 'E';
    return `BASS ${key} — ${l.label.toUpperCase()} · ${t.label.toUpperCase()}`;
  }
  if (st.mode === 'drums') {
    const p = DRUM_PATTERNS[st.drumPattern] || DRUM_PATTERNS.rock;
    const kit = DRUM_KITS[st.drumKit];
    return `DRUMS — ${p.label.toUpperCase()}${kit ? ` · ${kit.label.toUpperCase()}` : ''}`;
  }
  if (['chord', 'arp'].includes(st.mode) && st.chord === 'dyad') {
    const key = KEYS.find((k) => k[1] === (st.root || 0))?.[0] ?? 'E';
    return `${key} ${dyadName(st).toUpperCase()}${st.mode === 'arp' ? ' ARP' : ''}`;
  }
  return toneLabelChord(st);
}

function toneLabelChord(st) {
  const key = KEYS.find((k) => k[1] === (st.root || 0))?.[0] ?? 'E';
  const fine = st.detune ? ` ${st.detune > 0 ? '+' : ''}${st.detune}¢` : '';
  if (st.mode === 'interval') {
    const cents = st.interval ?? 350;
    const name = INTERVALS.find(([, c]) => c === cents)?.[0] ?? `${cents}¢`;
    return `${key}${fine} + ${name.toUpperCase()} (${cents}¢)`;
  }
  return `${key}${fine} ${st.chord.toUpperCase()}${st.mode === 'arp' ? ' ARP' : ''}`;
}

function knobLabel(inst, cid) {
  return inst.spec.controls.find((c) => c.id === cid)?.label ?? cid.toUpperCase();
}

view.scene.onPointerObservable.add((pi) => {
  const { scene } = view;
  switch (pi.type) {
    case BABYLON.PointerEventTypes.POINTERDOWN: {
      if (pi.event.button !== 0) break; // right/middle mouse belongs to the camera
      // Babylon can raise POINTERDOWN for moves made with a button held; only
      // a genuine press may act, or one drag fires the same jack many times
      if (pi.event.type && pi.event.type !== 'pointerdown') break;
      lastPointer.x = pi.event.clientX; lastPointer.y = pi.event.clientY;
      const pick = scene.pick(scene.pointerX, scene.pointerY);
      const meta = pick.hit ? pick.pickedMesh.metadata : null;
      if (!meta || meta.cable) {
        // clicking a cable pulls it; clicking near a jack still counts as a hit
        const near = nearestJack(pi.event.clientX, pi.event.clientY, 70,
          patching ? (patching.kind === 'out' ? 'in' : 'out') : null,
          patching ? patching.node : null);
        if (near) { holdCamera(); jackClicked({ node: near.node, kind: near.kind }); break; }
        if (meta && meta.cable) {
          const [from, to] = meta.cable.split('->');
          board.disconnectJack(from, 'out');
          refreshBoard();
          net.sendOp({ type: 'disconnect', node: from, kind: 'out' });
          showHud('cable pulled');
          break;
        }
        cancelPatch();
        selectPedal(null);
        break;
      }
      // A pedal's body overlaps its own jacks near the edges and usually wins
      // the raycast, so a click that is clearly closer to a jack than to the
      // pedal itself counts as a jack click. Tone posts and amps are small
      // enough that their body sits within a jack's radius, so they are
      // excluded — clicking one must open its panel, not pull a cable.
      if (meta.body && !patching) {
        const px = pi.event.clientX, py = pi.event.clientY;
        const near = nearestJack(px, py, 48);
        const inst = instances.get(meta.pedal);
        const centre = inst?.view.screenPos('switch');
        const toCentre = centre ? Math.hypot(centre.x - px, centre.y - py) : Infinity;
        const toJack = near ? Math.hypot(view.project(near.jack.pos()).x - px,
                                         view.project(near.jack.pos()).y - py) : Infinity;
        if (near && toJack < toCentre) {
          holdCamera();
          jackClicked({ node: near.node, kind: near.kind });
          break;
        }
      }
      if (meta.jack) {
        holdCamera(); // pulling a cable must never rotate the camera
        jackClicked(meta.jack);
      } else if (meta.postKnob) {
        const post = posts.get(meta.postKnob);
        selectPedal(meta.postKnob); // the knob is part of the post: show its panel
        holdCamera();
        dragPostKnob = { id: meta.postKnob, startY: scene.pointerY,
          startVal: post.state.volume ?? 5 };
        showHud(`VOLUME ${(post.state.volume ?? 5).toFixed(1)}`, true);
      } else if (meta.endpoint) {
        selectPedal(meta.endpoint);
        holdCamera();
        const g = view.groundPoint();
        dragEndpoint = { id: meta.endpoint,
          grab: posts.get(meta.endpoint).view.position().subtract(g), moved: 0 };
      } else if (meta.knob) {
        const inst = instances.get(meta.pedal);
        selectPedal(meta.pedal);
        holdCamera();
        dragKnob = { pedal: meta.pedal, id: meta.knob,
          startY: scene.pointerY, startVal: inst.state.values[meta.knob] };
        showHud(`${knobLabel(inst, meta.knob)} ${inst.state.values[meta.knob].toFixed(1)}`, true);
      } else if (meta.toggle) {
        const inst = instances.get(meta.pedal);
        const on = !inst.state.switches[meta.toggle];
        applyToggle({ id: meta.pedal, sw: meta.toggle, on });
        net.sendOp({ type: 'toggle', id: meta.pedal, sw: meta.toggle, on });
      } else if (meta.switch) {
        const inst = instances.get(meta.pedal);
        const on = !inst.state.on;
        applyBypass({ id: meta.pedal, on });
        net.sendOp({ type: 'bypass', id: meta.pedal, on });
        showHud(on
          ? `${inst.spec.name.toUpperCase()} ENGAGED`
          : `${inst.spec.name.toUpperCase()} BYPASSED`);
      } else if (meta.body) {
        const inst = instances.get(meta.pedal);
        selectPedal(meta.pedal);
        holdCamera();
        const g = view.groundPoint();
        dragPedal = { id: meta.pedal, grab: inst.view.position().subtract(g) };
      } else {
        cancelPatch();
      }
      break;
    }
    case BABYLON.PointerEventTypes.POINTERMOVE: {
      cursorGround = view.groundPoint();
      if (dragKnob) {
        const inst = instances.get(dragKnob.pedal);
        const v = Math.min(10, Math.max(0,
          dragKnob.startVal + (dragKnob.startY - scene.pointerY) * 0.03));
        inst.state.values[dragKnob.id] = v;
        inst.view.setKnobValue(dragKnob.id, v);
        audio.applyRig(dragKnob.pedal, inst.spec, inst.state);
        net.sendOpThrottled(`knob:${dragKnob.pedal}:${dragKnob.id}`,
          { type: 'knob', id: dragKnob.pedal, control: dragKnob.id, value: v });
        if (menuTarget === dragKnob.pedal && panelRefs.has(dragKnob.id)) {
          const ref = panelRefs.get(dragKnob.id);
          ref.slider.value = v;
          ref.val.textContent = v.toFixed(1);
        }
        showHud(`${knobLabel(inst, dragKnob.id)} ${v.toFixed(1)}`, true);
      } else if (dragPostKnob) {
        const post = posts.get(dragPostKnob.id);
        const v = Math.min(10, Math.max(0,
          dragPostKnob.startVal + (dragPostKnob.startY - scene.pointerY) * 0.03));
        post.state.volume = v;
        post.view.setKnobValue(v);
        audio.setPostVolume(dragPostKnob.id, v);
        net.sendOpThrottled(`vol:${dragPostKnob.id}`,
          { type: 'volume', id: dragPostKnob.id, value: v });
        showHud(`VOLUME ${v.toFixed(1)}`, true);
      } else if (dragPedal) {
        const inst = instances.get(dragPedal.id);
        const p = cursorGround.add(dragPedal.grab);
        const x = Math.round(p.x / SNAP) * SNAP, z = Math.round(p.z / SNAP) * SNAP;
        inst.view.setPosition(x, z);
        net.sendOpThrottled(`move:${dragPedal.id}`,
          { type: 'move', id: dragPedal.id, x, z });
      } else if (dragEndpoint) {
        const post = posts.get(dragEndpoint.id);
        const p = cursorGround.add(dragEndpoint.grab);
        const x = Math.round(p.x / SNAP) * SNAP, z = Math.round(p.z / SNAP) * SNAP;
        post.view.setPosition(x, z);
        net.sendOpThrottled(`move:${dragEndpoint.id}`,
          { type: 'move', id: dragEndpoint.id, x, z });
        dragEndpoint.moved += Math.abs(pi.event.movementX || 0) + Math.abs(pi.event.movementY || 0);
      } else if (performance.now() - lastHoverPick > 60) {
        lastHoverPick = performance.now(); // hover cursor doesn't need every frame
        const pick = scene.pick(scene.pointerX, scene.pointerY);
        canvas.style.cursor = pick.hit && pick.pickedMesh.metadata ? 'pointer' : 'default';
      }
      break;
    }
    case BABYLON.PointerEventTypes.POINTERUP: {
      net.flushOps(); // trailing knob/move values land before any remove
      if (dragKnob || dragPostKnob) {
        dragKnob = null;
        dragPostKnob = null;
        showHud(hud.textContent);
      }
      if (dragPedal) {
        const p = instances.get(dragPedal.id).view.position();
        if (Math.abs(p.x) > GRID_HALF || Math.abs(p.z) > GRID_HALF) removePedal(dragPedal.id);
        dragPedal = null;
      }
      if (dragEndpoint) {
        const post = posts.get(dragEndpoint.id);
        const p = post.view.position();
        if (Math.abs(p.x) > GRID_HALF || Math.abs(p.z) > GRID_HALF) {
          removeEndpoint(dragEndpoint.id);
        }
        dragEndpoint = null;
      }
      freeCamera();
      break;
    }
  }
});

/* the source menu — GarageBand-style: a SOUND section (radio rows with
   checkmarks) and a CHORD chip grid. Stays open so you can audition. */
const sourceMenu = document.getElementById('source-menu');

const SOUND_MODES = [
  { label: 'Strum', kind: 'chord' },
  { label: 'Riff', kind: 'riff' },
  { label: 'Drums', kind: 'drums' },
  { label: 'Bass', kind: 'bass' },
  { label: 'Guitar 1', kind: 'guitar', channel: 0 },
  { label: 'Guitar 2', kind: 'guitar', channel: 1 },
  { label: 'Off', kind: 'off' },
];

const panelRefs = new Map(); // control id -> { slider, val } while a panel shows

function panelHead(title, sub) {
  const head = document.createElement('div');
  head.className = 'panel-head';
  const left = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'panel-title';
  t.textContent = title;
  left.appendChild(t);
  if (sub) {
    const sb = document.createElement('div');
    sb.className = 'panel-sub';
    sb.textContent = sub;
    left.appendChild(sb);
  }
  const x = document.createElement('button');
  x.className = 'panel-x';
  x.textContent = '✕';
  x.addEventListener('click', hidePanel);
  head.append(left, x);
  sourceMenu.appendChild(head);
}

function volumeRow(post) {
  const row = document.createElement('div');
  row.className = 'ctl-row';
  const label = document.createElement('label');
  label.textContent = 'VOLUME';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0; slider.max = 10; slider.step = 0.1;
  slider.value = post.state.volume ?? 5;
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = Number(post.state.volume ?? 5).toFixed(1);
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    post.state.volume = v;
    post.view.setKnobValue(v);
    audio.setPostVolume(post.id, v);
    net.sendOpThrottled(`vol:${post.id}`, { type: 'volume', id: post.id, value: v });
    val.textContent = v.toFixed(1);
  });
  row.append(label, slider, val);
  sourceMenu.appendChild(row);
  panelRefs.set('__vol', { slider, val });
}

function removeRow(id) {
  const rm = document.createElement('button');
  rm.className = 'panel-btn danger';
  rm.textContent = 'REMOVE';
  rm.addEventListener('click', () => {
    hidePanel();
    if (instances.has(id)) removePedal(id);
    else removeEndpoint(id);
  });
  sourceMenu.appendChild(rm);
}

function renderPedalPanel(inst) {
  sourceMenu.innerHTML = '';
  panelHead(inst.spec.name, inst.spec.tagline
    || inst.spec.chain.map((m) => m.type).join(' → '));
  for (const c of inst.spec.controls) {
    const row = document.createElement('div');
    row.className = 'ctl-row';
    const label = document.createElement('label');
    label.textContent = c.label;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0; slider.max = 10; slider.step = 0.1;
    slider.value = inst.state.values[c.id];
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = Number(inst.state.values[c.id]).toFixed(1);
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      inst.state.values[c.id] = v;
      inst.view.setKnobValue(c.id, v);
      audio.applyRig(inst.id, inst.spec, inst.state);
      net.sendOpThrottled(`knob:${inst.id}:${c.id}`,
        { type: 'knob', id: inst.id, control: c.id, value: v });
      val.textContent = v.toFixed(1);
    });
    row.append(label, slider, val);
    sourceMenu.appendChild(row);
    panelRefs.set(c.id, { slider, val });
  }
  for (const sw of inst.spec.switches || []) {
    const b = document.createElement('button');
    const on = () => inst.state.switches[sw.id];
    b.className = 'menu-row' + (on() ? ' active' : '');
    b.innerHTML = `<span class="check">${on() ? '✓' : ''}</span><span></span>`;
    b.lastChild.textContent = sw.label;
    b.addEventListener('click', () => {
      const next = !on();
      applyToggle({ id: inst.id, sw: sw.id, on: next });
      net.sendOp({ type: 'toggle', id: inst.id, sw: sw.id, on: next });
      renderSourceMenu();
    });
    sourceMenu.appendChild(b);
  }
  const byp = document.createElement('button');
  byp.className = 'panel-btn';
  byp.textContent = inst.state.on
    ? (inst.spec.kind === 'amp' ? 'STANDBY' : 'BYPASS')
    : 'ENGAGE';
  byp.addEventListener('click', () => {
    const on = !inst.state.on;
    applyBypass({ id: inst.id, on });
    net.sendOp({ type: 'bypass', id: inst.id, on });
    renderSourceMenu();
  });
  sourceMenu.appendChild(byp);
  removeRow(inst.id);
}

function renderSourceMenu() {
  panelRefs.clear();
  sourceMenu.dataset.panel = 'node'; // a late preset fetch must not draw over this
  const inst = instances.get(menuTarget);
  if (inst) { renderPedalPanel(inst); return; }
  const post = posts.get(menuTarget);
  if (!post) return;
  if (post.type === 'amp') {
    sourceMenu.innerHTML = '';
    panelHead('Amp', 'output');
    volumeRow(post);
    removeRow(post.id);
    return;
  }
  const st = post.state;
  sourceMenu.innerHTML = '';
  panelHead('Tone', 'input settings');
  volumeRow(post);
  const section = (label) => {
    const d = document.createElement('div');
    d.className = 'menu-section';
    d.textContent = label;
    sourceMenu.appendChild(d);
  };
  const chipGrid = (entries, activeKey, onPick, cols = 4) => {
    const grid = document.createElement('div');
    grid.className = 'chord-grid';
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    for (const [key, label, sub] of entries) {
      const b = document.createElement('button');
      b.className = 'chip-sm' + (activeKey === key ? ' active' : '');
      b.textContent = label;
      if (sub) {
        const s = document.createElement('small');
        s.textContent = sub;
        b.appendChild(s);
      }
      b.addEventListener('click', () => onPick(key));
      grid.appendChild(b);
    }
    sourceMenu.appendChild(grid);
  };

  section('SOUND');
  {
    const grid = document.createElement('div');
    grid.className = 'chord-grid';
    grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
    for (const m of SOUND_MODES) {
      const active = st.mode === m.kind
        && (m.kind !== 'guitar' || (st.channel || 0) === m.channel);
      const b = document.createElement('button');
      b.className = 'chip-sm' + (active ? ' active' : '');
      b.textContent = m.label;
      b.addEventListener('click', () => chooseMode(m));
      grid.appendChild(b);
    }
    sourceMenu.appendChild(grid);
  }
  if (LOOP_MODES.includes(st.mode)) {
    section('TEMPO');
    const syncRow = document.createElement('button');
    syncRow.className = 'menu-row' + (st.sync ? ' active' : '');
    syncRow.innerHTML = `<span class="check">${st.sync ? '✓' : ''}</span><span></span>`;
    syncRow.lastChild.textContent = st.sync
      ? `Sync — shared clock, ${audio.transportBpm()} BPM`
      : 'Sync to the other inputs';
    syncRow.addEventListener('click', () => chooseSync(!st.sync));
    sourceMenu.appendChild(syncRow);
    const bpmNow = st.sync ? audio.transportBpm() : (st.bpm || 100);
    chipGrid([70, 85, 100, 115, 130, 150, 170, 190].map((b) => [b, `${b}`]),
      bpmNow, (b) => chooseBpm(b), 4);
  }
  const bassLed = st.mode === 'bass' && st.bassFollow !== false;
  if (st.mode === 'chord' || st.mode === 'riff' || (st.mode === 'bass' && !bassLed)) {
    section('PROGRESSION');
    chipGrid(Object.entries(PROGRESSIONS).map(([k, v]) => [k, v.label]),
      st.progression || 'none', (k) => chooseToneOption('progression', k), 2);
    if (st.mode === 'riff' && (st.progression || 'none') !== 'none') {
      // a riff can either move with the changes or stay put as a one-chord loop
      const follow = st.riffFollow !== false;
      const row = document.createElement('button');
      row.className = 'menu-row' + (follow ? ' active' : '');
      row.innerHTML = `<span class="check">${follow ? '✓' : ''}</span><span></span>`;
      row.lastChild.textContent = 'Riff follows the changes';
      row.addEventListener('click', () => chooseToneOption('riffFollow', !follow));
      sourceMenu.appendChild(row);
    }
  }
  if (st.mode === 'chord') {
    section('STRUM STYLE');
    chipGrid(Object.entries(STRUM_STYLES).map(([k, v]) => [k, v.label]),
      st.strumStyle || 'ring', (k) => chooseToneOption('strumStyle', k), 4);
  }
  if (st.mode === 'bass') {
    const follow = st.bassFollow !== false;
    section('LINE');
    const row = document.createElement('button');
    row.className = 'menu-row' + (follow ? ' active' : '');
    row.innerHTML = `<span class="check">${follow ? '✓' : ''}</span><span></span>`;
    const heard = bandBassLine(post.id);
    row.lastChild.textContent = follow
      ? `Follows the band${heard ? `: ${BASS_LINES[heard].label}, their key and changes`
        : ' — nobody else is playing yet'}`
      : 'Follow the band’s line, key and changes';
    row.addEventListener('click', () => chooseBassFollow(!follow));
    sourceMenu.appendChild(row);
    chipGrid(Object.entries(BASS_LINES).map(([k, v]) => [k, v.label]),
      st.bassLine || 'pump', (k) => chooseBassLine(k), 3);
    section('TONE');
    chipGrid(Object.entries(BASS_TONES).map(([k, v]) => [k, v.label]),
      st.bassTone || 'finger', (k) => chooseToneOption('bassTone', k), 2);
    // a bass off follow still needs its own key and changes, so fall through
    // to PROGRESSION and KEY below rather than returning like drums do
  }
  if (st.mode === 'riff') {
    section('RIFF');
    if (riffShelfOpen()) {
      const hint = document.createElement('div');
      hint.className = 'panel-sub';
      hint.style.padding = '0 12px 6px';
      hint.textContent = 'pick or bake one in the riff shelf →';
      sourceMenu.appendChild(hint);
    } else {
      // closed by hand, but this input still wants riffs — offer the way back
      const b = document.createElement('button');
      b.className = 'panel-btn';
      b.textContent = 'OPEN RIFF SHELF';
      b.addEventListener('click', () => { setRiffShelf(true); renderSourceMenu(); });
      sourceMenu.appendChild(b);
    }
  }
  if (st.mode === 'drums') {
    const follow = st.drumFollow !== false;
    section('GROOVE');
    const row = document.createElement('button');
    row.className = 'menu-row' + (follow ? ' active' : '');
    row.innerHTML = `<span class="check">${follow ? '✓' : ''}</span><span></span>`;
    const heard = bandGroove(post.id);
    row.lastChild.textContent = follow
      ? `Follows the band${heard ? ` — playing ${DRUM_PATTERNS[heard].label}` : ' — nobody else playing'}`
      : 'Follow whatever the band plays';
    row.addEventListener('click', () => chooseDrumFollow(!follow));
    sourceMenu.appendChild(row);
    // picking a groove by hand is a decision; it takes the drummer off follow
    chipGrid(Object.entries(DRUM_PATTERNS).map(([k, v]) => [k, v.label]),
      st.drumPattern || 'rock', (k) => chooseGroove(k), 3);
    section('KIT');
    chipGrid([['auto', 'Auto'], ...Object.entries(DRUM_KITS).map(([k, v]) => [k, v.label])],
      st.drumKit || 'auto', (k) => chooseToneOption('drumKit', k), 3);
    return; // a kit has no key and no chord
  }

  if (!bassLed) { // a following bass is in the band's key, not its own
    section('KEY');
    chipGrid(KEYS.map(([name, semi]) => [semi, name]), st.root || 0,
      (semi) => chooseToneOption('root', semi), 6);
  }
  if (st.mode !== 'riff' && st.mode !== 'bass') { // these carry their own notes
    section('CHORD');
    chipGrid(Object.keys(CHORDS).map((c) => [c, c.toUpperCase()]), st.chord,
      (c) => chooseChord(c), 5);
  }
}

// same bargain as the drummer's: choosing by hand means you meant it
function chooseBassLine(key) {
  const post = posts.get(menuTarget);
  if (!post) return;
  Object.assign(post.state, { bassLine: key, bassFollow: false });
  audio.refreshTone(menuTarget, post.state);
  net.sendOp({ type: 'tone', id: menuTarget, patch: { bassLine: key, bassFollow: false } });
  showHud(`BASS — ${BASS_LINES[key].label.toUpperCase()}`);
  renderSourceMenu();
}

function chooseBassFollow(on) {
  const post = posts.get(menuTarget);
  if (!post) return;
  const patch = { bassFollow: on };
  // going back on follow adopts the band's line, key and changes at once, and
  // all of it has to be in the op or the other clients' menus will disagree
  if (on) {
    patch.bassLine = bandBassLine(post.id) || post.state.bassLine || 'pump';
    const harmony = bandHarmony(post.id);
    if (harmony) { patch.root = harmony.root; patch.progression = harmony.progression; }
  }
  Object.assign(post.state, patch);
  audio.refreshTone(menuTarget, post.state);
  net.sendOp({ type: 'tone', id: menuTarget, patch });
  showHud(on ? 'bass follows the band' : 'bass stays on this line');
  renderSourceMenu();
}

// choosing a groove by hand means you want that groove, not the one the band
// suggests — so both halves travel together as one op
function chooseGroove(key) {
  const post = posts.get(menuTarget);
  if (!post) return;
  Object.assign(post.state, { drumPattern: key, drumFollow: false });
  audio.refreshTone(menuTarget, post.state);
  net.sendOp({ type: 'tone', id: menuTarget,
    patch: { drumPattern: key, drumFollow: false } });
  showHud(`DRUMS — ${DRUM_PATTERNS[key].label.toUpperCase()}`);
  renderSourceMenu();
}

function chooseDrumFollow(on) {
  const post = posts.get(menuTarget);
  if (!post) return;
  const patch = { drumFollow: on };
  // switching follow back on adopts the band's groove immediately, and that
  // resolved value has to be in the op or the menu lies to everyone else
  if (on) patch.drumPattern = bandGroove(post.id) || post.state.drumPattern || 'rock';
  Object.assign(post.state, patch);
  audio.refreshTone(menuTarget, post.state);
  net.sendOp({ type: 'tone', id: menuTarget, patch });
  showHud(on ? 'drums follow the band' : 'drums stay on this groove');
  renderSourceMenu();
}

function chooseToneOption(field, value) {
  const post = posts.get(menuTarget);
  if (!post) return;
  post.state[field] = value;
  audio.refreshTone(menuTarget, post.state);
  net.sendOp({ type: 'tone', id: menuTarget, patch: { [field]: value } });
  syncDrums(); // a new riff or strum style is a new groove for the drummer
  showHud(toneLabel(post.state));
  renderSourceMenu();
}

function chooseSync(on) {
  const post = posts.get(menuTarget);
  if (!post) return;
  // sync is per-post tone state; joining the clock also adopts its tempo
  const patch = on ? { sync: true, bpm: audio.transportBpm() } : { sync: false };
  Object.assign(post.state, patch);
  audio.refreshTone(menuTarget, post.state); // re-enters on the shared beat grid
  net.sendOp({ type: 'tone', id: menuTarget, patch });
  showHud(on ? `SYNCED — ${audio.transportBpm()} BPM, locked to the beat` : 'FREE RUN');
  renderSourceMenu();
}

function chooseBpm(bpm) {
  const post = posts.get(menuTarget);
  if (!post) return;
  if (post.state.sync) {
    // the shared clock is room-wide state: one op retunes every synced input
    applyBpm({ value: bpm });
    net.sendOp({ type: 'bpm', value: bpm });
    showHud(`TRANSPORT ${bpm} BPM — synced inputs locked`);
  } else {
    post.state.bpm = bpm;
    audio.refreshTone(menuTarget, post.state);
    net.sendOp({ type: 'tone', id: menuTarget, patch: { bpm } });
    showHud(`${bpm} BPM (free)`);
  }
  renderSourceMenu();
}

// the settings panel docks to the right edge — it never floats
function openPanel(id) {
  menuTarget = id;
  // the riff drawer belongs to riff inputs only: selecting the drums or a
  // pedal shouldn't leave a shelf of riffs sitting there
  const post = posts.get(id);
  if (post?.type === 'source') setRiffShelf(post.state.mode === 'riff');
  renderSourceMenu();
  sourceMenu.style.display = 'flex';
}
function hidePanel() { sourceMenu.style.display = 'none'; }
const hideSourceMenu = hidePanel; // older name still used elsewhere

async function chooseMode(m) {
  const post = posts.get(menuTarget);
  if (!post) return;
  const st = post.state;
  try {
    if (m.kind === 'guitar') st.channel = m.channel;
    const label = await audio.setSourceMode(menuTarget, m.kind, st);
    if (m.kind === 'guitar') armedGuitar.add(menuTarget);
    else armedGuitar.delete(menuTarget);
    net.sendOp({ type: 'tone', id: menuTarget,
      patch: { mode: st.mode, channel: st.channel || 0 } });
    if (label) showHud(label);
  } catch (err) {
    console.error('[audio] source change failed', err);
    showHud(`no guitar (${err.name}) — back to the chord`);
    await audio.setSourceMode(menuTarget, 'chord', st).catch(() => {});
    net.sendOp({ type: 'tone', id: menuTarget, patch: { mode: st.mode } });
  }
  refreshBoard(); // drums and guitars enter the amp by different doors
  post.view.setKind?.(sourceLook(st.mode));
  syncDrums();
  setRiffShelf(st.mode === 'riff'); // picking a sound is what opens the drawer
  renderSourceMenu();
}

async function chooseChord(c) {
  const post = posts.get(menuTarget);
  if (!post) return;
  const st = post.state;
  st.chord = c;
  if (st.mode !== 'chord' && st.mode !== 'arp') {
    await audio.setSourceMode(menuTarget, 'chord', st).catch(() => {});
    armedGuitar.delete(menuTarget);
  }
  audio.refreshTone(menuTarget, st);
  net.sendOp({ type: 'tone', id: menuTarget, patch: { chord: c, mode: st.mode } });
  syncDrums();
  showHud(toneLabel(st));
  renderSourceMenu();
}

/* --------------------------------------------------------------- bakery -- */

const BAKE_WORDS = [
  'Noodling', 'Riffing', 'Shredding', 'Woodshedding', 'Vamping', 'Twanging',
  'Chugging', 'Wailing', 'Comping', 'Dialing in', 'Chasing tone',
  'Soundchecking', 'Warming the tubes', 'Bending strings', 'Feeding back',
  'Palm muting', 'Sweep picking', 'Tuning down',
];

async function bake(description) {
  if (!description.trim()) return;
  bakeButton.disabled = true;
  bakeButton.innerHTML = '<span class="spinner"></span>';
  bakeStatus.classList.add('pulse');
  // word + fixed-width dot cell, so the animation never shifts the text
  bakeStatus.innerHTML = '';
  const wordEl = document.createElement('span');
  const dotsEl = document.createElement('span');
  dotsEl.style.cssText = 'display:inline-block;width:1.1em;text-align:left';
  bakeStatus.append(wordEl, dotsEl);
  wordEl.textContent = BAKE_WORDS[Math.floor(Math.random() * BAKE_WORDS.length)];
  let dots = 0;
  const wordTimer = setInterval(() => {
    wordEl.textContent = BAKE_WORDS[Math.floor(Math.random() * BAKE_WORDS.length)];
  }, 2600);
  const dotTimer = setInterval(() => {
    dots = (dots % 3) + 1;
    dotsEl.textContent = '.'.repeat(dots);
  }, 350);
  try {
    const res = await fetch('/bake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const spec = data.spec;
    if (!data.cached) {
      spec._mtime = Date.now() / 1000;
      shelfSpecs.push(spec);
      renderShelf();
      net.sendShelf(); // the other bakers' shelves refresh too
    }
    spawnPedal(spec);
    bakeStatus.textContent = data.cached
      ? `from the shelf (cached, ${Math.round(data.similarity * 100)}% match): ${spec.name}`
      : `fresh out of the oven: ${spec.name} (saved to the shelf)`;
  } catch (err) {
    bakeStatus.textContent = `bake failed: ${err.message}`;
    console.error('[bakery]', err);
  } finally {
    clearInterval(wordTimer);
    clearInterval(dotTimer);
    bakeStatus.classList.remove('pulse');
    bakeButton.textContent = 'BAKE';
    bakeButton.disabled = false;
  }
}

canvas.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('application/x-pedal-spec')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
canvas.addEventListener('drop', (e) => {
  const raw = e.dataTransfer.getData('application/x-pedal-spec');
  if (!raw) return;
  e.preventDefault();
  const g = view.groundPointFromClient(e.clientX, e.clientY);
  const clampi = (v) => Math.max(-GRID_HALF, Math.min(GRID_HALF, Math.round(v / SNAP) * SNAP));
  spawnPedal(JSON.parse(raw), { x: clampi(g.x), z: clampi(g.z) });
});

bakeButton.addEventListener('click', () => bake(bakeInput.value));
bakeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') bake(bakeInput.value);
  e.stopPropagation(); // typing must not orbit the camera
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { cancelPatch(); hideSourceMenu(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected
      && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    if (instances.has(selected)) removePedal(selected);
    else removeEndpoint(selected);
  }
});

/* --------------------------------------------------- the room lifecycle -- */

const badge = document.getElementById('room-badge');
const badgeCode = document.getElementById('room-code-txt');
const badgeName = document.getElementById('room-name-txt');
const badgeNameEdit = document.getElementById('room-name-edit');
let roomName = '';
const badgePlayers = document.getElementById('room-players');
const badgeCopy = document.getElementById('room-copy');

function updateBadge() {
  const n = others.size + 1;
  badgeCode.textContent = net.code() || '';
  badgePlayers.textContent = `${n} BAKER${n === 1 ? '' : 'S'}`;
}
badgeCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(net.code() || '');
    badgeCopy.textContent = 'COPIED';
    setTimeout(() => { badgeCopy.textContent = 'COPY'; }, 1400);
  } catch { /* clipboard needs https or localhost; the code is visible anyway */ }
});

function resetWorld() {
  cancelPatch();
  selectPedal(null);
  hideSourceMenu();
  for (const inst of instances.values()) {
    audio.disposeRig(inst.id);
    inst.view.dispose();
  }
  instances.clear();
  for (const post of posts.values()) {
    if (post.type === 'source') audio.disposeSource(post.id);
    else audio.disposeAmp(post.id);
    post.view.dispose();
  }
  posts.clear();
  for (const c of board.connections()) board.disconnectJack(c.from, 'out');
  refreshBoard();
}

// Every welcome — first join AND reconnect — rebuilds from the server
// snapshot. The snapshot is the truth; whatever we had is gone.
let seedOnWelcome = false; // set only by createBakery: the creator seeds once
function enterRoom(msg) {
  resetWorld();
  others.clear();
  view.clearPlayerMarkers();
  for (const p of msg.players) {
    others.set(p.id, p);
    view.setPlayerMarker(p.id, p);
  }
  const st = msg.state;
  // transport first: synced sources must bake to the room clock, not the default
  if (st.bpm) audio.setTransportBpm(st.bpm);
  for (const [id, post] of Object.entries(st.posts)) {
    applySpawnPost({ type: 'spawnPost', id, ptype: post.ptype, st: post.st, pos: post.pos });
  }
  for (const [id, pedal] of Object.entries(st.pedals)) {
    applySpawn({ type: 'spawn', id, spec: pedal.spec, st: pedal.st, pos: pedal.pos });
  }
  for (const [from, to] of st.cables) board.connect(from, to);
  refreshBoard();
  // the snapshot stores the groove a following drummer had when it was last
  // set by hand; re-derive so a late joiner hears the same kit as the room
  syncDrums();
  // Only the creator seeds the starter board — a joiner finding an empty
  // room leaves it empty (deliberately cleared, or a seeding race).
  const fresh = seedOnWelcome && !posts.size && !instances.size;
  if (fresh) {
    spawnSource();
    spawnAmp();
  }
  seedOnWelcome = false;
  overlay.remove();
  badge.hidden = false;
  revealRecorder();
  updateBadge();
  lastSent = null; // announce our position to the room we just (re)entered
  // a brand-new bakery is one clean chord and an amp; offer the presets so a
  // first-timer can hear a whole band before they've built anything
  if (fresh) {
    openPresets();
    showHud('new bakery — load a preset to hear a band, or build your own', true);
  } else {
    showHud(`BAKERY ${msg.code} — invite with the code (top right)`);
  }
}

/* presence: stream where our camera looks + where our cursor is */
let lastSent = null; // null -> always announce ourselves once after connecting
setInterval(() => {
  if (!net.connected()) return;
  const t = view.camera.target, c = cursorGround;
  if (lastSent) {
    const moved = Math.abs(t.x - lastSent.x) + Math.abs(t.z - lastSent.z)
                + Math.abs(c.x - lastSent.cx) + Math.abs(c.z - lastSent.cz);
    if (moved < 0.01) return;
  }
  lastSent = { x: t.x, z: t.z, cx: c.x, cz: c.z };
  net.sendPos(t.x, t.z, c.x, c.z);
}, 90);

/* ----------------------------------------------------------- the lobby -- */

const params = new URLSearchParams(location.search);
const nameInput = document.getElementById('player-name');
const lobbyError = document.getElementById('lobby-error');
const joinRow = document.getElementById('join-row');
const joinCode = document.getElementById('join-code');
const sessionsList = document.getElementById('lobby-sessions');
const sessionsTitle = document.getElementById('lobby-title-sm');

function setLobbyBusy(busy) {
  for (const b of overlay.querySelectorAll('button')) b.disabled = busy;
}

// One connect attempt at a time: buttons disable, but Enter/double-click and
// session rows must hit the same wall.
let entering = false;

const bakeryNameInput = document.getElementById('bakery-name');

async function enterBakery(code, role) {
  if (entering) return;
  entering = true;
  const name = nameInput.value.trim() || 'baker';
  localStorage.setItem('playerName', name);
  lobbyError.textContent = '';
  setLobbyBusy(true);
  audio.start(); // we are inside a user gesture — the only place sound can start
  try {
    await net.connect(code, name);
    rememberBakery(code, role, roomName); // enterRoom() ran via onWelcome
  } catch (err) {
    seedOnWelcome = false; // a failed host connect must not seed a later join
    lobbyError.textContent = err.message;
    setLobbyBusy(false);
  } finally {
    entering = false;
  }
}

async function createBakery() {
  if (entering) return;
  lobbyError.textContent = '';
  setLobbyBusy(true);
  try {
    const res = await fetch('/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bakeryNameInput.value.trim().slice(0, 40) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    seedOnWelcome = true; // we made this room; we lay out the starter board
    await enterBakery(data.code, 'host');
  } catch (err) {
    lobbyError.textContent = /fetch/i.test(err.message)
      ? 'bakery server unreachable — run python3 bakery/server.py' : err.message;
    setLobbyBusy(false);
  }
}

function setRoomName(name) {
  roomName = name || '';
  badgeName.textContent = roomName;
  if (net.code()) rememberBakery(net.code(), 'guest', roomName);
}

function commitRename() {
  const next = badgeNameEdit.value.trim().slice(0, 40);
  badgeNameEdit.hidden = true;
  badgeName.hidden = false;
  if (next === roomName) return;
  setRoomName(next);
  net.rename(next); // everyone in the bakery sees the new name
  showHud(next ? `renamed to ${next}` : 'name cleared');
}

badgeName.addEventListener('click', () => {
  badgeNameEdit.value = roomName;
  badgeName.hidden = true;
  badgeNameEdit.hidden = false;
  badgeNameEdit.focus();
  badgeNameEdit.select();
});
badgeNameEdit.addEventListener('keydown', (e) => {
  e.stopPropagation(); // typing must not drive the board
  if (e.key === 'Enter') commitRename();
  if (e.key === 'Escape') { badgeNameEdit.hidden = true; badgeName.hidden = false; }
});
badgeNameEdit.addEventListener('blur', commitRename);

function renderSessions() {
  const list = savedBakeries();
  sessionsTitle.hidden = !list.length;
  sessionsList.innerHTML = '';
  for (const b of list) {
    const row = document.createElement('button');
    row.className = 'session-row';
    const label = document.createElement('span');
    label.className = 'session-name';
    label.textContent = b.name || 'unnamed bakery';
    const code = document.createElement('span');
    code.className = 'session-code';
    code.textContent = b.code;
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = (b.role === 'host' ? 'yours · ' : 'joined · ')
      + new Date(b.ts).toLocaleDateString();
    const x = document.createElement('span');
    x.className = 'session-x';
    x.textContent = '✕';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      forgetBakery(b.code);
      renderSessions();
    });
    row.append(label, code, meta, x);
    row.addEventListener('click', () => enterBakery(b.code, b.role));
    sessionsList.appendChild(row);
  }
}

function wireLobby() {
  nameInput.value = localStorage.getItem('playerName') || '';
  document.getElementById('create-bakery').addEventListener('click', createBakery);
  document.getElementById('join-bakery').addEventListener('click', () => {
    joinRow.hidden = false;
    joinCode.focus();
  });
  const join = () => {
    const code = joinCode.value.trim().toUpperCase();
    if (code.length !== 5) { lobbyError.textContent = 'codes are 5 characters'; return; }
    enterBakery(code, 'guest');
  };
  document.getElementById('join-go').addEventListener('click', join);
  joinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  nameInput.addEventListener('keydown', (e) => e.stopPropagation());
  bakeryNameInput.addEventListener('keydown', (e) => e.stopPropagation());
  joinCode.addEventListener('keydown', (e) => e.stopPropagation());
  renderSessions();
  if (params.get('room')) { // invite links: ?room=CODE prefills the join flow
    joinRow.hidden = false;
    joinCode.value = params.get('room').toUpperCase();
  }
}



/* ------------------------------------------------------- the riff shelf -- */
// Mirrors the pedal shelf: built-in riffs plus anything baked by the LLM,
// clicking one plays it on the current tone post.

const riffList = document.getElementById('riff-list');
const riffSearch = document.getElementById('riff-search');
const riffClose = document.getElementById('riff-close');
const riffInput = document.getElementById('riff-input');
const riffButton = document.getElementById('riff-button');
const riffStatus = document.getElementById('riff-status');
const bakedRiffs = new Map(); // id -> riff data from the server

// The drawer is local chrome, not board state — it never travels over the
// wire, so each player opens and closes their own.
function riffShelfOpen() { return document.body.classList.contains('riffs-open'); }
function setRiffShelf(open) { document.body.classList.toggle('riffs-open', open); }
riffClose.addEventListener('click', () => { setRiffShelf(false); renderSourceMenu(); });

function currentTonePost() {
  const chosen = posts.get(menuTarget);
  if (chosen && chosen.type === 'source') return chosen;
  return [...posts.values()].find((p) => p.type === 'source') || null;
}

function allRiffEntries() {
  const out = Object.entries(RIFFS).map(([id, r]) => ({ id, label: r.label, riff: r, builtin: true }));
  for (const [id, r] of bakedRiffs) out.push({ id, label: r.label || r.name, riff: r, builtin: false });
  return out;
}

function renderRiffShelf() {
  const q = riffSearch.value.trim().toLowerCase();
  const post = currentTonePost();
  const active = post?.state.riff;
  riffList.innerHTML = '';
  for (const e of allRiffEntries()) {
    const hay = `${e.label} ${e.riff.genre || ''} ${e.riff.bakedFrom || ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const item = document.createElement('button');
    item.className = 'riff-item' + (active === e.id ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'ri-name';
    name.textContent = e.label;
    const meta = document.createElement('div');
    meta.className = 'ri-meta';
    const notes = e.riff.notes?.length ?? 0;
    const micro = (e.riff.notes || []).some((n) => Math.abs(n.s % 1) > 0.01);
    meta.textContent = [e.riff.genre || (e.builtin ? 'built-in' : 'baked'),
      `${notes} notes`, `${e.riff.beats} beats`, micro ? 'microtonal' : null]
      .filter(Boolean).join(' · ');
    item.append(name, meta);
    item.addEventListener('click', () => playRiff(e.id));
    riffList.appendChild(item);
  }
}

function playRiff(id) {
  const post = currentTonePost();
  if (!post) { showHud('add a TONE IN first'); return; }
  menuTarget = post.id;
  post.state.riff = id;
  post.state.mode = 'riff';
  audio.setSourceMode(post.id, 'riff', post.state)
    .then(() => { audio.refreshTone(post.id, post.state); })
    .catch((err) => console.error('[riff] failed', err));
  net.sendOp({ type: 'tone', id: post.id, patch: { mode: 'riff', riff: id } });
  const label = allRiffEntries().find((e) => e.id === id)?.label || id;
  showHud(`RIFF — ${label}`);
  renderRiffShelf();
  if (sourceMenu.style.display === 'flex') renderSourceMenu();
}

async function loadRiffs() {
  try {
    const res = await fetch('/riffs');
    for (const r of await res.json()) {
      bakedRiffs.set(r.id, r);
      audio.registerRiff(r.id, r);
    }
  } catch (err) {
    console.warn('[riffs] could not load baked riffs', err);
  }
  renderRiffShelf();
}

const RIFF_WORDS = ['Woodshedding', 'Transcribing', 'Jamming', 'Phrasing',
  'Bending', 'Sliding', 'Comping', 'Scoring'];

async function bakeRiff(description) {
  if (!description.trim()) return;
  riffButton.disabled = true;
  let dots = 0;
  const word = RIFF_WORDS[Math.floor(Math.random() * RIFF_WORDS.length)];
  const timer = setInterval(() => {
    dots = (dots % 3) + 1;
    riffStatus.textContent = word + '.'.repeat(dots);
  }, 350);
  try {
    const res = await fetch('/riff', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const riff = data.riff;
    const id = riff.id || riff.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    riff.id = id;
    bakedRiffs.set(id, riff);
    audio.registerRiff(id, riff);
    renderRiffShelf();
    playRiff(id);
    riffStatus.textContent = data.cached ? `from the shelf: ${riff.name}` : `baked: ${riff.name}`;
    net.sendShelf();
  } catch (err) {
    riffStatus.textContent = `riff failed: ${err.message}`;
    console.error('[riff]', err);
  } finally {
    clearInterval(timer);
    riffButton.disabled = false;
  }
}

riffButton.addEventListener('click', () => bakeRiff(riffInput.value));
riffInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') bakeRiff(riffInput.value);
  e.stopPropagation();
});
riffSearch.addEventListener('keydown', (e) => e.stopPropagation());
riffSearch.addEventListener('input', renderRiffShelf);
loadRiffs();


/* ------------------------------------------------------------- the tape --
   A MediaRecorder on the master bus, so a take is exactly what you heard:
   every amp, every pedal, every other player's gear, already mixed. The
   recording never leaves this browser until you download or share it. */

const recPanel = document.getElementById('recorder');
const recToggle = document.getElementById('rec-toggle');
const recLabel = document.getElementById('rec-label');
const recTime = document.getElementById('rec-time');
const recTake = document.getElementById('rec-take');
const recAudio = document.getElementById('rec-audio');
const recSave = document.getElementById('rec-save');
const recShare = document.getElementById('rec-share');
const recBin = document.getElementById('rec-bin');

let take = null;     // the last finished recording: { blob, url, name }
let recTicker = null;

// the lobby owns the screen until you're in a bakery, so the tape waits its
// turn — and never appears at all where MediaRecorder doesn't exist
function revealRecorder() { recPanel.hidden = !audio.canRecord(); }

function clockText(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function binTake() {
  if (take) URL.revokeObjectURL(take.url);
  take = null;
  recAudio.removeAttribute('src');
  recTake.hidden = true;
}

function takeName(type) {
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const slug = (roomName || 'bakery').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const now = new Date();
  const stamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${slug || 'bakery'}-${stamp}.${ext}`;
}

async function toggleRecording() {
  if (audio.recording()) {
    recToggle.disabled = true;
    clearInterval(recTicker);
    const result = await audio.stopRecording();
    recToggle.disabled = false;
    recPanel.classList.remove('on');
    recLabel.textContent = 'RECORD';
    recTime.hidden = true;
    if (!result || !result.blob.size) { showHud('nothing came out — no take saved'); return; }
    binTake();
    const name = takeName(result.type);
    take = { blob: result.blob, url: URL.createObjectURL(result.blob), name };
    recAudio.src = take.url;
    // the native share sheet only exists on some browsers, and only for files
    recShare.hidden = !navigator.canShare?.({
      files: [new File([result.blob], name, { type: result.blob.type })],
    });
    recTake.hidden = false;
    showHud(`${clockText(result.seconds)} in the can — ${name}`);
    return;
  }
  if (!audio.started()) { showHud('click the board first to wake the sound up'); return; }
  binTake();
  if (!audio.startRecording()) { showHud('this browser will not record'); return; }
  recPanel.classList.add('on');
  recLabel.textContent = 'STOP';
  recTime.hidden = false;
  recTime.textContent = '0:00';
  recTicker = setInterval(() => {
    recTime.textContent = clockText(audio.recordedSeconds());
  }, 500);
}

recToggle.addEventListener('click', toggleRecording);
recBin.addEventListener('click', binTake);
recSave.addEventListener('click', () => {
  if (!take) return;
  const a = document.createElement('a');
  a.href = take.url;
  a.download = take.name;
  a.click();
});
recShare.addEventListener('click', async () => {
  if (!take) return;
  const file = new File([take.blob], take.name, { type: take.blob.type });
  try {
    await navigator.share({ files: [file], title: 'a take from the pedal bakery' });
  } catch { /* the sheet was dismissed, or the browser said no */ }
});

/* ---------------------------------------------------------- the presets --
   A preset is a whole board somebody kept: pedals, players, cabling, tempo.
   It exists so a new bakery has a one-click way to sound like a band instead
   of like one clean chord. Loading replaces the board for the WHOLE room,
   and does it as ordinary remove/spawn/connect ops — no new op type, so the
   server replays it and a late joiner rebuilds it like any other edit. */

let presetDocs = [];
const presetName = document.createElement('input'); // lives across re-renders

async function loadPresetList() {
  try {
    presetDocs = await fetchPresets();
  } catch (err) {
    presetDocs = [];
    console.warn('[presets] could not load', err);
  }
  return presetDocs;
}

function openPresets() {
  menuTarget = null; // no node owns this panel, so nothing can re-render over it
  sourceMenu.style.display = 'flex';
  renderPresetPanel();
  loadPresetList().then(() => {
    if (sourceMenu.dataset.panel === 'presets') renderPresetPanel();
  });
}

function boardSummary() {
  const modes = [...posts.values()].filter((p) => p.type === 'source')
    .map((p) => p.state.mode);
  return [...new Set(modes)].join(' + ') || 'empty board';
}

function renderPresetPanel() {
  panelRefs.clear();
  sourceMenu.dataset.panel = 'presets';
  sourceMenu.innerHTML = '';
  panelHead('Presets', 'whole boards, ready to play');
  if (!presetDocs.length) {
    const empty = document.createElement('div');
    empty.className = 'panel-sub';
    empty.style.padding = '0 12px 8px';
    empty.textContent = 'nothing saved yet — build a board and keep it below';
    sourceMenu.appendChild(empty);
  }
  for (const doc of presetDocs) {
    const item = document.createElement('button');
    item.className = 'riff-item';
    const name = document.createElement('div');
    name.className = 'ri-name';
    name.textContent = doc.name;
    const meta = document.createElement('div');
    meta.className = 'ri-meta';
    const players = (doc.posts || []).filter((p) => p.ptype === 'source').length;
    meta.textContent = [doc.tagline, `${players} players`,
      `${(doc.pedals || []).length} pedals`, `${doc.bpm} BPM`].filter(Boolean).join(' · ');
    item.append(name, meta);
    item.addEventListener('click', () => loadPresetDoc(doc));
    sourceMenu.appendChild(item);
  }
  const warn = document.createElement('div');
  warn.className = 'panel-sub';
  warn.style.padding = '8px 12px 2px';
  warn.textContent = 'loading one replaces the board for everyone in the bakery';
  sourceMenu.appendChild(warn);

  const section = document.createElement('div');
  section.className = 'menu-section';
  section.textContent = 'KEEP THIS BOARD';
  sourceMenu.appendChild(section);
  presetName.className = 'preset-name';
  presetName.type = 'text';
  presetName.placeholder = 'name this board…';
  presetName.spellcheck = false;
  presetName.onkeydown = (e) => {
    e.stopPropagation(); // the board's keyboard shortcuts are not for typing in
    if (e.key === 'Enter') saveBoardAsPreset(presetName.value);
  };
  sourceMenu.appendChild(presetName);
  const save = document.createElement('button');
  save.className = 'panel-btn';
  save.textContent = `SAVE — ${boardSummary()}`;
  save.addEventListener('click', () => saveBoardAsPreset(presetName.value));
  sourceMenu.appendChild(save);
  const status = document.createElement('div');
  status.className = 'panel-sub';
  status.id = 'preset-status';
  status.style.padding = '6px 12px 0';
  sourceMenu.appendChild(status);
}

function presetStatus(text) {
  const el = document.getElementById('preset-status');
  if (el) el.textContent = text;
}

function loadPresetDoc(doc) {
  // out with whatever was there: a preset IS the room now, not an addition
  for (const id of [...instances.keys(), ...posts.keys()]) {
    applyRemove(id);
    net.sendOp({ type: 'remove', id });
  }
  for (const op of presetOps(doc, nextId)) {
    applyOp(op);
    net.sendOp(op);
  }
  hidePanel();
  showHud(`${doc.name.toUpperCase()} — ${doc.tagline || 'loaded'}`);
}

async function saveBoardAsPreset(name) {
  if (!name.trim()) { presetStatus('give it a name first'); return; }
  if (!posts.size && !instances.size) { presetStatus('nothing on the board to keep'); return; }
  const nodes = [
    ...[...posts.values()].map((p) => ({
      id: p.id, kind: p.type, st: p.state, pos: p.view.position() })),
    ...[...instances.values()].map((i) => ({
      id: i.id, kind: 'pedal', spec: i.spec, st: i.state, pos: i.view.position() })),
  ];
  presetStatus('saving…');
  try {
    const doc = boardToPreset({
      name: name.trim(), tagline: boardSummary(), bpm: audio.transportBpm(),
      nodes, cables: board.connections().map((c) => [c.from, c.to]),
    });
    const saved = await savePreset(doc);
    presetDocs = presetDocs.filter((d) => d.id !== saved.id).concat(saved);
    presetName.value = '';
    renderPresetPanel();
    presetStatus(`kept as ${saved.name}`);
    showHud(`${saved.name.toUpperCase()} saved to the presets`);
  } catch (err) {
    presetStatus(`could not save: ${err.message}`);
    console.error('[presets]', err);
  }
}

{
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = '★ PRESETS';
  b.addEventListener('click', openPresets);
  shelfTools.appendChild(b);
}

/* ------------------------------------------------- sound you can look at --
   Once a frame, every amp's live waveform is handed to its own wave halo.
   Purely local: it reads what THIS client hears, so it needs no op and no
   round trip — everyone's screen animates from their own audio graph. */

view.scene.onBeforeRenderObservable.add(() => {
  if (!audio.started()) return;
  for (const post of posts.values()) {
    if (post.type === 'amp') post.view.pushWave?.(audio.ampScope(post.id));
  }
  for (const inst of instances.values()) {
    if (inst.spec.kind === 'amp') inst.view.pushWave?.(audio.ampScope(inst.id));
  }
});

/* master volume — always reachable, and a mute for when something is wrong */
{
  const slider = document.getElementById('master-vol');
  const txt = document.getElementById('master-vol-txt');
  const show = (v) => { txt.textContent = Math.round(v * 100); };
  slider.value = Math.round(audio.masterVolume() * 100);
  show(audio.masterVolume());
  slider.addEventListener('input', () => {
    const v = Number(slider.value) / 100;
    audio.setMasterVolume(v);
    show(v);
  });
  slider.addEventListener('keydown', (e) => e.stopPropagation());
  document.getElementById('panic').addEventListener('click', () => {
    audio.panic();
    slider.value = 0;
    show(0);
    showHud('MUTED');
  });
}

/* ----------------------------------------------------------------- boot -- */

loadShelf();
loadPresetList();

if (params.get('solo')) {
  // headless/offline path: straight to a playable board, no lobby, no room.
  // net.sendOp() is a no-op while disconnected, so everything just works.
  overlay.remove();
  revealRecorder();
  spawnSource();
  spawnAmp();
  canvas.addEventListener('pointerdown', () => { // sound still needs a gesture
    audio.start();
    for (const post of posts.values()) {
      if (post.type === 'source') audio.createSource(post.id, post.state);
      else audio.createAmp(post.id, post.state);
    }
    for (const inst of instances.values()) audio.createRig(inst.id, inst.spec, inst.state);
    audio.setChain(boardChains());
  }, { once: true });
} else {
  wireLobby();
}

/* debug hooks for automated browser tests */
window.__pedal = {
  instances: () => [...instances.keys()],
  posts: () => [...posts.values()].map((p) => ({ id: p.id, type: p.type })),
  spec: (id) => instances.get(id)?.spec,
  state: (id) => instances.get(id)?.state ?? posts.get(id)?.state,
  spawn: spawnPedal,
  spawnSource,
  spawnDrums,
  spawnBass,
  spawnAmp,
  groove: (id, key) => { menuTarget = id; chooseGroove(key); },
  drumFollow: (id, on) => { menuTarget = id; chooseDrumFollow(on); },
  bassLine: (id, key) => { menuTarget = id; chooseBassLine(key); },
  bassFollow: (id, on) => { menuTarget = id; chooseBassFollow(on); },
  bandGroove,
  bandBassLine,
  remove: (id) => (instances.has(id) ? removePedal(id) : removeEndpoint(id)),
  connect: (from, to) => {
    board.connect(from, to);
    refreshBoard();
    net.sendOp({ type: 'connect', from, to });
  },
  disconnect: (node, kind) => {
    board.disconnectJack(node, kind);
    refreshBoard();
    net.sendOp({ type: 'disconnect', node, kind });
  },
  chains: boardChains,
  set: (id, cid, v) => {
    applyKnob({ id, control: cid, value: v });
    net.sendOp({ type: 'knob', id, control: cid, value: v });
  },
  setSource: async (id, kind, chord) => {
    menuTarget = id;
    if (chord) posts.get(id).state.chord = chord;
    await chooseMode({ kind, channel: posts.get(id).state.channel || 0 });
    if (chord) audio.refreshTone(id, posts.get(id).state);
  },
  tone: (id, field, value) => { menuTarget = id; chooseToneOption(field, value); },
  openMenu: (id) => openPanel(id),
  presets: () => presetDocs.map((d) => ({ id: d.id, name: d.name })),
  openPresets,
  loadPreset: async (id) => {
    if (!presetDocs.length) await loadPresetList();
    const doc = presetDocs.find((d) => d.id === id || d.name === id);
    if (!doc) throw new Error(`no such preset: ${id}`);
    loadPresetDoc(doc);
    return doc.name;
  },
  keepPreset: (name) => saveBoardAsPreset(name),
  riffShelf: (open) => (open === undefined ? riffShelfOpen() : setRiffShelf(open)),
  volume: (id, v) => {
    applyVolume({ id, value: v });
    net.sendOp({ type: 'volume', id, value: v });
  },
  bpm: (v) => {
    applyBpm({ value: v });
    net.sendOp({ type: 'bpm', value: v });
  },
  select: selectPedal,
  selected: () => selected,
  audio: audio.contextState,
  ampLevel: (id) => audio.ampScope(id)?.rms ?? null,
  record: toggleRecording,
  recording: audio.recording,
  take: () => take && { name: take.name, type: take.blob.type, size: take.blob.size },
  jacks: () => allJacks().map((j) => ({ node: j.node, kind: j.kind, at: view.project(j.jack.pos()) })),
  patching: () => patching && { node: patching.node, kind: patching.kind },
  screenPos: (id, name) =>
    (instances.get(id) ?? posts.get(id))?.view.screenPos(name),
  camera: () => ({
    alpha: view.camera.alpha, beta: view.camera.beta,
    radius: view.camera.radius, target: view.camera.target.asArray(),
  }),
  setCamera: (alpha, beta, radius, target) => {
    // target first: assigning .target rebuilds alpha/beta/radius from the
    // current position, which would clobber values assigned before it
    if (target) view.camera.target = new BABYLON.Vector3(target[0], target[1], target[2]);
    view.camera.alpha = alpha;
    view.camera.beta = beta;
    view.camera.radius = radius;
  },
  net: () => ({ code: net.code(), connected: net.connected(),
    you: net.you(), players: [...others.values()] }),
  join: (code, name) => {
    if (name) nameInput.value = name;
    return enterBakery(code, 'guest');
  },
  create: () => createBakery(),
};
