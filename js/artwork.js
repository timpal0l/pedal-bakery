// ---------------------------------------------------------------------------
// Procedural face-plate art. Paints a spec's artwork block onto a canvas 2D
// context (a Babylon DynamicTexture) — background style, border, title, and
// tick rings + labels exactly where layout.js placed the controls.
//
// Amps get three extra painters: paintTolex (cabinet vinyl), paintGrille
// (speaker cloth + logo, mapped onto the front baffle), and paintAmpTop
// (tolex top with a control-panel plate). Amp-top text is drawn rotated -90°
// so it reads correctly when you stand in front of the grille (+x in 3D).
// ---------------------------------------------------------------------------

export function paintFaceplate(c2d, W, H, spec, layout) {
  const art = spec.artwork;
  const [c0, c1, c2] = art.palette;
  const text = art.textColor || '#ffffff';
  const round = spec.shape === 'round';

  if (round) { // transparent corners -> the plate reads as a circle
    c2d.clearRect(0, 0, W, H);
    c2d.save();
    c2d.beginPath();
    c2d.ellipse(W / 2, H / 2, W / 2 - 2, H / 2 - 2, 0, 0, Math.PI * 2);
    c2d.clip();
  }

  /* background */
  c2d.fillStyle = c1;
  c2d.fillRect(0, 0, W, H);
  if (art.style === 'gradient') {
    const g = c2d.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    c2d.fillStyle = g;
    c2d.fillRect(0, 0, W, H);
    c2d.fillStyle = withAlpha(c2, 0.25);
    for (let i = 0; i < 40; i++) {
      c2d.fillRect(Math.random() * W, Math.random() * H, W * 0.004, W * 0.004);
    }
  } else if (art.style === 'burst') {
    const cx = W / 2, cy = H * 0.55, rays = 28;
    for (let i = 0; i < rays; i++) {
      c2d.fillStyle = i % 2 ? c0 : c1;
      const a0 = (i / rays) * Math.PI * 2, a1 = ((i + 1) / rays) * Math.PI * 2;
      c2d.beginPath();
      c2d.moveTo(cx, cy);
      c2d.arc(cx, cy, W * 1.2, a0, a1);
      c2d.fill();
    }
    const halo = c2d.createRadialGradient(cx, cy, 0, cx, cy, W * 0.5);
    halo.addColorStop(0, withAlpha(c2, 0.55)); halo.addColorStop(1, withAlpha(c2, 0));
    c2d.fillStyle = halo;
    c2d.fillRect(0, 0, W, H);
  } else if (art.style === 'stripes') {
    c2d.save();
    c2d.rotate(-0.35);
    const step = W * 0.07;
    for (let x = -W; x < W * 1.6; x += step * 2) {
      c2d.fillStyle = c0;
      c2d.fillRect(x, -H, step, H * 3);
    }
    c2d.restore();
    c2d.fillStyle = withAlpha(c2, 0.15);
    c2d.fillRect(0, 0, W, H);
  } else if (art.style === 'waves') {
    for (let row = 0; row < 14; row++) {
      c2d.strokeStyle = withAlpha(row % 2 ? c0 : c2, 0.55);
      c2d.lineWidth = W * 0.012;
      c2d.beginPath();
      const y0 = (row / 13) * H;
      for (let x = 0; x <= W; x += W / 60) {
        const y = y0 + Math.sin((x / W) * Math.PI * 4 + row * 0.9) * H * 0.03;
        x === 0 ? c2d.moveTo(x, y) : c2d.lineTo(x, y);
      }
      c2d.stroke();
    }
  } else if (art.style === 'checker') {
    const s = W / 12;
    for (let y = 0; y < H / s + 1; y++) {
      for (let x = 0; x < 12; x++) {
        if ((x + y) % 2) continue;
        c2d.fillStyle = withAlpha((x * 7 + y * 3) % 5 ? c0 : c2, 0.85);
        c2d.fillRect(x * s, y * s, s, s);
      }
    }
  } else if (art.style === 'diagonal') {
    c2d.fillStyle = c0;
    c2d.beginPath();
    c2d.moveTo(0, 0); c2d.lineTo(W, 0); c2d.lineTo(0, H);
    c2d.closePath(); c2d.fill();
    c2d.fillStyle = withAlpha(c2, 0.5);
    c2d.fillRect(0, 0, W, H * 0.06);
  } else if (art.style === 'rings') {
    for (let r = 14; r > 0; r--) {
      c2d.fillStyle = r % 2 ? c0 : c1;
      c2d.beginPath();
      c2d.ellipse(W / 2, H / 2, (W * r) / 16, (W * r) / 16, 0, 0, Math.PI * 2);
      c2d.fill();
    }
  } else if (art.style === 'flake') { // metal-flake sparkle
    const g = c2d.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    c2d.fillStyle = g;
    c2d.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) {
      c2d.fillStyle = withAlpha(i % 4 ? '#ffffff' : c2, 0.25 + Math.random() * 0.5);
      c2d.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
  } else if (art.style === 'plaid') {
    const step = W / 9;
    for (let x = 0; x < 9; x++) {
      c2d.fillStyle = withAlpha(c0, x % 2 ? 0.5 : 0.9);
      c2d.fillRect(x * step, 0, step * 0.55, H);
    }
    for (let y = 0; y < H / step + 1; y++) {
      c2d.fillStyle = withAlpha(c2, y % 2 ? 0.35 : 0.6);
      c2d.fillRect(0, y * step, W, step * 0.55);
    }
  } else { // 'dots'
    for (let i = 0; i < 70; i++) {
      c2d.fillStyle = withAlpha(i % 3 ? c0 : c2, 0.5 + Math.random() * 0.4);
      c2d.beginPath();
      c2d.arc(Math.random() * W, Math.random() * H, W * (0.004 + Math.random() * 0.02), 0, Math.PI * 2);
      c2d.fill();
    }
  }

  /* border */
  c2d.strokeStyle = withAlpha(text, 0.65);
  c2d.lineWidth = W * 0.008;
  if (round) {
    c2d.beginPath();
    c2d.ellipse(W / 2, H / 2, W / 2 - W * 0.025, H / 2 - W * 0.025, 0, 0, Math.PI * 2);
    c2d.stroke();
  } else {
    c2d.strokeRect(W * 0.02, W * 0.02, W - W * 0.04, H - W * 0.04);
  }

  /* title + tagline */
  c2d.textAlign = 'center';
  c2d.textBaseline = 'middle';
  c2d.fillStyle = text;
  c2d.shadowColor = 'rgba(0,0,0,0.45)';
  c2d.shadowBlur = W * 0.012;
  c2d.font = `900 ${Math.floor(W * 0.062)}px Futura, 'Arial Black', Arial, sans-serif`;
  c2d.fillText(spec.name.toUpperCase(), W / 2, H * layout.titleV, W * (round ? 0.55 : 0.9));
  c2d.shadowBlur = 0;
  c2d.font = `600 ${Math.floor(W * 0.024)}px Futura, Arial, sans-serif`;
  c2d.fillStyle = withAlpha(text, 0.8);
  c2d.fillText(spec.tagline || '', W / 2, H * layout.titleV + W * 0.048, W * 0.9);

  /* knob tick rings + labels */
  const knobR = (0.18 / spec.enclosure.width) * W; // matches the 3D knob size
  for (const k of layout.knobs) {
    const cx = k.u * W, cy = k.v * H;
    c2d.strokeStyle = withAlpha(text, 0.9);
    c2d.lineWidth = W * 0.004;
    for (let i = 0; i <= 10; i++) {
      const a = (-135 + i * 27) * (Math.PI / 180);
      const r0 = knobR * 1.18, r1 = knobR * (i % 5 === 0 ? 1.42 : 1.32);
      c2d.beginPath();
      c2d.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
      c2d.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
      c2d.stroke();
    }
    c2d.fillStyle = text;
    c2d.font = `800 ${Math.floor(W * 0.03)}px Futura, Arial, sans-serif`;
    c2d.fillText(k.label, cx, cy + knobR * 1.75);
  }

  /* switch + footswitch labels */
  c2d.font = `700 ${Math.floor(W * 0.022)}px Futura, Arial, sans-serif`;
  for (const s of layout.switches) {
    c2d.fillText(s.label, s.u * W, s.v * H + W * 0.055);
  }
  c2d.fillText('ON / OFF', layout.footswitch.u * W,
    layout.footswitch.v * H + (0.23 / spec.enclosure.width) * W * 1.6);
  if (round) c2d.restore();
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* lighten (f > 0) or darken (f < 0) a #rrggbb color, f in [-1, 1] */
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c) => Math.max(0, Math.min(255,
    Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f))));
  return '#' + ((ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255))
    .toString(16).padStart(6, '0');
}

/* fine speckle shared by several tolex styles */
function grain(c2d, W, H, dark, light, n) {
  for (let i = 0; i < n; i++) {
    c2d.fillStyle = withAlpha(i % 2 ? dark : light, 0.06 + Math.random() * 0.14);
    const d = 1 + Math.random() * 2.5;
    c2d.fillRect(Math.random() * W, Math.random() * H, d, d);
  }
}

/* ------------------------------------------------------------------ amps -- */

/* cabinet vinyl — covers the cab body and the amp top */
export function paintTolex(c2d, W, H, hex, style) {
  const base = hex || '#232326';
  c2d.fillStyle = base;
  c2d.fillRect(0, 0, W, H);
  const dark = shade(base, -0.3), darker = shade(base, -0.55), light = shade(base, 0.16);

  if (style === 'tweed') { // diagonal twill weave
    c2d.save();
    c2d.translate(W / 2, H / 2);
    c2d.rotate(-Math.PI / 4);
    const st = W * 0.03;
    for (let x = -W; x < W; x += st * 2) {
      c2d.fillStyle = withAlpha(light, 0.7);
      c2d.fillRect(x, -H * 1.5, st * 1.15, H * 3);
      c2d.fillStyle = withAlpha(dark, 0.3);
      c2d.fillRect(x + st * 1.35, -H * 1.5, st * 0.4, H * 3);
    }
    c2d.restore();
    c2d.fillStyle = withAlpha(dark, 0.12); // cross-thread flecks
    for (let i = 0; i < 500; i++) {
      c2d.fillRect(Math.random() * W, Math.random() * H, W * 0.008, W * 0.003);
    }
  } else if (style === 'western') { // hand-tooled diamond lattice
    grain(c2d, W, H, dark, light, 900);
    c2d.strokeStyle = withAlpha(darker, 0.5);
    c2d.lineWidth = W * 0.006;
    c2d.setLineDash([W * 0.014, W * 0.01]);
    const st = W * 0.16;
    c2d.save();
    c2d.translate(W / 2, H / 2);
    c2d.rotate(Math.PI / 4);
    for (let x = -W; x < W; x += st) {
      c2d.beginPath(); c2d.moveTo(x, -H * 1.5); c2d.lineTo(x, H * 1.5); c2d.stroke();
    }
    for (let y = -H * 1.5; y < H * 1.5; y += st) {
      c2d.beginPath(); c2d.moveTo(-W, y); c2d.lineTo(W, y); c2d.stroke();
    }
    c2d.restore();
    c2d.setLineDash([]);
  } else if (style === 'sparkle') {
    grain(c2d, W, H, dark, light, 300);
    for (let i = 0; i < 850; i++) {
      c2d.fillStyle = withAlpha(i % 3 ? '#ffffff' : light, 0.25 + Math.random() * 0.55);
      const d = 1 + Math.random() * 2;
      c2d.fillRect(Math.random() * W, Math.random() * H, d, d);
    }
  } else if (style === 'smooth') {
    const g = c2d.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, withAlpha(light, 0.25));
    g.addColorStop(0.5, 'rgba(0,0,0,0)');
    g.addColorStop(1, withAlpha(dark, 0.25));
    c2d.fillStyle = g;
    c2d.fillRect(0, 0, W, H);
    grain(c2d, W, H, dark, light, 260);
  } else { // 'levant' — pebbled vinyl
    grain(c2d, W, H, dark, light, 2400);
    for (let i = 0; i < 26; i++) { // broad soft blotches so it isn't flat noise
      const x = Math.random() * W, y = Math.random() * H;
      const r = W * (0.04 + Math.random() * 0.1);
      const gg = c2d.createRadialGradient(x, y, 0, x, y, r);
      gg.addColorStop(0, withAlpha(i % 2 ? dark : light, 0.07));
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      c2d.fillStyle = gg;
      c2d.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
}

/* logo lettering shared by the grille and the amp panel; expects the context
   translated to the logo center with textAlign/baseline = center/middle */
function drawLogoText(c2d, name, style, px, maxW, trim, text) {
  const label = style === 'script' ? name : name.toUpperCase();
  if (style === 'badge') {
    c2d.font = `900 ${Math.round(px * 0.92)}px Futura, 'Arial Black', Arial, sans-serif`;
    const w = Math.min(maxW, c2d.measureText(label).width) + px * 0.9;
    c2d.fillStyle = trim;
    c2d.beginPath();
    c2d.roundRect(-w / 2, -px * 0.72, w, px * 1.44, px * 0.5);
    c2d.fill();
    c2d.fillStyle = '#17130c';
    c2d.fillText(label, 0, px * 0.02, maxW);
  } else if (style === 'script') {
    c2d.font = `italic 700 ${Math.round(px * 1.15)}px Georgia, 'Times New Roman', serif`;
    c2d.fillStyle = 'rgba(0,0,0,0.4)';
    c2d.fillText(label, px * 0.05, px * 0.06, maxW);
    c2d.fillStyle = text;
    c2d.fillText(label, 0, 0, maxW);
  } else { // 'block'
    c2d.font = `900 ${Math.round(px)}px Futura, 'Arial Black', Arial, sans-serif`;
    c2d.fillStyle = 'rgba(0,0,0,0.4)';
    c2d.fillText(label, px * 0.04, px * 0.05, maxW);
    c2d.fillStyle = text;
    c2d.fillText(label, 0, 0, maxW);
  }
}

/* speaker cloth for the front baffle — pattern, speaker shadows, logo */
export function paintGrille(c2d, W, H, cab, name) {
  const g = (cab && cab.grille) || {};
  const base = g.color || '#3a332b';
  const acc = g.accent || shade(base, 0.3);
  const dark = shade(base, -0.45), light = shade(base, 0.22);
  c2d.fillStyle = base;
  c2d.fillRect(0, 0, W, H);

  const style = g.style || 'weave';
  if (style === 'weave') { // basketweave blocks over a thread grid
    const s = W / 30;
    const cols = Math.ceil(W / s), rows = Math.ceil(H / s);
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= cols; x++) {
        const horiz = (x + y) % 2 === 0;
        c2d.fillStyle = withAlpha(horiz ? light : acc, 0.5);
        if (horiz) c2d.fillRect(x * s + s * 0.05, y * s + s * 0.16, s * 0.9, s * 0.68);
        else c2d.fillRect(x * s + s * 0.16, y * s + s * 0.05, s * 0.68, s * 0.9);
      }
    }
    c2d.strokeStyle = withAlpha(dark, 0.45);
    c2d.lineWidth = s * 0.09;
    for (let x = 0; x <= cols; x++) {
      c2d.beginPath(); c2d.moveTo(x * s, 0); c2d.lineTo(x * s, H); c2d.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      c2d.beginPath(); c2d.moveTo(0, y * s); c2d.lineTo(W, y * s); c2d.stroke();
    }
  } else if (style === 'diagonal' || style === 'tweed') {
    const tight = style === 'tweed';
    c2d.save();
    c2d.translate(W / 2, H / 2);
    c2d.rotate(tight ? -Math.PI / 4 : -0.62);
    const st = W * (tight ? 0.011 : 0.016);
    for (let x = -W * 1.4; x < W * 1.4; x += st * 2) {
      c2d.fillStyle = withAlpha(tight ? light : acc, tight ? 0.55 : 0.5);
      c2d.fillRect(x, -H * 2, st, H * 4);
      c2d.fillStyle = withAlpha(dark, 0.35);
      c2d.fillRect(x + st, -H * 2, st * 0.5, H * 4);
    }
    c2d.restore();
  } else if (style === 'salt') {
    const cols = [light, dark, acc];
    for (let i = 0; i < 3200; i++) {
      c2d.fillStyle = withAlpha(cols[i % 3], 0.25 + Math.random() * 0.4);
      c2d.fillRect(Math.random() * W, Math.random() * H,
        2 + Math.random() * 2, 2 + Math.random() * 2);
    }
  } else if (style === 'oxblood') { // dark verticals + a fine bright pinstripe
    const st = W * 0.02;
    for (let x = 0; x < W; x += st * 2) {
      c2d.fillStyle = withAlpha(dark, 0.5);
      c2d.fillRect(x, 0, st, H);
    }
    c2d.save();
    c2d.translate(W / 2, H / 2);
    c2d.rotate(-Math.PI / 4);
    c2d.fillStyle = withAlpha(acc, 0.55);
    for (let x = -W * 1.4; x < W * 1.4; x += st * 6) {
      c2d.fillRect(x, -H * 2, st * 0.35, H * 4);
    }
    c2d.restore();
  } else if (style === 'metal') { // perforated steel
    const st = W / 42;
    c2d.fillStyle = 'rgba(8,8,10,0.85)';
    for (let r = 0; r * st * 0.87 < H + st; r++) {
      const y = r * st * 0.87, off = r % 2 ? st / 2 : 0;
      for (let x = off; x < W + st; x += st) {
        c2d.beginPath();
        c2d.arc(x, y, st * 0.3, 0, Math.PI * 2);
        c2d.fill();
      }
    }
  } else { // 'stripes'
    const st = W / 9;
    for (let x = 0; x < 9; x += 2) {
      c2d.fillStyle = withAlpha(acc, 0.55);
      c2d.fillRect(x * st, 0, st, H);
    }
    c2d.fillStyle = withAlpha(dark, 0.5);
    for (let x = 0; x <= 9; x++) c2d.fillRect(x * st - st * 0.03, 0, st * 0.06, H);
  }

  /* speakers pressing through the cloth */
  const n = cab && cab.speakers === 4 ? 4 : cab && cab.speakers === 2 ? 2 : 1;
  const spots = n === 1 ? [[0.5, 0.5]]
    : n === 2 ? [[0.27, 0.5], [0.73, 0.5]]
    : [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]];
  const rr = n === 1 ? Math.min(W, H) * 0.4
    : n === 2 ? Math.min(W / 2, H) * 0.4
    : Math.min(W / 2, H / 2) * 0.4;
  for (const [fx, fy] of spots) {
    const cx = fx * W, cy = fy * H;
    const sh = c2d.createRadialGradient(cx, cy, rr * 0.1, cx, cy, rr);
    sh.addColorStop(0, 'rgba(0,0,0,0.40)');
    sh.addColorStop(0.8, 'rgba(0,0,0,0.26)');
    sh.addColorStop(0.92, 'rgba(0,0,0,0.06)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    c2d.fillStyle = sh;
    c2d.beginPath(); c2d.arc(cx, cy, rr, 0, Math.PI * 2); c2d.fill();
    c2d.strokeStyle = 'rgba(0,0,0,0.5)';
    c2d.lineWidth = rr * 0.055;
    c2d.beginPath(); c2d.arc(cx, cy, rr * 0.94, 0, Math.PI * 2); c2d.stroke();
    c2d.strokeStyle = 'rgba(255,255,255,0.09)';
    c2d.lineWidth = rr * 0.04;
    c2d.beginPath(); c2d.arc(cx, cy, rr * 0.78, 0, Math.PI * 2); c2d.stroke();
    const cap = c2d.createRadialGradient(cx - rr * 0.08, cy - rr * 0.08, 0, cx, cy, rr * 0.3);
    cap.addColorStop(0, 'rgba(255,255,255,0.10)');
    cap.addColorStop(1, 'rgba(0,0,0,0.30)');
    c2d.fillStyle = cap;
    c2d.beginPath(); c2d.arc(cx, cy, rr * 0.3, 0, Math.PI * 2); c2d.fill();
  }

  /* maker's logo, top-left like the classics */
  if ((cab && cab.logo) !== 'none' && name) {
    c2d.save();
    c2d.translate(W * 0.16, H * 0.15);
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    drawLogoText(c2d, name, (cab && cab.logo) || 'block',
      Math.min(W * 0.062, H * 0.16), W * 0.27, (cab && cab.trim) || '#d8cfa8', '#efe8da');
    c2d.restore();
  }

  const sheen = c2d.createLinearGradient(0, 0, 0, H);
  sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
  sheen.addColorStop(0.3, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.14)');
  c2d.fillStyle = sheen;
  c2d.fillRect(0, 0, W, H);
}

/* the amp's top: tolex, piping, and a control panel plate along the face */
export function paintAmpTop(c2d, W, H, spec, layout) {
  const cab = spec.cabinet || {};
  const face = spec.enclosure.width;  // world units across the face (v axis)
  const s = H / face;                 // px per world unit (uniform on both axes)
  const text = (spec.artwork && spec.artwork.textColor) || '#f2ead8';
  const trim = cab.trim || '#c8b37e';
  const a = layout.amp;

  paintTolex(c2d, W, H, spec.enclosure.color || '#232326', cab.tolex || 'levant');

  /* piping around the top edge */
  c2d.strokeStyle = withAlpha(trim, 0.75);
  c2d.lineWidth = Math.max(2, 0.03 * s);
  c2d.strokeRect(0.05 * s, 0.05 * s, W - 0.1 * s, H - 0.1 * s);

  /* the control panel plate — layout.js sized it around the real rows */
  const x0 = a.plateU0 * W;
  const x1 = a.plateU1 * W;
  const y0 = 0.04 * H, y1 = 0.96 * H;
  const plate = () => {
    c2d.beginPath();
    c2d.roundRect(x0, y0, x1 - x0, y1 - y0, 0.07 * s);
  };
  plate();
  c2d.fillStyle = cab.panel || '#141416';
  c2d.fill();
  const sheen = c2d.createLinearGradient(x0, 0, x1, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.16)');
  plate();
  c2d.fillStyle = sheen;
  c2d.fill();
  plate();
  c2d.strokeStyle = withAlpha(trim, 0.55);
  c2d.lineWidth = Math.max(1.5, 0.014 * s);
  c2d.stroke();

  /* labels read from the grille side: rotate -90° around each anchor */
  const rot = (u, v, draw) => {
    c2d.save();
    c2d.translate(u * W, v * H);
    c2d.rotate(-Math.PI / 2);
    draw();
    c2d.restore();
  };
  c2d.textAlign = 'center';
  c2d.textBaseline = 'middle';

  if (a.nameV != null) {
    rot(a.rowU, a.nameV, () => {
      drawLogoText(c2d, spec.name, cab.logo || 'block', 0.28 * s, 0.95 * s, trim, text);
    });
  }

  // Lettering sits at the distance layout.js reserved room for, so it always
  // lands on the plate. A cabinet too shallow to letter honestly (labelD 0)
  // wears none — the inspector still names every knob. On a two-row panel only
  // the knobs are lettered: the back row's silkscreen would print under them.
  const knobR = 0.19 * s;
  c2d.strokeStyle = withAlpha(text, 0.9);
  c2d.lineWidth = Math.max(1.5, 0.013 * s);
  c2d.fillStyle = text;
  c2d.font = `800 ${Math.round(0.12 * s)}px Futura, Arial, sans-serif`;
  for (const k of layout.knobs) {
    rot(k.u, k.v, () => {
      for (let i = 0; i <= 10; i++) {
        const ang = (-135 + i * 27) * (Math.PI / 180);
        const r0 = knobR * 1.16, r1 = knobR * (i % 5 === 0 ? 1.45 : 1.32);
        c2d.beginPath();
        c2d.moveTo(Math.sin(ang) * r0, -Math.cos(ang) * r0);
        c2d.lineTo(Math.sin(ang) * r1, -Math.cos(ang) * r1);
        c2d.stroke();
      }
      if (a.labelD) c2d.fillText(k.label, 0, a.labelD * s, 0.44 * s);
    });
  }

  if (!a.twoRow && a.labelD) {
    c2d.font = `700 ${Math.round(0.115 * s)}px Futura, Arial, sans-serif`;
    for (const t of layout.switches) {
      rot(t.u, t.v, () => c2d.fillText(t.label, 0, a.labelD * s, 0.38 * s));
    }
    rot(layout.footswitch.u, layout.footswitch.v,
      () => c2d.fillText('POWER', 0, a.labelD * s, 0.38 * s));
  }

  if (layout.led) { // pilot-light bezel ring
    c2d.strokeStyle = withAlpha(trim, 0.9);
    c2d.lineWidth = Math.max(1.5, 0.02 * s);
    c2d.beginPath();
    c2d.arc(layout.led.u * W, layout.led.v * H, 0.085 * s, 0, Math.PI * 2);
    c2d.stroke();
  }
}
