// ---------------------------------------------------------------------------
// The effect module library — the building blocks pedals are baked from.
//
// Every module exposes:  { in, out, set(param, v), dispose() }
// Every param takes 0..10 (knob space); the module owns the curve to real
// units. The bakery LLM only ever combines these — it never writes DSP.
// ---------------------------------------------------------------------------

function shell(ctx, input, out, setters, oscs = []) {
  return {
    in: input,
    out,
    set(param, v) {
      const fn = setters[param];
      if (fn) fn(Math.min(10, Math.max(0, Number(v) || 0)), ctx.currentTime);
    },
    dispose() {
      for (const o of oscs) { try { o.stop(); } catch { /* already stopped */ } }
      for (const n of [input, out, ...Object.values(setters._nodes || {})]) {
        try { n.disconnect(); } catch { /* fine */ }
      }
    },
  };
}

/* drive — waveshaper fuzz/overdrive with tone and level */
function createDrive(ctx) {
  const input = ctx.createGain();
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper(); shaper.oversample = '2x';
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
  const out = ctx.createGain();
  input.connect(pre).connect(shaper).connect(tone).connect(out);
  const setters = {
    _nodes: { pre, shaper, tone },
    amount: (v, t) => {
      const k = 1 + Math.pow(v / 10, 2) * 150;
      const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      shaper.curve = curve;
      pre.gain.setTargetAtTime(0.6 + Math.pow(v / 10, 1.5) * 18, t, 0.05);
      out.gain.setTargetAtTime(levelGain / (1 + (v / 10) * 2.2), t, 0.05);
      lastAmount = v;
    },
    tone: (v, t) => tone.frequency.setTargetAtTime(400 * Math.pow(2, (v / 10) * 4.6), t, 0.05),
    level: (v) => { levelGain = Math.pow(v / 10, 1.5) * 2; setters.amount(lastAmount, ctx.currentTime); },
  };
  let levelGain = 1, lastAmount = 5;
  setters.amount(5, ctx.currentTime);
  setters.tone(5, ctx.currentTime);
  return shell(ctx, input, out, setters);
}

/* delay — feedback echo, dry always full */
function createDelay(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const d = ctx.createDelay(2.0);
  const fb = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(out);
  input.connect(d);
  d.connect(fb).connect(d);
  d.connect(wet).connect(out);
  d.delayTime.value = 0.3; fb.gain.value = 0.35; wet.gain.value = 0.5;
  const setters = {
    _nodes: { d, fb, wet },
    time: (v, t) => d.delayTime.setTargetAtTime(0.06 * Math.pow(20, v / 10), t, 0.1),
    feedback: (v, t) => fb.gain.setTargetAtTime((v / 10) * 0.95, t, 0.05),
    mix: (v, t) => wet.gain.setTargetAtTime(v / 10, t, 0.05),
  };
  return shell(ctx, input, out, setters);
}

/* chorus — the classic from Luke the Puke: two panned LFO-swept delays */
function createChorus(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const delayL = ctx.createDelay(0.06); delayL.delayTime.value = 0.012;
  const delayR = ctx.createDelay(0.06); delayR.delayTime.value = 0.018;
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  const depthL = ctx.createGain();
  const depthR = ctx.createGain();
  input.connect(dry).connect(out);
  input.connect(delayL);
  input.connect(delayR);
  lfo.connect(depthL).connect(delayL.delayTime);
  lfo.connect(depthR).connect(delayR.delayTime);
  delayL.connect(new StereoPannerNode(ctx, { pan: -0.6 })).connect(wet);
  delayR.connect(new StereoPannerNode(ctx, { pan: 0.6 })).connect(wet);
  wet.connect(out);
  lfo.start();
  const setters = {
    _nodes: { dry, wet, delayL, delayR, depthL, depthR },
    rate: (v, t) => lfo.frequency.setTargetAtTime(0.1 + Math.pow(v / 10, 1.6) * 5.9, t, 0.05),
    depth: (v, t) => {
      const s = (v / 10) * 0.008;
      depthL.gain.setTargetAtTime(s, t, 0.05);
      depthR.gain.setTargetAtTime(-s, t, 0.05);
    },
    mix: (v, t) => {
      const m = (v / 10) * (Math.PI / 2);
      dry.gain.setTargetAtTime(Math.cos(m), t, 0.05);
      wet.gain.setTargetAtTime(Math.sin(m), t, 0.05);
    },
  };
  setters.rate(5, 0); setters.depth(5, 0); setters.mix(5, 0);
  return shell(ctx, input, out, setters, [lfo]);
}

/* tremolo — STEREO: two opposite-phase LFO'd channels panned hard apart,
   so at full depth the sound sweeps ear to ear */
function createTremolo(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain(); out.gain.value = 0.65; // two paths sum
  const vcaL = ctx.createGain();
  const vcaR = ctx.createGain();
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  const depthL = ctx.createGain();
  const depthR = ctx.createGain(); // inverted -> opposite phase = ping-pong
  const panL = new StereoPannerNode(ctx, { pan: -0.85 });
  const panR = new StereoPannerNode(ctx, { pan: 0.85 });
  input.connect(vcaL).connect(panL).connect(out);
  input.connect(vcaR).connect(panR).connect(out);
  lfo.connect(depthL).connect(vcaL.gain);
  lfo.connect(depthR).connect(vcaR.gain);
  lfo.start();
  const setters = {
    _nodes: { vcaL, vcaR, depthL, depthR, panL, panR },
    rate: (v, t) => lfo.frequency.setTargetAtTime(0.5 + Math.pow(v / 10, 1.5) * 11.5, t, 0.05),
    depth: (v, t) => {
      const d = v / 10;
      vcaL.gain.setTargetAtTime(1 - d / 2, t, 0.05);
      vcaR.gain.setTargetAtTime(1 - d / 2, t, 0.05);
      depthL.gain.setTargetAtTime(d / 2, t, 0.05);
      depthR.gain.setTargetAtTime(-d / 2, t, 0.05);
    },
  };
  setters.rate(5, 0); setters.depth(5, 0);
  return shell(ctx, input, out, setters, [lfo]);
}

/* filter — resonant lowpass (dark ... open) */
function createFilter(ctx) {
  const f = ctx.createBiquadFilter(); f.type = 'lowpass';
  const setters = {
    cutoff: (v, t) => f.frequency.setTargetAtTime(110 * Math.pow(2, (v / 10) * 6.2), t, 0.05),
    resonance: (v, t) => f.Q.setTargetAtTime(0.3 + (v / 10) * 9.7, t, 0.05),
  };
  setters.cutoff(7, 0); setters.resonance(2, 0);
  return shell(ctx, f, f, setters);
}

/* phaser — 4 swept allpass stages with feedback */
function createPhaser(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 0.5;
  const wet = ctx.createGain(); wet.gain.value = 0.5;
  const fb = ctx.createGain();
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  const lfoG = ctx.createGain();
  const stages = [300, 700, 1400, 2600].map((base) => {
    const ap = ctx.createBiquadFilter();
    ap.type = 'allpass'; ap.frequency.value = base; ap.Q.value = 0.6;
    lfoG.connect(ap.frequency);
    return ap;
  });
  input.connect(dry).connect(out);
  input.connect(stages[0]);
  stages[0].connect(stages[1]).connect(stages[2]).connect(stages[3]);
  stages[3].connect(wet).connect(out);
  stages[3].connect(fb).connect(stages[0]);
  lfo.connect(lfoG);
  lfo.start();
  const setters = {
    _nodes: { dry, wet, fb, lfoG, ...stages },
    rate: (v, t) => lfo.frequency.setTargetAtTime(0.1 + Math.pow(v / 10, 1.6) * 7.9, t, 0.05),
    depth: (v, t) => lfoG.gain.setTargetAtTime((v / 10) * 1400, t, 0.05),
    feedback: (v, t) => fb.gain.setTargetAtTime((v / 10) * 0.85, t, 0.05),
  };
  setters.rate(4, 0); setters.depth(5, 0); setters.feedback(3, 0);
  return shell(ctx, input, out, setters, [lfo]);
}

/* reverb — convolver with a generated exponential-decay impulse response */
function createReverb(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const conv = ctx.createConvolver();
  const wet = ctx.createGain(); wet.gain.value = 0.35;
  input.connect(out);
  input.connect(conv);
  conv.connect(wet).connect(out);
  function buildIR(v) {
    const len = 0.4 + Math.pow(v / 10, 2) * 4.6;
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(2, Math.floor(sr * len), sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp((-3 * i) / (sr * len));
      }
    }
    conv.buffer = buf;
  }
  buildIR(5);
  const setters = {
    _nodes: { conv, wet },
    size: (v) => buildIR(v),
    mix: (v, t) => wet.gain.setTargetAtTime(v / 10, t, 0.05),
  };
  return shell(ctx, input, out, setters);
}

/* ring — ring modulator: multiplies the signal with a carrier oscillator */
function createRing(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const vca = ctx.createGain(); vca.gain.value = 0; // carrier drives it -> product
  const carrier = ctx.createOscillator(); carrier.type = 'sine';
  input.connect(dry).connect(out);
  input.connect(vca);
  carrier.connect(vca.gain);
  vca.connect(wet).connect(out);
  carrier.start();
  const setters = {
    _nodes: { dry, wet, vca },
    freq: (v, t) => carrier.frequency.setTargetAtTime(30 * Math.pow(2, (v / 10) * 6.1), t, 0.05),
    mix: (v, t) => {
      const m = (v / 10) * (Math.PI / 2);
      dry.gain.setTargetAtTime(Math.cos(m), t, 0.05);
      wet.gain.setTargetAtTime(Math.sin(m), t, 0.05);
    },
  };
  setters.freq(5, 0); setters.mix(5, 0);
  return shell(ctx, input, out, setters, [carrier]);
}

/* compressor — squeeze + makeup gain = sustain-for-days */
function createCompressor(ctx) {
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  comp.connect(makeup);
  const setters = {
    _nodes: { comp },
    sustain: (v, t) => {
      comp.threshold.setTargetAtTime(-10 - (v / 10) * 40, t, 0.05);
      comp.ratio.setTargetAtTime(2 + (v / 10) * 14, t, 0.05);
      makeup.gain.setTargetAtTime(Math.pow(10, ((v / 10) * 14) / 20), t, 0.05);
    },
    attack: (v, t) => comp.attack.setTargetAtTime(0.001 + (v / 10) * 0.1, t, 0.05),
  };
  setters.sustain(5, 0); setters.attack(3, 0);
  return shell(ctx, comp, makeup, setters);
}

/* eq — 3-band tone shaper: low shelf, sweepable mid peak, high shelf */
function createEQ(ctx) {
  const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 180;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 800; mid.Q.value = 0.9;
  const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 3200;
  lo.connect(mid).connect(hi);
  const db = (v) => (v - 5) * 2.4; // 0..10 -> ±12 dB, 5 = flat
  const setters = {
    _nodes: { mid, hi },
    bass: (v, t) => lo.gain.setTargetAtTime(db(v), t, 0.05),
    mid: (v, t) => mid.gain.setTargetAtTime(db(v), t, 0.05),
    treble: (v, t) => hi.gain.setTargetAtTime(db(v), t, 0.05),
    freq: (v, t) => mid.frequency.setTargetAtTime(300 * Math.pow(10, v / 10), t, 0.05),
  };
  return shell(ctx, lo, hi, setters);
}

/* level — output gain (0 silent, 5 unity, 10 hot) */
function createLevel(ctx) {
  const g = ctx.createGain();
  const setters = {
    gain: (v, t) => g.gain.setTargetAtTime(Math.pow(v / 10, 1.5) * 2.83, t, 0.05),
  };
  setters.gain(5, 0);
  return shell(ctx, g, g, setters);
}

export const MODULES = {
  drive:   { create: createDrive,   params: ['amount', 'tone', 'level'] },
  delay:   { create: createDelay,   params: ['time', 'feedback', 'mix'] },
  chorus:  { create: createChorus,  params: ['rate', 'depth', 'mix'] },
  tremolo: { create: createTremolo, params: ['rate', 'depth'] },
  filter:  { create: createFilter,  params: ['cutoff', 'resonance'] },
  phaser:  { create: createPhaser,  params: ['rate', 'depth', 'feedback'] },
  reverb:  { create: createReverb,  params: ['size', 'mix'] },
  ring:    { create: createRing,    params: ['freq', 'mix'] },
  comp:    { create: createCompressor, params: ['sustain', 'attack'] },
  eq:      { create: createEQ,      params: ['bass', 'mid', 'treble', 'freq'] },
  level:   { create: createLevel,   params: ['gain'] },
};
