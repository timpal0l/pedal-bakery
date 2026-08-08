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
import { createScene, GRID_HALF, SNAP } from './scene.js';
import { createBoard } from './board.js';
import { CHORDS, KEYS, INTERVALS, DETUNES } from './config.js';
import { STRUM_STYLES, ARP_PATTERNS } from './audio.js';
import { createNet, playerIdentity, savedBakeries, rememberBakery, forgetBakery } from './net.js';

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
  onWelcome(msg) { enterRoom(msg); },
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
  onStatus(status) {
    if (status === 'reconnecting') showHud('connection lost — rejoining the bakery…', true);
  },
});

/* ------------------------------------------------------- board plumbing -- */

function endpointOf(node, kind) {
  const j = posts.get(node)?.view.jack ?? instances.get(node)?.view.jack(kind);
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
    wanted.add(c.id);
    view.setCable(c.id, endpointOf(c.from, 'out'), endpointOf(c.to, 'in'));
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
    case 'connect': board.connect(op.from, op.to); refreshBoard(); break;
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
    posts.set(op.id, { id: op.id, type: 'source', state, view: view.buildSourcePost(op.id, op.pos) });
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
}

function applyRemove(id) {
  if (patching?.from === id) cancelPatch();
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
  } else if (st.mode === 'chord' || st.mode === 'arp' || st.mode === 'interval') {
    audio.refreshTone(op.id, st);
  }
  if (menuTarget === op.id && sourceMenu.style.display === 'flex') renderSourceMenu();
}

function applyBpm(op) {
  audio.setTransportBpm(op.value);
  for (const post of posts.values()) { // synced loops re-bake to the new clock
    if (post.type === 'source' && post.state.sync
        && ['chord', 'arp', 'interval'].includes(post.state.mode)) {
      audio.refreshTone(post.id, post.state);
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

function spawnSource(at) {
  const n = [...posts.values()].filter((p) => p.type === 'source').length;
  if (n >= 2) { showHud('two inputs max for now'); return null; }
  const op = { type: 'spawnPost', id: nextId('s'), ptype: 'source',
    pos: at ?? { x: 7.6, z: [0, 3.5, -3.5, 7, -7][n % 5] },
    st: { mode: 'chord', chord: 'major', root: 0, strumStyle: 'ring',
      arpPattern: 'up', interval: 350, detune: 0, volume: 5,
      bpm: 100, sync: true, // inputs join the shared clock by default
      channel: n } }; // post N maps to interface input N+1
  applySpawnPost(op);
  net.sendOp(op);
  showHud('TONE IN added — click it to pick a chord');
  return op.id;
}

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
  showHud(post.type === 'source' ? 'tone removed' : 'amp removed');
}

/* ------------------------------------------------------------ the shelf -- */

for (const [label, fn] of [['+ TONE IN', spawnSource], ['+ AMP', spawnAmp]]) {
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
    thumbQueue = thumbQueue.then(async () => {
      try {
        const url = await view.snapshotPedal(spec, makeState(spec));
        thumbCache.set(spec.name, url);
        img.src = url;
      } catch (err) {
        console.warn('[shelf] thumbnail failed for', spec.name, err);
      }
    });
  }
}

/* ---------------------------------------------------------- interaction -- */

let dragKnob = null;     // { pedal, id, startY, startVal }
let dragPostKnob = null; // { id, startY, startVal } — volume knob on a post/amp
let dragPedal = null;    // { id, grab }
let dragEndpoint = null; // { id, grab, moved }
let patching = null;     // { from: nodeId } — cable dangling from an output jack
let selected = null;     // pedal id highlighted for the Delete key
let menuTarget = null;   // which source post the chord menu applies to
let cursorGround = new BABYLON.Vector3(0, 0, 0);

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
window.addEventListener('pointerup', () => {
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

function startPatch(fromNode) {
  patching = { from: fromNode };
  view.setCable('__pending', endpointOf(fromNode, 'out'), pendingEndpoint(), 0.15);
  showHud('cable out — click an INPUT jack (amps count)', true);
}

function cancelPatch() {
  if (!patching) return;
  patching = null;
  view.removeCable('__pending');
  freeCamera();
  showHud('cable dropped');
}

function completePatch(toNode) {
  const from = patching.from;
  board.connect(from, toNode);
  patching = null;
  view.removeCable('__pending');
  freeCamera();
  refreshBoard();
  net.sendOp({ type: 'connect', from, to: toNode });
  showHud(boardChains().length ? 'connected — signal flows' : 'connected — no complete chain yet');
}

function jackClicked(jack) {
  const { node, kind } = jack;
  if (patching) {
    if (kind === 'in' && node !== patching.from) completePatch(node);
    else cancelPatch();
    return;
  }
  if (board.jackUsed(node, kind)) {
    board.disconnectJack(node, kind);
    refreshBoard();
    net.sendOp({ type: 'disconnect', node, kind });
    showHud('cable pulled');
  } else if (kind === 'out') {
    startPatch(node);
  } else {
    showHud('start from an OUTPUT jack');
  }
}

function toneLabel(st) {
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
      const pick = scene.pick(scene.pointerX, scene.pointerY);
      const meta = pick.hit ? pick.pickedMesh.metadata : null;
      if (!meta) {
        cancelPatch();
        selectPedal(null);
        break;
      }
      if (meta.jack) {
        holdCamera(); // pulling a cable must never rotate the camera
        jackClicked(meta.jack);
      } else if (meta.postKnob) {
        const post = posts.get(meta.postKnob);
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
      } else {
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
      // Reason-style: releasing over an input jack while dragging a cable connects
      if (patching) {
        const pick = scene.pick(scene.pointerX, scene.pointerY);
        const jack = pick.hit ? pick.pickedMesh.metadata?.jack : null;
        if (jack && jack.kind === 'in' && jack.node !== patching.from) completePatch(jack.node);
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
  { label: 'Arpeggio', kind: 'arp' },
  { label: 'Interval', kind: 'interval' },
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
  if (['chord', 'arp', 'interval'].includes(st.mode)) {
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
  if (st.mode === 'chord') {
    section('STRUM STYLE');
    chipGrid(Object.entries(STRUM_STYLES).map(([k, v]) => [k, v.label]),
      st.strumStyle || 'ring', (k) => chooseToneOption('strumStyle', k), 4);
  }
  if (st.mode === 'arp') {
    section('PATTERN');
    chipGrid(Object.entries(ARP_PATTERNS).map(([k, v]) => [k, v.label]),
      st.arpPattern || 'up', (k) => chooseToneOption('arpPattern', k), 4);
  }
  if (st.mode === 'interval') {
    section('INTERVAL — CENTS ABOVE ROOT');
    chipGrid(INTERVALS.map(([name, cents, sub]) => [cents, name, sub ?? `${cents}¢`]),
      st.interval ?? 350, (cents) => chooseToneOption('interval', cents), 3);
  }
  section('KEY');
  chipGrid(KEYS.map(([name, semi]) => [semi, name]), st.root || 0,
    (semi) => chooseToneOption('root', semi), 6);
  if (st.mode === 'chord' || st.mode === 'arp' || st.mode === 'interval') {
    section('FINE TUNE');
    chipGrid(DETUNES.map((c) => [c, c > 0 ? `+${c}¢` : `${c}¢`.replace('0¢', '0')]),
      st.detune || 0, (c) => chooseToneOption('detune', c), 7);
  }
  if (st.mode !== 'interval') { // a dyad has no chord shape; KEY is its root
    section('CHORD');
    chipGrid(Object.keys(CHORDS).map((c) => [c, c.toUpperCase()]), st.chord,
      (c) => chooseChord(c), 5);
  }
}

function chooseToneOption(field, value) {
  const post = posts.get(menuTarget);
  if (!post) return;
  post.state[field] = value;
  audio.refreshTone(menuTarget, post.state);
  net.sendOp({ type: 'tone', id: menuTarget, patch: { [field]: value } });
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
function enterRoom(msg) {
  resetWorld();
  others.clear();
  view.clearPlayerMarkers();
  for (const p of msg.players) {
    others.set(p.id, p);
    view.setPlayerMarker(p.id, p);
  }
  const st = msg.state;
  for (const [id, post] of Object.entries(st.posts)) {
    applySpawnPost({ type: 'spawnPost', id, ptype: post.ptype, st: post.st, pos: post.pos });
  }
  for (const [id, pedal] of Object.entries(st.pedals)) {
    applySpawn({ type: 'spawn', id, spec: pedal.spec, st: pedal.st, pos: pedal.pos });
  }
  for (const [from, to] of st.cables) board.connect(from, to);
  if (st.bpm) audio.setTransportBpm(st.bpm);
  refreshBoard();
  if (!posts.size && !instances.size) { // a brand-new bakery gets the basics
    spawnSource();
    spawnAmp();
  }
  overlay.remove();
  badge.hidden = false;
  updateBadge();
  lastSent = null; // announce our position to the room we just (re)entered
  showHud(`BAKERY ${msg.code} — invite with the code (top right)`);
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

async function enterBakery(code, role) {
  const name = nameInput.value.trim() || 'baker';
  localStorage.setItem('playerName', name);
  lobbyError.textContent = '';
  setLobbyBusy(true);
  audio.start(); // we are inside a user gesture — the only place sound can start
  try {
    await net.connect(code, name);
    rememberBakery(code, role); // enterRoom() has already run via onWelcome
  } catch (err) {
    lobbyError.textContent = err.message;
    setLobbyBusy(false);
  }
}

async function createBakery() {
  lobbyError.textContent = '';
  try {
    const res = await fetch('/room', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await enterBakery(data.code, 'host');
  } catch (err) {
    lobbyError.textContent = /fetch/i.test(err.message)
      ? 'bakery server unreachable — run python3 bakery/server.py' : err.message;
    setLobbyBusy(false);
  }
}

function renderSessions() {
  const list = savedBakeries();
  sessionsTitle.hidden = !list.length;
  sessionsList.innerHTML = '';
  for (const b of list) {
    const row = document.createElement('button');
    row.className = 'session-row';
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
    row.append(code, meta, x);
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
  joinCode.addEventListener('keydown', (e) => e.stopPropagation());
  renderSessions();
  if (params.get('room')) { // invite links: ?room=CODE prefills the join flow
    joinRow.hidden = false;
    joinCode.value = params.get('room').toUpperCase();
  }
}

/* ----------------------------------------------------------------- boot -- */

loadShelf();

if (params.get('solo')) {
  // headless/offline path: straight to a playable board, no lobby, no room.
  // net.sendOp() is a no-op while disconnected, so everything just works.
  overlay.remove();
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
  spawnAmp,
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
  screenPos: (id, name) => instances.get(id)?.view.screenPos(name),
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
