// ---------------------------------------------------------------------------
// Procedural face-plate art. Paints a spec's artwork block onto a canvas 2D
// context (a Babylon DynamicTexture) — background style, border, title, and
// tick rings + labels exactly where layout.js placed the controls.
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
