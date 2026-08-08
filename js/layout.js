// ---------------------------------------------------------------------------
// Turns a spec into face-plate positions for every control, in normalized
// (u, v) coordinates (u: 0..1 left -> right, v: 0..1 top -> bottom). Both the
// artwork painter and the 3D builder read this, so paint and meshes always
// agree. Specs may pin controls with explicit u/v (Luke does); otherwise
// knobs flow into centered rows under the title.
// ---------------------------------------------------------------------------

export function computeLayout(spec) {
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
