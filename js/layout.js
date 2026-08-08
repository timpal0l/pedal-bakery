// ---------------------------------------------------------------------------
// Turns a spec into face-plate positions for every control, in normalized
// (u, v) coordinates (u: 0..1 left -> right, v: 0..1 top -> bottom). Both the
// artwork painter and the 3D builder read this, so paint and meshes always
// agree. Specs may pin controls with explicit u/v (Luke does); otherwise
// knobs flow into centered rows under the title.
//
// Amps are laid out like real heads instead: everything sits on one control
// strip that runs along the face (the v axis — scene.js builds amp cabinets
// with enclosure.width across the front). Viewer order, left to right when
// facing the grille (v high -> low): name, knobs, toggles, pilot LED, power.
// ---------------------------------------------------------------------------

// natural widths of panel items in world units (amps only)
const AMP_W = { knob: 0.62, toggle: 0.4, led: 0.24, power: 0.52, name: 1.05 };

function ampLayout(spec) {
  const face = spec.enclosure.width; // across the front
  const span = 0.86 * face;          // usable strip, centered on the face
  const rowU = 0.66, frontU = 0.72, backU = 0.34;
  const knobs = [];
  const switches = [];
  let led, power, nameV = null, twoRow = false;

  const items = [
    ...spec.controls.map((c) => ({ kind: 'knob', ref: c, w: AMP_W.knob })),
    ...(spec.switches || []).map((s) => ({ kind: 'toggle', ref: s, w: AMP_W.toggle })),
    { kind: 'led', w: AMP_W.led },
    { kind: 'power', w: AMP_W.power },
  ];

  // walk the strip viewer-left -> viewer-right (v high -> low); `lead` is
  // world units reserved before the first item (the painted name zone).
  // Returns the group's viewer-left edge so the caller can center the name.
  const place = (list, u, scale, lead = 0) => {
    const tw = lead + list.reduce((a, i) => a + i.w * scale, 0);
    const edge = 0.5 + tw / face / 2;
    let cursor = edge - lead / face;
    for (const it of list) {
      const wn = (it.w * scale) / face;
      const v = cursor - wn / 2;
      cursor -= wn;
      if (it.kind === 'knob') knobs.push({ ...it.ref, u, v });
      else if (it.kind === 'toggle') switches.push({ ...it.ref, u, v });
      else if (it.kind === 'led') led = { u, v };
      else power = { u, v };
    }
    return edge;
  };

  const total = items.reduce((a, i) => a + i.w, 0);
  if (total + AMP_W.name <= span) {
    const edge = place(items, rowU, 1, AMP_W.name);
    nameV = edge - AMP_W.name / face / 2;
  } else if (total <= span) {
    place(items, rowU, 1);
  } else if (total * 0.74 <= span) {
    place(items, rowU, span / total); // squeeze a little before giving up
  } else {
    // narrow face, busy panel: knobs up front, everything else on a back row
    twoRow = true;
    const front = items.filter((i) => i.kind === 'knob');
    const back = items.filter((i) => i.kind !== 'knob');
    place(front, frontU, Math.min(1, span / front.reduce((a, i) => a + i.w, 0)));
    place(back, backU, Math.min(1, span / back.reduce((a, i) => a + i.w, 0)));
  }

  return {
    knobs, switches,
    footswitch: power,
    led,
    titleV: 0.1, // unused by the amp painter; kept for shape parity
    amp: { nameV, rowU: twoRow ? frontU : rowU, backU, twoRow },
  };
}

export function computeLayout(spec) {
  if (spec.kind === 'amp') return ampLayout(spec);
  const { width } = spec.enclosure;
  const knobs = [];
  const explicit = spec.controls.every((c) => c.u != null && c.v != null);

  if (explicit) {
    for (const c of spec.controls) knobs.push({ ...c });
  } else {
    const { depth } = spec.enclosure;
    const n = spec.controls.length;
    const du = 0.55 / width;                                  // knob pitch in u
    const perRow = spec.shape === 'round'
      ? 2 // stay inside the circle
      : Math.max(1, Math.min(4, Math.floor(0.84 / du) + 1));
    const rows = Math.ceil(n / perRow);
    // rows are spaced in world units so deep and shallow boxes both work
    const rowV = rows === 1 ? [0.34] : [0.26, 0.26 + 0.52 / depth];
    let i = 0;
    for (let r = 0; r < rows; r++) {
      const count = Math.ceil((n - i) / (rows - r));
      for (let j = 0; j < count; j++, i++) {
        knobs.push({
          ...spec.controls[i],
          u: 0.5 + (j - (count - 1) / 2) * du,
          v: rowV[Math.min(r, rowV.length - 1)],
        });
      }
    }
  }

  // toggles flank the footswitch, pushed out far enough to clear it on minis
  const footswitch = spec.footswitch || { u: 0.5, v: 0.8 };
  const uOut = Math.max(0.25, 0.36 / width);
  const switches = (spec.switches || []).map((s, j) => ({
    ...s,
    u: s.u ?? (j % 2 === 0 ? 0.5 - uOut : 0.5 + uOut),
    v: s.v ?? footswitch.v - 0.02,
  }));

  return {
    knobs,
    switches,
    footswitch,
    led: spec.led || { u: 0.5, v: footswitch.v - 0.34 / spec.enclosure.depth },
    titleV: 0.1,
  };
}
