// ---------------------------------------------------------------------------
// The wiring — start reading here.
// Owns the board state (pedals + source posts + amps + cables) and connects
// shelf UI -> spawns, mouse -> knobs / dragging / Reason-style patching,
// board -> parallel audio chains.
// ---------------------------------------------------------------------------

import { createAudio } from './audio.js';
import { createScene, GRID_HALF, SNAP } from './scene.js';
import { createBoard } from './board.js';
import { CHORDS, KEYS } from './config.js';
import { STRUM_STYLES, ARP_PATTERNS } from './audio.js';

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
let counter = 0;

/* HUD — transient messages only; hides itself when idle */
let hudTimer = null;
function showHud(text, sticky) {
  hud.textContent = text;
  hud.style.display = 'block';
  if (hudTimer) clearTimeout(hudTimer);
  if (!sticky) hudTimer = setTimeout(() => { hud.style.display = 'none'; }, 2600);
}

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
  const id = `p${++counter}`;
  const state = makeState(spec);
  const pos = at ?? findFreeSlot(spec);
  const pedalView = view.buildPedal(id, spec, state, pos);
  instances.set(id, { id, spec, state, view: pedalView });
  audio.createRig(id, spec, state);
  refreshBoard();
  showHud(`${spec.name.toUpperCase()} on the floor — patch it in`);
  return id;
}

function spawnSource(at) {
  const n = [...posts.values()].filter((p) => p.type === 'source').length;
  if (n >= 2) { showHud('two inputs max for now'); return null; }
  const id = `s${++counter}`;
  const pos = at ?? { x: 7.6, z: [0, 3.5, -3.5, 7, -7][n % 5] };
  const state = { mode: 'chord', chord: 'major', root: 0, strumStyle: 'ring',
    arpPattern: 'up', volume: 5, channel: n, // post N maps to interface input N+1
    bpm: 100, sync: true }; // synced inputs share the transport clock
  posts.set(id, { id, type: 'source', state, view: view.buildSourcePost(id, pos) });
  audio.createSource(id, state);
  refreshBoard();
  showHud('TONE IN added — click it to pick a chord');
  return id;
}

function spawnAmp(at) {
  const id = `a${++counter}`;
  const n = [...posts.values()].filter((p) => p.type === 'amp').length;
  const pos = at ?? { x: -7.4, z: [0, 3.5, -3.5, 7, -7][n % 5] };
  const state = { volume: 5 };
  posts.set(id, { id, type: 'amp', state, view: view.buildAmp(id, pos) });
  audio.createAmp(id, state);
  refreshBoard();
  showHud('AMP added');
  return id;
}

function removePedal(id) {
  const inst = instances.get(id);
  if (!inst) return;
  if (selected === id) selected = null;
  board.removeNode(id);
  audio.disposeRig(id);
  inst.view.dispose();
  instances.delete(id);
  refreshBoard();
  showHud(`${inst.spec.name.toUpperCase()} removed`);
}

function removeEndpoint(id) {
  const post = posts.get(id);
  if (!post) return;
  board.removeNode(id);
  if (post.type === 'source') audio.disposeSource(id);
  else audio.disposeAmp(id);
  post.view.dispose();
  posts.delete(id);
  refreshBoard();
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

function selectPedal(id) {
  if (selected === id) return;
  instances.get(selected)?.view.setSelected(false);
  selected = id;
  instances.get(selected)?.view.setSelected(true);
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
  board.connect(patching.from, toNode);
  patching = null;
  view.removeCable('__pending');
  freeCamera();
  refreshBoard();
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
    showHud('cable pulled');
  } else if (kind === 'out') {
    startPatch(node);
  } else {
    showHud('start from an OUTPUT jack');
  }
}

function toneLabel(st) {
  const key = KEYS.find((k) => k[1] === (st.root || 0))?.[0] ?? 'E';
  return `${key} ${st.chord.toUpperCase()}${st.mode === 'arp' ? ' ARP' : ''}`;
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
        inst.state.switches[meta.toggle] = !inst.state.switches[meta.toggle];
        inst.view.setToggle(meta.toggle, inst.state.switches[meta.toggle]);
        audio.applyRig(meta.pedal, inst.spec, inst.state);
      } else if (meta.switch) {
        const inst = instances.get(meta.pedal);
        inst.state.on = !inst.state.on;
        inst.view.setLed(inst.state.on);
        inst.view.pressFootswitch();
        audio.applyRig(meta.pedal, inst.spec, inst.state);
        showHud(inst.state.on
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
        showHud(`${knobLabel(inst, dragKnob.id)} ${v.toFixed(1)}`, true);
      } else if (dragPostKnob) {
        const post = posts.get(dragPostKnob.id);
        const v = Math.min(10, Math.max(0,
          dragPostKnob.startVal + (dragPostKnob.startY - scene.pointerY) * 0.03));
        post.state.volume = v;
        post.view.setKnobValue(v);
        audio.setPostVolume(dragPostKnob.id, v);
        showHud(`VOLUME ${v.toFixed(1)}`, true);
      } else if (dragPedal) {
        const inst = instances.get(dragPedal.id);
        const p = cursorGround.add(dragPedal.grab);
        inst.view.setPosition(Math.round(p.x / SNAP) * SNAP, Math.round(p.z / SNAP) * SNAP);
      } else if (dragEndpoint) {
        const post = posts.get(dragEndpoint.id);
        const p = cursorGround.add(dragEndpoint.grab);
        post.view.setPosition(Math.round(p.x / SNAP) * SNAP, Math.round(p.z / SNAP) * SNAP);
        dragEndpoint.moved += Math.abs(pi.event.movementX || 0) + Math.abs(pi.event.movementY || 0);
      } else {
        const pick = scene.pick(scene.pointerX, scene.pointerY);
        canvas.style.cursor = pick.hit && pick.pickedMesh.metadata ? 'pointer' : 'default';
      }
      break;
    }
    case BABYLON.PointerEventTypes.POINTERUP: {
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
        } else if (post.type === 'source' && dragEndpoint.moved < 6) {
          menuTarget = dragEndpoint.id;
          openSourceMenu(pi.event.clientX, pi.event.clientY);
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
  { label: 'Guitar 1', kind: 'guitar', channel: 0 },
  { label: 'Guitar 2', kind: 'guitar', channel: 1 },
  { label: 'Off', kind: 'off' },
];

function renderSourceMenu() {
  const post = posts.get(menuTarget);
  if (!post || post.type !== 'source') return;
  const st = post.state;
  sourceMenu.innerHTML = '';
  const handle = document.createElement('div');
  handle.id = 'menu-handle';
  handle.textContent = 'TONE';
  sourceMenu.appendChild(handle);
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
    for (const [key, label] of entries) {
      const b = document.createElement('button');
      b.className = 'chip-sm' + (activeKey === key ? ' active' : '');
      b.textContent = label;
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
  if (st.mode === 'chord' || st.mode === 'arp') {
    section('TEMPO');
    const syncRow = document.createElement('button');
    syncRow.className = 'menu-row' + (st.sync ? ' active' : '');
    syncRow.innerHTML = `<span class="check">${st.sync ? '✓' : ''}</span><span></span>`;
    syncRow.lastChild.textContent = st.sync
      ? `Sync — shared clock, ${audio.transportBpm ? audio.transportBpm() : st.bpm} BPM`
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
  section('KEY');
  chipGrid(KEYS.map(([name, semi]) => [semi, name]), st.root || 0,
    (semi) => chooseToneOption('root', semi), 6);
  section('CHORD');
  chipGrid(Object.keys(CHORDS).map((c) => [c, c.toUpperCase()]), st.chord,
    (c) => chooseChord(c), 5);
}

function chooseBpm(bpm) {
  const post = posts.get(menuTarget);
  if (!post) return;
  const st = post.state;
  st.bpm = bpm;
  if (st.sync) {
    // synced inputs share one clock: retune the transport and rebuild them all
    audio.setTransportBpm(bpm);
    for (const p of posts.values()) {
      if (p.type === 'source' && p.state.sync) {
        p.state.bpm = bpm;
        audio.refreshTone(p.id, p.state);
      }
    }
    showHud(`TRANSPORT ${bpm} BPM — synced inputs locked`);
  } else {
    audio.refreshTone(menuTarget, st);
    showHud(`${bpm} BPM (free)`);
  }
  renderSourceMenu();
}

function chooseSync(on) {
  const post = posts.get(menuTarget);
  if (!post) return;
  post.state.sync = on;
  if (on) post.state.bpm = audio.transportBpm();
  audio.refreshTone(menuTarget, post.state); // restarts on the shared beat grid
  showHud(on ? `SYNCED — ${audio.transportBpm()} BPM, locked to the beat` : 'FREE RUN');
  renderSourceMenu();
}

function chooseToneOption(field, value) {
  const post = posts.get(menuTarget);
  if (!post) return;
  post.state[field] = value;
  audio.refreshTone(menuTarget, post.state);
  showHud(toneLabel(post.state));
  renderSourceMenu();
}

const UI_ZOOM = 1.2; // keep in sync with the CSS zoom on #source-menu

function openSourceMenu(x, y) {
  renderSourceMenu();
  sourceMenu.style.display = 'flex';
  const zx = x / UI_ZOOM, zy = y / UI_ZOOM;
  const vw = window.innerWidth / UI_ZOOM, vh = window.innerHeight / UI_ZOOM;
  sourceMenu.style.maxHeight = `${Math.floor(vh - 20)}px`; // vh units misbehave under zoom
  sourceMenu.style.left = `${Math.min(zx, vw - 356)}px`;
  const h = sourceMenu.offsetHeight;
  sourceMenu.style.top = `${Math.max(10, Math.min(zy - 40, vh - h - 10))}px`;
}
function hideSourceMenu() { sourceMenu.style.display = 'none'; }
document.addEventListener('pointerdown', (e) => {
  if (!sourceMenu.contains(e.target)) hideSourceMenu();
});

// the menu is draggable by its TONE handle
let menuDrag = null;
sourceMenu.addEventListener('pointerdown', (e) => {
  if (e.target.id !== 'menu-handle') return;
  menuDrag = { dx: e.clientX / UI_ZOOM - sourceMenu.offsetLeft,
               dy: e.clientY / UI_ZOOM - sourceMenu.offsetTop };
  e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!menuDrag) return;
  sourceMenu.style.left = `${e.clientX / UI_ZOOM - menuDrag.dx}px`;
  sourceMenu.style.top = `${e.clientY / UI_ZOOM - menuDrag.dy}px`;
});
document.addEventListener('pointerup', () => { menuDrag = null; });

async function chooseMode(m) {
  const post = posts.get(menuTarget);
  if (!post) return;
  const st = post.state;
  try {
    if (m.kind === 'guitar') st.channel = m.channel;
    const label = await audio.setSourceMode(menuTarget, m.kind, st);
    if (label) showHud(label);
  } catch (err) {
    console.error('[audio] source change failed', err);
    showHud(`no guitar (${err.name}) — back to the chord`);
    await audio.setSourceMode(menuTarget, 'chord', st).catch(() => {});
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
  }
  audio.refreshTone(menuTarget, st);
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
  if ((e.key === 'Delete' || e.key === 'Backspace')
      && selected && document.activeElement !== bakeInput) {
    e.preventDefault();
    removePedal(selected);
  }
});

/* ----------------------------------------------------------------- boot -- */

spawnSource();
spawnAmp();
loadShelf();

overlay.addEventListener('click', () => {
  audio.start();
  for (const post of posts.values()) {
    if (post.type === 'source') audio.createSource(post.id, post.state);
    else audio.createAmp(post.id, post.state);
  }
  for (const inst of instances.values()) audio.createRig(inst.id, inst.spec, inst.state);
  audio.setChain(boardChains());
  overlay.remove();
});

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
  connect: (from, to) => { board.connect(from, to); refreshBoard(); },
  disconnect: (node, kind) => { board.disconnectJack(node, kind); refreshBoard(); },
  chains: boardChains,
  set: (id, cid, v) => {
    const inst = instances.get(id);
    inst.state.values[cid] = v;
    inst.view.setKnobValue(cid, v);
    audio.applyRig(id, inst.spec, inst.state);
  },
  setSource: async (id, kind, chord) => {
    menuTarget = id;
    if (chord) posts.get(id).state.chord = chord;
    await chooseMode({ kind, channel: posts.get(id).state.channel || 0 });
    if (chord) audio.refreshTone(id, posts.get(id).state);
  },
  tone: (id, field, value) => { menuTarget = id; chooseToneOption(field, value); },
  openMenu: (id) => { menuTarget = id; openSourceMenu(320, 160); },
  volume: (id, v) => {
    const post = posts.get(id);
    post.state.volume = v;
    post.view.setKnobValue(v);
    audio.setPostVolume(id, v);
  },
  select: selectPedal,
  selected: () => selected,
  audio: audio.contextState,
  screenPos: (id, name) => instances.get(id)?.view.screenPos(name),
  camera: () => ({
    alpha: view.camera.alpha, beta: view.camera.beta,
    radius: view.camera.radius, target: view.camera.target.asArray(),
  }),
};
