// ---------------------------------------------------------------------------
// The look. A DCC-style grid floor in a white room, an amp on the left, the
// source post (your guitar) on the right, and pedals built from specs that
// can be placed anywhere. Cables are managed here too: catenary tubes that
// sway like real guitar cables, updated every frame.
//
// Interactive meshes carry metadata so main.js can tell what was clicked:
//   { pedal, knob } | { pedal, toggle } | { pedal, switch } | { pedal, body }
//   { jack: { node: 'source'|'amp'|pedalId, kind: 'in'|'out' } }
//   { endpoint: 'amp'|'source' }  (the draggable amp / source post)
// ---------------------------------------------------------------------------

import { computeLayout } from './layout.js';
import { paintFaceplate } from './artwork.js';

export const GRID_HALF = 60;     // play area; dropping a pedal past this
                                 // (far outside the panning range) removes it
export const SNAP = 0.5;         // grid snap step

function valueToAngle(v) {
  return (v - 5) / 5 * (Math.PI * 0.75);
}

export function createScene(canvas) {
  const engine = new BABYLON.Engine(canvas, true, { adaptToDeviceRatio: true });
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.855, 0.86, 0.875, 1); // studio grey, not blown white

  const camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, 0.9, 11,
    new BABYLON.Vector3(0, 0.3, 0), scene);
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 2.5;
  camera.upperRadiusLimit = 60;
  camera.lowerBetaLimit = 0.15;
  camera.upperBetaLimit = 1.35;
  camera.minZ = 0.1;
  camera.maxZ = 340; // tight far plane = solid depth precision, no grid shimmer
  // left-drag rotates in place, right-drag moves you around the room (pan
  // along the floor), wheel zooms — stock ArcRotate behavior, tuned to feel
  // like a DCC viewport: proportional zoom, a little inertia everywhere
  camera.panningSensibility = 130; // higher = slower; tuned for calm mouse2 moves
  camera.panningAxis = new BABYLON.Vector3(1, 0, 1);
  camera.panningDistanceLimit = 62;
  camera.panningInertia = 0.85;
  camera.inertia = 0.88;
  camera.angularSensibilityX = 900;
  camera.angularSensibilityY = 900;
  camera.wheelDeltaPercentage = 0.06;
  camera.zoomToMouseLocation = true; // wheel zooms toward the cursor, not the center
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // WASD flies the camera target around the floor (disabled while typing)
  const wasd = new Set();
  window.addEventListener('keydown', (e) => wasd.add(e.code));
  window.addEventListener('keyup', (e) => wasd.delete(e.code));
  window.addEventListener('blur', () => wasd.clear());
  scene.onBeforeRenderObservable.add(() => {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    let fx = 0, fz = 0;
    if (wasd.has('KeyW')) fz += 1;
    if (wasd.has('KeyS')) fz -= 1;
    if (wasd.has('KeyA')) fx -= 1;
    if (wasd.has('KeyD')) fx += 1;
    if (!fx && !fz) return;
    const dt = engine.getDeltaTime() / 1000;
    const fwd = camera.getDirection(BABYLON.Axis.Z); fwd.y = 0; fwd.normalize();
    const right = camera.getDirection(BABYLON.Axis.X); right.y = 0; right.normalize();
    const speed = 9 * dt * Math.max(0.5, camera.radius / 11);
    // mutate the target in place: the camera TRANSLATES with it (assigning a
    // new vector would re-aim from the current position = rotation)
    const t = camera.target.add(fwd.scale(fz * speed)).add(right.scale(fx * speed));
    camera.target.set(
      Math.max(-62, Math.min(62, t.x)), 0.3, Math.max(-62, Math.min(62, t.z)));
  });

  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = 0.55;
  hemi.diffuse = new BABYLON.Color3(0.93, 0.95, 1.0);      // cool sky fill
  hemi.groundColor = new BABYLON.Color3(0.88, 0.86, 0.84); // warm floor bounce
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.35, -1, 0.25), scene);
  sun.position = new BABYLON.Vector3(6, 14, -6);
  sun.intensity = 1.15;
  sun.diffuse = new BABYLON.Color3(1.0, 0.97, 0.92);       // warm key light
  const shadows = new BABYLON.ShadowGenerator(2048, sun);
  shadows.useBlurExponentialShadowMap = true;
  shadows.blurKernel = 32;

  scene.createDefaultEnvironment({ createSkybox: false, createGround: false });
  const glow = new BABYLON.GlowLayer('glow', scene);
  glow.intensity = 0.6;

  function pbr(name, hex, metallic, roughness) {
    const m = new BABYLON.PBRMaterial(name, scene);
    m.albedoColor = BABYLON.Color3.FromHexString(hex);
    m.metallic = metallic;
    m.roughness = roughness;
    return m;
  }

  /* white room with a viewport-style grid floor and a soft mirror finish */
  const matWhite = pbr('white', '#f2f2f4', 0, 0.95);
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 260, height: 260 }, scene);
  const groundMat = new BABYLON.StandardMaterial('groundMat', scene);
  groundMat.diffuseColor = BABYLON.Color3.FromHexString('#e9eaee'); // a lit pool under the board
  groundMat.specularColor = new BABYLON.Color3(0.03, 0.03, 0.03);
  const mirror = new BABYLON.MirrorTexture('mirror', { ratio: 0.5 }, scene, true);
  mirror.mirrorPlane = new BABYLON.Plane(0, -1, 0, 0);
  mirror.level = 0.22;
  mirror.adaptiveBlurKernel = 24;
  groundMat.reflectionTexture = mirror;
  ground.material = groundMat;
  ground.receiveShadows = true;
  ground.isPickable = false;
  const noReflect = new Set(['ground', 'gridOverlay', 'room']);
  mirror.renderList = scene.meshes.filter((m) => !noReflect.has(m.name));
  scene.onNewMeshAddedObservable.add((m) => {
    if (!noReflect.has(m.name)) mirror.renderList.push(m);
  });
  scene.onMeshRemovedObservable.add((m) => {
    const i = mirror.renderList.indexOf(m);
    if (i !== -1) mirror.renderList.splice(i, 1);
  });
  try {
    const ssao = new BABYLON.SSAO2RenderingPipeline('ssao', scene,
      { ssaoRatio: 0.75, blurRatio: 1 }, [camera]);
    ssao.radius = 0.7;
    ssao.totalStrength = 1.1;
    ssao.samples = 16;
    ssao.expensiveBlur = true;
  } catch (err) {
    console.warn('[scene] SSAO unavailable', err);
  }
  // post-processing bypasses the canvas MSAA, so bring AA back explicitly.
  // Crisp on purpose: no DOF, no grain, no vignette — they read as fog.
  const aa = new BABYLON.DefaultRenderingPipeline('aa', false, scene, [camera]);
  aa.fxaaEnabled = true;
  aa.samples = 4;
  if (BABYLON.GridMaterial) {
    const gmat = new BABYLON.GridMaterial('grid', scene);
    gmat.mainColor = BABYLON.Color3.FromHexString('#e9eaee');
    gmat.lineColor = BABYLON.Color3.FromHexString('#989ba8');
    gmat.gridRatio = SNAP;
    gmat.majorUnitFrequency = 4;
    gmat.opacity = 0.95;
    gmat.zOffset = -2;        // win the depth fight against the floor
    const grid = BABYLON.MeshBuilder.CreateGround('gridOverlay', { width: 260, height: 260 }, scene);
    grid.material = gmat;
    grid.position.y = 0.01;
    grid.isPickable = false;
  } else {
    console.warn('[scene] GridMaterial not loaded — plain floor');
  }
  // no walls, no fog — a crisp floor platform floating in the void

  /* shared hardware materials */
  const matKnob   = pbr('knob', '#141417', 0.1, 0.65);
  const matBezel  = pbr('bezel', '#262823', 0.4, 0.6);
  const matButton = pbr('button', '#b7bcc2', 0.9, 0.35);
  const matJack   = pbr('jack', '#cfd4da', 1.0, 0.25);
  const matPlug   = pbr('plug', '#15151a', 0.1, 0.4);
  const matCable  = pbr('cable', '#101014', 0.0, 0.35);
  const matLine = new BABYLON.StandardMaterial('line', scene);
  matLine.diffuseColor = BABYLON.Color3.FromHexString('#efe8d8');
  matLine.emissiveColor = new BABYLON.Color3(0.55, 0.52, 0.42);

  /* ------------------------------------------------------------- the amp -- */
  // Signal flows right -> left (pedal inputs face right, like the artwork),
  // so the amp lives on the left and the player's source post on the right.
  // endpoint jacks (chrome socket + short barrel), parented so they move along
  function buildEndpointJack(root, node, kind, offX, y, dirX) {
    const dir = new BABYLON.Vector3(dirX, 0, 0);
    const meta = { jack: { node, kind } };
    const sock = BABYLON.MeshBuilder.CreateCylinder('ejack_' + node, { diameter: 0.17, height: 0.18 }, scene);
    sock.parent = root;
    sock.rotation.z = Math.PI / 2;
    sock.position.set(offX + dirX * 0.05, y, 0);
    sock.material = matJack;
    sock.metadata = meta;
    const barrel = BABYLON.MeshBuilder.CreateCylinder('ebarrel_' + node, { diameter: 0.14, height: 0.24 }, scene);
    barrel.parent = root;
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(offX + dirX * 0.24, y, 0);
    barrel.material = matJack;
    barrel.metadata = meta;
    const tip = new BABYLON.Vector3(offX + dirX * 0.34, y, 0);
    return { node, kind, pos: () => root.position.add(tip), dir };
  }

  const matTolex = pbr('tolex', '#232326', 0.05, 0.8);
  const matGrille = pbr('grille', '#4d453a', 0.1, 0.9);
  const matTrimGold = pbr('trimGold', '#c8b37e', 0.8, 0.35);
  const matSrcBody = pbr('srcBody', '#b04a3a', 0.2, 0.6);

  // a small volume knob shared by tone posts and amps
  function buildVolumeKnob(root, id, x, y, z, d) {
    const spin = new BABYLON.TransformNode('vk_' + id, scene);
    spin.parent = root;
    spin.position.set(x, y, z);
    spin.rotation.y = valueToAngle(5);
    const cap = BABYLON.MeshBuilder.CreateCylinder('vkc',
      { diameter: d, height: 0.12, tessellation: 24 }, scene);
    cap.parent = spin;
    cap.position.y = 0.06;
    cap.material = matKnob;
    cap.metadata = { postKnob: id };
    const line = BABYLON.MeshBuilder.CreateBox('vkl',
      { width: 0.025, height: 0.02, depth: d * 0.42 }, scene);
    line.parent = spin;
    line.position.set(0, 0.125, d * 0.26);
    line.material = matLine;
    line.metadata = { postKnob: id };
    glow.addExcludedMesh(line);
    return { setValue: (v) => { spin.rotation.y = valueToAngle(v); } };
  }

  function endpointHandles(id, root, jack, knob) {
    return {
      id, root, jack,
      setKnobValue: knob.setValue,
      position: () => root.position,
      setPosition: (x, z) => root.position.set(x, 0, z),
      dispose: () => root.dispose(false, false),
    };
  }

  /* an amp cabinet — spawnable, input jack facing the pedals (+x) */
  function buildAmp(id, pos) {
    const root = new BABYLON.TransformNode('amp_' + id, scene);
    root.position.set(pos.x, 0, pos.z);
    const cab = BABYLON.MeshBuilder.CreateBox('ampCab', { width: 1.1, height: 3.6, depth: 2.4 }, scene);
    cab.parent = root;
    cab.position.y = 1.8;
    cab.material = matTolex;
    cab.metadata = { endpoint: id };
    shadows.addShadowCaster(cab);
    const grille = BABYLON.MeshBuilder.CreateBox('ampGrille', { width: 0.06, height: 3.0, depth: 2.1 }, scene);
    grille.parent = root;
    grille.position.set(0.56, 1.6, 0);
    grille.material = matGrille;
    grille.metadata = { endpoint: id };
    const trim = BABYLON.MeshBuilder.CreateBox('ampTrim', { width: 0.07, height: 0.16, depth: 2.1 }, scene);
    trim.parent = root;
    trim.position.set(0.56, 3.3, 0);
    trim.material = matTrimGold;
    trim.metadata = { endpoint: id };
    const knob = buildVolumeKnob(root, id, 0.3, 3.6, 0.8, 0.3);
    return endpointHandles(id, root, buildEndpointJack(root, id, 'in', 0.56, 0.32, +1), knob);
  }

  /* a source post — one tone generator, output jack toward the pedals (-x) */
  function buildSourcePost(id, pos) {
    const root = new BABYLON.TransformNode('src_' + id, scene);
    root.position.set(pos.x, 0, pos.z);
    const post = BABYLON.MeshBuilder.CreateBox('srcPost', { width: 0.55, height: 0.55, depth: 0.55 }, scene);
    post.parent = root;
    post.position.y = 0.275;
    post.material = matSrcBody;
    post.metadata = { endpoint: id };
    shadows.addShadowCaster(post);
    const knob = buildVolumeKnob(root, id, 0, 0.55, 0, 0.26);
    return endpointHandles(id, root, buildEndpointJack(root, id, 'out', -0.27, 0.3, -1), knob);
  }

  /* --------------------------------------------------------------- cables -- */
  const cables = new Map(); // id -> { mesh, bootA, bootB, phase, getA, getB, slack }

  function makeBoot() {
    const boot = BABYLON.MeshBuilder.CreateCylinder('boot', { diameter: 0.19, height: 0.32 }, scene);
    boot.material = matPlug;
    boot.isPickable = false;
    return boot;
  }

  function cablePath(a, b, t, phase, slack, energy) {
    const pa = a.pos, pb = b.pos;
    const ea = pa.add(a.dir.scale(0.42));
    const eb = pb.add(b.dir.scale(0.42));
    const span = eb.subtract(ea);
    const len = Math.max(0.001, span.length());
    const flat = new BABYLON.Vector3(span.x, 0, span.z).normalize();
    const perp = new BABYLON.Vector3(-flat.z, 0, flat.x);
    const droop = Math.min(0.9, 0.25 + len * 0.06) + slack;
    // sway only while the cable has energy (it was just moved) — at rest it hangs still
    const sway1 = energy * (Math.sin(t * 1.35 + phase) * 0.08 + Math.sin(t * 2.1 + phase * 1.7) * 0.03);
    const sway2 = energy * (Math.sin(t * 1.15 + phase + 2.1) * 0.08 + Math.sin(t * 1.8 + phase) * 0.03);
    const m1 = BABYLON.Vector3.Lerp(ea, eb, 0.35);
    const m2 = BABYLON.Vector3.Lerp(ea, eb, 0.65);
    m1.y = Math.max(0.05, m1.y - droop);
    m2.y = Math.max(0.05, m2.y - droop);
    m1.addInPlace(perp.scale(0.18 + sway1));
    m2.addInPlace(perp.scale(0.18 + sway2));
    const curve = BABYLON.Curve3.CreateCatmullRomSpline([pa, ea, m1, m2, eb, pb], 9, false);
    return curve.getPoints();
  }

  function setCable(id, getA, getB, slack = 0) {
    if (cables.has(id)) {
      const c = cables.get(id);
      c.getA = getA; c.getB = getB; c.slack = slack;
      return;
    }
    const phase = Math.random() * 7;
    const path = cablePath(getA(), getB(), 0, phase, slack, 1);
    const mesh = BABYLON.MeshBuilder.CreateTube('cable_' + id,
      { path, radius: 0.045, tessellation: 12, cap: BABYLON.Mesh.CAP_ALL, updatable: true }, scene);
    mesh.material = matCable;
    mesh.isPickable = false;
    shadows.addShadowCaster(mesh);
    cables.set(id, { mesh, bootA: makeBoot(), bootB: makeBoot(), phase, getA, getB, slack, energy: 1 });
  }

  function removeCable(id) {
    const c = cables.get(id);
    if (!c) return;
    c.mesh.dispose();
    c.bootA.dispose();
    c.bootB.dispose();
    cables.delete(id);
  }

  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() / 1000;
    for (const c of cables.values()) {
      const a = c.getA(), b = c.getB();
      const moved = !c.lastA
        || !a.pos.equalsWithEpsilon(c.lastA, 0.001)
        || !b.pos.equalsWithEpsilon(c.lastB, 0.001);
      c.energy = moved ? 1 : c.energy * 0.965; // fresh swing, then settle
      c.lastA = a.pos.clone();
      c.lastB = b.pos.clone();
      const path = cablePath(a, b, t, c.phase, c.slack, c.energy);
      BABYLON.MeshBuilder.CreateTube('cable', { path, instance: c.mesh });
      c.bootA.position = a.pos.add(a.dir.scale(0.18));
      c.bootA.rotation.z = Math.PI / 2;
      c.bootB.position = b.pos.add(b.dir.scale(0.18));
      c.bootB.rotation.z = Math.PI / 2;
      c.bootB.setEnabled(b.dir.lengthSquared() > 0.01); // no boot on a dragged end
    }
  });

  /* ------------------------------------------------------ remote players -- */
  // Each remote player is a floating glowing orb + name tag hovering where
  // their camera looks, plus a small dot on the floor under their cursor.
  // Positions lerp toward the last received presence, so a 12 Hz stream
  // still reads as smooth motion.
  const playerMarkers = new Map(); // playerId -> marker

  function makeNameTag(name, color) {
    const TW = 256, TH = 64;
    const tex = new BABYLON.DynamicTexture('ptag', { width: TW, height: TH }, scene, true);
    tex.hasAlpha = true;
    const g = tex.getContext();
    g.clearRect(0, 0, TW, TH);
    g.font = '600 26px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
    const label = String(name).slice(0, 16);
    const w = Math.min(TW - 12, g.measureText(label).width + 54);
    const x0 = (TW - w) / 2;
    g.fillStyle = 'rgba(24, 24, 30, 0.82)';
    g.beginPath();
    g.roundRect(x0, 8, w, 48, 24);
    g.fill();
    g.fillStyle = color;
    g.beginPath();
    g.arc(x0 + 26, 32, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(label, x0 + 42, 34);
    tex.update();
    const mat = new BABYLON.StandardMaterial('ptagMat', scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    const plane = BABYLON.MeshBuilder.CreatePlane('ptagPlane',
      { width: 1.7, height: 0.425 }, scene);
    plane.material = mat;
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    glow.addExcludedMesh(plane);
    return { plane, mat, tex };
  }

  function setPlayerMarker(id, { name, color }) {
    removePlayerMarker(id);
    const c3 = BABYLON.Color3.FromHexString(color);
    const root = new BABYLON.TransformNode('player_' + id, scene);
    const orbMat = new BABYLON.StandardMaterial('porb_' + id, scene);
    orbMat.emissiveColor = c3;
    orbMat.diffuseColor = c3.scale(0.4);
    const orb = BABYLON.MeshBuilder.CreateSphere('porb', { diameter: 0.22 }, scene);
    orb.parent = root;
    orb.material = orbMat;
    orb.isPickable = false;
    const tag = makeNameTag(name, color);
    tag.plane.parent = root;
    tag.plane.position.y = 0.42;
    const curMat = new BABYLON.StandardMaterial('pcur_' + id, scene);
    curMat.emissiveColor = c3;
    curMat.disableLighting = true;
    curMat.alpha = 0.75;
    const cursor = BABYLON.MeshBuilder.CreateDisc('pcursor',
      { radius: 0.14, tessellation: 24 }, scene);
    cursor.rotation.x = Math.PI / 2;
    cursor.position.y = 0.02;
    cursor.material = curMat;
    cursor.isPickable = false;
    glow.addExcludedMesh(cursor);
    const marker = {
      root, orb, tag, cursor, mats: [orbMat, curMat],
      phase: Math.random() * 7,
      target: { x: 0, z: 0, cx: 0, cz: 0 },
      cur: { x: 0, z: 0, cx: 0, cz: 0 },
      fresh: true,
    };
    playerMarkers.set(id, marker);
    return marker;
  }

  function movePlayerMarker(id, x, z, cx, cz) {
    const m = playerMarkers.get(id);
    if (!m) return;
    if (typeof x === 'number') { m.target.x = x; m.target.z = z; }
    if (typeof cx === 'number') { m.target.cx = cx; m.target.cz = cz; }
    if (m.fresh) { Object.assign(m.cur, m.target); m.fresh = false; }
  }

  function removePlayerMarker(id) {
    const m = playerMarkers.get(id);
    if (!m) return;
    m.root.dispose(false, false);
    m.cursor.dispose();
    m.tag.tex.dispose();
    m.tag.mat.dispose();
    for (const mat of m.mats) mat.dispose();
    playerMarkers.delete(id);
  }

  function clearPlayerMarkers() {
    for (const id of [...playerMarkers.keys()]) removePlayerMarker(id);
  }

  scene.onBeforeRenderObservable.add(() => {
    if (!playerMarkers.size) return;
    const dt = engine.getDeltaTime() / 1000;
    const k = 1 - Math.pow(0.0005, dt); // fast catch-up, no snapping
    const t = performance.now() / 1000;
    for (const m of playerMarkers.values()) {
      m.cur.x += (m.target.x - m.cur.x) * k;
      m.cur.z += (m.target.z - m.cur.z) * k;
      m.cur.cx += (m.target.cx - m.cur.cx) * k;
      m.cur.cz += (m.target.cz - m.cur.cz) * k;
      m.root.position.set(m.cur.x, 1.55 + Math.sin(t * 1.7 + m.phase) * 0.06, m.cur.z);
      m.cursor.position.x = m.cur.cx;
      m.cursor.position.z = m.cur.cz;
    }
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());
  console.log('[scene] world ready');

  /* projects a pointer position onto the floor plane */
  function groundPointAt(x, y) {
    const ray = scene.createPickingRay(x, y, BABYLON.Matrix.Identity(), camera);
    const t = -ray.origin.y / ray.direction.y;
    const p = ray.origin.add(ray.direction.scale(Math.max(0, t)));
    return new BABYLON.Vector3(p.x, 0, p.z);
  }
  function groundPoint() {
    return groundPointAt(scene.pointerX, scene.pointerY);
  }
  /* same, but from client coordinates (HTML drag & drop events) —
     scene.pointerX is offset-CSS pixels, so no scaling here */
  function groundPointFromClient(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return groundPointAt(clientX - r.left, clientY - r.top);
  }

  /* ------------------------------------------------ pedal construction -- */

  function buildPedal(id, spec, state, position) {
    const { width: W, depth: D, height: H } = spec.enclosure;
    const TOP_Y = H + 0.001;
    const layout = computeLayout(spec);
    const root = new BABYLON.TransformNode('pedal_' + id, scene);
    root.position.set(position.x, 0, position.z);

    const isAmp = spec.kind === 'amp';
    const uvToWorld = (u, v) => ({ x: (u - 0.5) * W, z: (0.5 - v) * D });
    const matBody = pbr('body_' + id, spec.enclosure.color || '#8f969c', isAmp ? 0.1 : 0.85, isAmp ? 0.75 : 0.4);

    const isRound = spec.shape === 'round';
    const body = isRound
      ? BABYLON.MeshBuilder.CreateCylinder('body_' + id,
          { diameter: Math.min(W, D), height: H, tessellation: 48 }, scene)
      : BABYLON.MeshBuilder.CreateBox('body_' + id, { width: W, height: H, depth: D }, scene);
    body.parent = root;
    body.position.y = H / 2;
    body.material = matBody;
    body.metadata = { pedal: id, body: true };
    shadows.addShadowCaster(body);

    let faceTex;
    if (spec.artwork.image) {
      faceTex = new BABYLON.Texture(spec.artwork.image, scene, false, true,
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE, null,
        (msg) => console.error('[scene] face texture FAILED', msg));
    } else {
      const TW = 1024, TH = Math.round(1024 * (D / W));
      faceTex = new BABYLON.DynamicTexture('face_' + id, { width: TW, height: TH }, scene, true);
      paintFaceplate(faceTex.getContext(), TW, TH, spec, layout);
      faceTex.update();
    }
    const matTop = new BABYLON.PBRMaterial('top_' + id, scene);
    matTop.albedoTexture = faceTex;
    matTop.emissiveTexture = faceTex;
    matTop.emissiveColor = new BABYLON.Color3(0.25, 0.25, 0.25);
    matTop.metallic = 0.0;
    matTop.roughness = 0.9;
    matTop.specularIntensity = 0.3;
    if (spec.shape === 'round' && faceTex.hasAlpha !== undefined) {
      faceTex.hasAlpha = true; // circular art, transparent corners
      matTop.useAlphaFromAlbedoTexture = true;
      matTop.transparencyMode = BABYLON.PBRMaterial.PBRMATERIAL_ALPHABLEND;
    }
    const topPlate = BABYLON.MeshBuilder.CreateGround('top_' + id, { width: W, height: D }, scene);
    topPlate.parent = root;
    topPlate.position.y = TOP_Y;
    topPlate.material = matTop;
    topPlate.metadata = { pedal: id, body: true };
    glow.addExcludedMesh(topPlate);

    const knobs = {};
    for (const k of layout.knobs) {
      const p = uvToWorld(k.u, k.v);
      const base = new BABYLON.TransformNode('kb', scene);
      base.parent = root;
      base.position.set(p.x, TOP_Y, p.z);
      const bezel = BABYLON.MeshBuilder.CreateCylinder('kbz',
        { diameter: 0.36, height: 0.07, tessellation: 6 }, scene);
      bezel.parent = base;
      bezel.position.y = 0.035;
      bezel.material = matBezel;
      bezel.metadata = { pedal: id, knob: k.id };
      shadows.addShadowCaster(bezel);
      const spin = new BABYLON.TransformNode('ks', scene);
      spin.parent = base;
      spin.rotation.y = valueToAngle(state.values[k.id]);
      const cap = BABYLON.MeshBuilder.CreateCylinder('kc',
        { diameter: 0.26, height: 0.2, tessellation: 32 }, scene);
      cap.parent = spin;
      cap.position.y = 0.1;
      cap.material = matKnob;
      cap.metadata = { pedal: id, knob: k.id };
      shadows.addShadowCaster(cap);
      const line = BABYLON.MeshBuilder.CreateBox('kl',
        { width: 0.03, height: 0.02, depth: 0.1 }, scene);
      line.parent = spin;
      line.position.set(0, 0.2, 0.065);
      line.material = matLine;
      line.metadata = { pedal: id, knob: k.id };
      glow.addExcludedMesh(line);
      knobs[k.id] = { base, spin };
    }

    const toggles = {};
    for (const s of layout.switches) {
      const p = uvToWorld(s.u, s.v);
      const tb = BABYLON.MeshBuilder.CreateCylinder('tb',
        { diameter: 0.14, height: 0.06, tessellation: 12 }, scene);
      tb.parent = root;
      tb.position.set(p.x, TOP_Y + 0.03, p.z);
      tb.material = matBezel;
      tb.metadata = { pedal: id, toggle: s.id };
      const lever = BABYLON.MeshBuilder.CreateBox('tl',
        { width: 0.05, height: 0.18, depth: 0.05 }, scene);
      lever.parent = tb;
      lever.position.y = 0.1;
      lever.material = matButton;
      lever.metadata = { pedal: id, toggle: s.id };
      lever.rotation.x = state.switches[s.id] ? -0.45 : 0.45;
      shadows.addShadowCaster(lever);
      toggles[s.id] = { lever };
    }

    const swPos = uvToWorld(layout.footswitch.u, layout.footswitch.v);
    const swBase = BABYLON.MeshBuilder.CreateCylinder('fsb',
      { diameter: 0.46, height: 0.09, tessellation: 6 }, scene);
    swBase.parent = root;
    swBase.position.set(swPos.x, TOP_Y + 0.045, swPos.z);
    swBase.material = matBezel;
    swBase.metadata = { pedal: id, switch: true };
    shadows.addShadowCaster(swBase);
    const swButton = BABYLON.MeshBuilder.CreateCylinder('fsbtn',
      { diameter: 0.3, height: 0.14, tessellation: 32 }, scene);
    swButton.parent = root;
    swButton.position.set(swPos.x, TOP_Y + 0.14, swPos.z);
    swButton.material = matButton;
    swButton.metadata = { pedal: id, switch: true };
    shadows.addShadowCaster(swButton);

    // selection halo on the floor — never covers the artwork
    const selMat = new BABYLON.StandardMaterial('sel_' + id, scene);
    selMat.emissiveColor = BABYLON.Color3.FromHexString('#3a7bd5');
    selMat.disableLighting = true;
    selMat.alpha = 0.3;
    const selRing = BABYLON.MeshBuilder.CreateGround('selRing_' + id,
      { width: W + 0.6, height: D + 0.6 }, scene);
    selRing.parent = root;
    selRing.position.y = 0.004;
    selRing.material = selMat;
    selRing.isPickable = false;
    selRing.setEnabled(false);
    glow.addExcludedMesh(selRing);

    const ledPos = uvToWorld(layout.led.u, layout.led.v);
    const matLed = new BABYLON.StandardMaterial('led_' + id, scene);
    matLed.diffuseColor = new BABYLON.Color3(0.3, 0.03, 0.03);
    const led = BABYLON.MeshBuilder.CreateSphere('led', { diameter: 0.1 }, scene);
    led.parent = root;
    led.position.set(ledPos.x, TOP_Y + 0.03, ledPos.z);
    led.material = matLed;
    led.isPickable = false;

    if (isAmp) { // speaker grille on the front face
      const grille = BABYLON.MeshBuilder.CreateBox('grille_' + id,
        { width: 0.06, height: H * 0.5, depth: D * 0.88 }, scene);
      grille.parent = root;
      grille.position.set(W / 2 + 0.01, H * 0.27, 0);
      grille.material = matGrille;
      grille.metadata = { pedal: id, body: true };
    }

    /* jacks: INPUT on the right (+x), OUTPUT on the left (-x); amps only IN */
    const jackY = H * (isAmp ? 0.7 : 0.55);
    const jackDefs = {};
    for (const [kind, side] of (isAmp ? [['in', +1]] : [['in', +1], ['out', -1]])) {
      const meta = { jack: { node: id, kind } };
      const sock = BABYLON.MeshBuilder.CreateCylinder('js',
        { diameter: 0.17, height: 0.18 }, scene);
      sock.parent = root;
      sock.rotation.z = Math.PI / 2;
      sock.position.set(side * (W / 2 + 0.05), jackY, 0);
      sock.material = matJack;
      sock.metadata = meta;
      const barrel = BABYLON.MeshBuilder.CreateCylinder('jb',
        { diameter: 0.14, height: 0.24 }, scene);
      barrel.parent = root;
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(side * (W / 2 + 0.24), jackY, 0);
      barrel.material = matJack;
      barrel.metadata = meta;
      jackDefs[kind] = {
        node: id, kind,
        dir: new BABYLON.Vector3(side, 0, 0),
        pos: () => new BABYLON.Vector3(
          root.position.x + side * (W / 2 + 0.34), jackY, root.position.z),
      };
    }

    const handles = {
      spec,
      bounds: { w: W + 0.9, d: D + 0.4 }, // incl. jack stubs, for spawn spacing
      position: () => root.position,
      setPosition(x, z) { root.position.set(x, 0, z); },
      jack: (kind) => jackDefs[kind],
      setKnobValue(cid, value) { knobs[cid].spin.rotation.y = valueToAngle(value); },
      setToggle(sid, on) { toggles[sid].lever.rotation.x = on ? -0.45 : 0.45; },
      setLed(on) {
        matLed.emissiveColor = on
          ? new BABYLON.Color3(1, 0.12, 0.08)
          : new BABYLON.Color3(0.06, 0.01, 0.01);
      },
      pressFootswitch() {
        swButton.position.y = TOP_Y + 0.1;
        setTimeout(() => { swButton.position.y = TOP_Y + 0.14; }, 120);
      },

      setSelected(on) {
        selRing.setEnabled(on);
      },
      screenPos(name) {
        const position = name === 'switch'
          ? swButton.absolutePosition
          : name === 'jack-in' ? jackDefs.in.pos()
          : name === 'jack-out' ? jackDefs.out.pos()
          : knobs[name] ? knobs[name].base.absolutePosition.add(new BABYLON.Vector3(0, 0.15, 0))
          : null;
        if (!position) return null;
        const p = BABYLON.Vector3.Project(position, BABYLON.Matrix.Identity(),
          scene.getTransformMatrix(),
          camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
        const s = engine.getRenderWidth() / canvas.clientWidth;
        return { x: p.x / s, y: p.y / s };
      },
      dispose() {
        // never pass disposeMaterialAndTextures here — the knob/jack/cable
        // materials are SHARED; only this pedal's own resources may die
        root.dispose(false, false);
        matBody.dispose();
        matTop.dispose();
        faceTex.dispose();
        matLed.dispose();
        selMat.dispose();
      },
      root,
    };
    handles.setLed(state.on);
    return handles;
  }

  /* renders a spec off-stage and returns a small 3/4-view snapshot data URL */
  async function snapshotPedal(spec, state) {
    const FAR = 500;
    const W = 160, H = 110;
    const handles = buildPedal('__thumb', spec, state, { x: FAR, z: FAR });
    const cam = new BABYLON.ArcRotateCamera('thumbCam',
      -Math.PI / 2 + 0.55, 0.95, Math.max(3.2, spec.enclosure.width * 1.7),
      new BABYLON.Vector3(FAR, 0.25, FAR), scene);
    const rtt = new BABYLON.RenderTargetTexture('thumbRTT', { width: W, height: H }, scene, false);
    rtt.activeCamera = cam;
    rtt.renderList = handles.root.getChildMeshes();
    rtt.clearColor = new BABYLON.Color4(0.945, 0.945, 0.96, 1);
    scene.customRenderTargets.push(rtt);
    try {
      await new Promise((res) => scene.executeWhenReady(res));
      await new Promise((res) => scene.onAfterRenderObservable.addOnce(res));
      const buf = await rtt.readPixels();
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const img = g.createImageData(W, H);
      const bytes = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let y = 0; y < H; y++) { // GPU rows come bottom-up
        img.data.set(bytes.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
      }
      g.putImageData(img, 0, 0);
      return cv.toDataURL();
    } finally {
      const i = scene.customRenderTargets.indexOf(rtt);
      if (i !== -1) scene.customRenderTargets.splice(i, 1);
      rtt.dispose();
      cam.dispose();
      handles.dispose();
    }
  }

  return {
    engine, scene, camera,
    buildPedal, buildAmp, buildSourcePost,
    groundPoint, groundPointFromClient, snapshotPedal,
    setCable, removeCable,
    setPlayerMarker, movePlayerMarker, removePlayerMarker, clearPlayerMarkers,
  };
}
