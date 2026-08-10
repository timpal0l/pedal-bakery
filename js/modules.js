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

/* drive — waveshaper dirt with five real personalities.
   At high gain every soft-clipper converges on a square wave, so character
   here comes from what actually separates real pedals: clipping asymmetry
   (even harmonics), a pre-clip mid hump or scoop, and how much low end
   survives into the distortion. */
const DRIVE_CHARACTERS = [
  // label      pre-hump dB @Hz     low cut  neg ceiling  knee
  { hump:  0.0, humpHz: 500,  cut:  60, neg: 0.55, knee: 'soft' },  // tube
  { hump:  9.0, humpHz: 720,  cut: 180, neg: 1.00, knee: 'soft' },  // overdrive
  { hump: -7.0, humpHz: 620,  cut:  90, neg: 1.00, knee: 'hard' },  // distortion
  { hump:  3.5, humpHz: 1500, cut:  40, neg: 0.72, knee: 'gate' },  // fuzz
  { hump:  0.0, humpHz: 800,  cut:  70, neg: 1.00, knee: 'fold' },  // wavefolder
];

function createDrive(ctx) {
  const input = ctx.createGain();
  const cut = ctx.createBiquadFilter(); cut.type = 'highpass'; cut.Q.value = 0.7;
  const hump = ctx.createBiquadFilter(); hump.type = 'peaking'; hump.Q.value = 0.8;
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper(); shaper.oversample = '4x';
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
  const out = ctx.createGain();
  input.connect(cut).connect(hump).connect(pre).connect(shaper).connect(tone).connect(out);

  let levelGain = 1, lastAmount = 5, charac = 3;

  function rebuild(t) {
    const c = DRIVE_CHARACTERS[Math.min(4, Math.floor((charac / 10) * 5))];
    cut.frequency.setTargetAtTime(c.cut, t, 0.05);
    hump.frequency.setTargetAtTime(c.humpHz, t, 0.05);
    hump.gain.setTargetAtTime(c.hump, t, 0.05);
    const v = lastAmount;
    const k = 1 + Math.pow(v / 10, 2) * 150;
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const ceil = x < 0 ? c.neg : 1;       // asymmetry survives saturation
      let y;
      if (c.knee === 'soft') {
        y = ceil * Math.tanh(k * 0.11 * x);
      } else if (c.knee === 'hard') {
        y = Math.max(-ceil, Math.min(ceil, k * 0.35 * x));
      } else if (c.knee === 'gate') {       // fuzz: dead zone then a hard wall
        const dead = 0.012;
        const xs = Math.abs(x) < dead ? 0 : Math.sign(x) * (Math.abs(x) - dead);
        y = Math.max(-ceil, Math.min(ceil, k * 0.6 * xs));
      } else {                              // fold: reflect back on itself
        y = Math.sin(x * (1 + k * 0.05) * Math.PI * 0.5);
      }
      curve[i] = y;
    }
    shaper.curve = curve;
    pre.gain.setTargetAtTime(0.6 + Math.pow(v / 10, 1.5) * 18, t, 0.05);
    out.gain.setTargetAtTime(levelGain / (1 + (v / 10) * 2.2), t, 0.05);
  }

  const setters = {
    _nodes: { cut, hump, pre, shaper, tone },
    amount: (v, t) => { lastAmount = v; rebuild(t); },
    character: (v, t) => { charac = v; rebuild(t ?? ctx.currentTime); },
    tone: (v, t) => tone.frequency.setTargetAtTime(400 * Math.pow(2, (v / 10) * 4.6), t, 0.05),
    level: (v) => { levelGain = Math.pow(v / 10, 1.5) * 2; rebuild(ctx.currentTime); },
  };
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
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  // analog/tape delays darken every repeat and drift slightly — that decay
  // into mush is most of what makes a delay sound musical instead of digital
  const fbTone = ctx.createBiquadFilter();
  fbTone.type = 'lowpass'; fbTone.frequency.value = 2600; fbTone.Q.value = 0.5;
  const fbCut = ctx.createBiquadFilter();
  fbCut.type = 'highpass'; fbCut.frequency.value = 160; fbCut.Q.value = 0.6;
  const wow = ctx.createOscillator(); wow.type = 'sine'; wow.frequency.value = 0.32;
  const wowAmt = ctx.createGain(); wowAmt.gain.value = 0.0016;
  wow.connect(wowAmt).connect(d.delayTime);
  wow.start();
  input.connect(dry).connect(out);
  input.connect(d);
  d.connect(fbTone).connect(fbCut).connect(fb).connect(d);
  d.connect(wet).connect(out);
  d.delayTime.value = 0.3; fb.gain.value = 0.35;
  const setters = {
    _nodes: { d, fb, fbTone, fbCut, dry, wet },
    time: (v, t) => d.delayTime.setTargetAtTime(0.06 * Math.pow(20, v / 10), t, 0.1),
    feedback: (v, t) => fb.gain.setTargetAtTime((v / 10) * 0.95, t, 0.05),
    // equal-power crossfade: at 10 the dry signal is gone, not merely buried
    mix: (v, t) => {
      const m = (v / 10) * (Math.PI / 2);
      dry.gain.setTargetAtTime(Math.cos(m), t, 0.05);
      wet.gain.setTargetAtTime(Math.sin(m), t, 0.05);
    },
  };
  setters.mix(5, 0);
  return shell(ctx, input, out, setters, [wow]);
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
    mix: (v, t) => { // 5 is the classic 50/50 notch; 10 is pure vocal sweep
      const m = (v / 10) * (Math.PI / 2);
      dry.gain.setTargetAtTime(Math.cos(m), t, 0.05);
      wet.gain.setTargetAtTime(Math.sin(m), t, 0.05);
    },
  };
  setters.rate(4, 0); setters.depth(5, 0); setters.feedback(3, 0);
  return shell(ctx, input, out, setters, [lfo]);
}

/* reverb — convolver with a generated exponential-decay impulse response */
function createReverb(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const conv = ctx.createConvolver();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(out);
  input.connect(conv);
  conv.connect(wet).connect(out);
  // A plain noise burst sounds like hiss, not a room. Real spaces have
  // discrete early reflections, a diffuse tail, and highs that die first.
  function buildIR(v) {
    const len = 0.4 + Math.pow(v / 10, 2) * 4.6;
    const sr = ctx.sampleRate;
    const N = Math.floor(sr * len);
    const buf = ctx.createBuffer(2, N, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;                       // one-pole state: the tail darkens
      for (let i = 0; i < N; i++) {
        const t = i / N;
        const white = Math.random() * 2 - 1;
        // damping rises with time, so the top end decays faster than the body
        const damp = 0.28 + 0.62 * t;
        lp = lp * damp + white * (1 - damp);
        // build-up then exponential decay reads as a real room, not a gate
        const env = Math.exp(-3.2 * t) * Math.min(1, t * 220);
        data[i] = lp * env * 2.4;
      }
      // early reflections: a handful of discrete taps in the first ~90ms
      const seeds = ch ? [0.011, 0.019, 0.031, 0.047, 0.062, 0.088]
                       : [0.009, 0.021, 0.034, 0.044, 0.067, 0.091];
      seeds.forEach((sec, k) => {
        const idx = Math.floor(sec * sr * (0.6 + v / 20));
        if (idx < N) data[idx] += (k % 2 ? -1 : 1) * (0.55 / (k + 1));
      });
    }
    conv.buffer = buf;
  }
  buildIR(5);
  const setters = {
    _nodes: { conv, dry, wet },
    size: (v) => buildIR(v),
    mix: (v, t) => { // full wet at 10 means drowned, which is the point
      const m = (v / 10) * (Math.PI / 2);
      dry.gain.setTargetAtTime(Math.cos(m), t, 0.05);
      wet.gain.setTargetAtTime(Math.sin(m), t, 0.05);
    },
  };
  setters.mix(4, 0);
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

/* cabinet — a guitar speaker in a box. THE reason amp sims sound real:
   a 12" driver rolls off hard above ~5kHz, humps in the presence region and
   thumps around 200Hz. Without it, distortion is all fizz and no speaker. */
export function createCabinet(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const hp = ctx.createBiquadFilter();      // no subsonic mud
  hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;
  const body = ctx.createBiquadFilter();    // cabinet thump
  body.type = 'peaking'; body.frequency.value = 230; body.gain.value = 3; body.Q.value = 1.1;
  const dip = ctx.createBiquadFilter();     // cone breakup dip
  dip.type = 'peaking'; dip.frequency.value = 950; dip.gain.value = -4; dip.Q.value = 1.4;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking'; presence.frequency.value = 3000; presence.gain.value = 5; presence.Q.value = 1.3;
  const lp1 = ctx.createBiquadFilter();     // two poles for a steep speaker rolloff
  lp1.type = 'lowpass'; lp1.frequency.value = 5000; lp1.Q.value = 1.1;
  const lp2 = ctx.createBiquadFilter();
  lp2.type = 'lowpass'; lp2.frequency.value = 6200; lp2.Q.value = 0.6;
  // one short reflection gives the box some depth without a full IR
  const refl = ctx.createDelay(0.01); refl.delayTime.value = 0.0013;
  const reflG = ctx.createGain(); reflG.gain.value = 0.28;
  // power-amp sag: loud passages compress and bloom back, which is a big part
  // of why valve amps feel alive rather than static
  const sag = ctx.createDynamicsCompressor();
  sag.threshold.value = -16; sag.ratio.value = 3.2;
  sag.attack.value = 0.012; sag.release.value = 0.28;
  input.connect(hp).connect(body).connect(dip).connect(presence)
       .connect(lp1).connect(lp2).connect(sag).connect(out);
  lp2.connect(refl).connect(reflG).connect(sag);
  return { in: input, out, dispose() { try { input.disconnect(); out.disconnect(); } catch { /* ok */ } } };
}

/* octave — full-wave rectification, the way real octave-up fuzzes do it:
   |x| doubles the fundamental and adds spiky harmonics */
function createOctave(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const rect = ctx.createWaveShaper();
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.abs(x) * 2 - 1; // rectify, re-centre
  }
  rect.curve = curve;
  rect.oversample = '4x';
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
  // rectification leaves a big DC offset; real octave fuzzes block it with a
  // coupling cap, and without this the module just outputs a thump
  const dc = ctx.createBiquadFilter();
  dc.type = 'highpass'; dc.frequency.value = 90; dc.Q.value = 0.7;
  input.connect(dry).connect(out);
  input.connect(rect).connect(dc).connect(tone).connect(wet).connect(out);
  const setters = {
    _nodes: { rect, dc, tone, dry, wet },
    blend: (v, t) => {
      const m = (v / 10) * (Math.PI / 2);
      dry.gain.setTargetAtTime(Math.cos(m), t, 0.05);
      wet.gain.setTargetAtTime(Math.sin(m), t, 0.05);
    },
    tone: (v, t) => tone.frequency.setTargetAtTime(600 * Math.pow(2, (v / 10) * 3.8), t, 0.05),
  };
  setters.blend(5, 0); setters.tone(6, 0);
  return shell(ctx, input, out, setters);
}

/* crush — bit-depth reduction: quantise the waveform into steps. Fewer
   steps = grittier, more digital-nasty */
function createCrush(ctx) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 6000;
  input.connect(dry).connect(out);
  input.connect(shaper).connect(tone).connect(wet).connect(out);
  function build(v) {
    const steps = Math.max(2, Math.round(64 / Math.pow(2, (v / 10) * 4.5)));
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    shaper.curve = curve;
  }
  build(5);
  const setters = {
    _nodes: { shaper, tone, dry, wet },
    bits: (v) => build(v),
    tone: (v, t) => tone.frequency.setTargetAtTime(700 * Math.pow(2, (v / 10) * 3.6), t, 0.05),
    mix: (v, t) => {
      const m = (v / 10) * (Math.PI / 2);
      dry.gain.setTargetAtTime(Math.cos(m), t, 0.05);
      wet.gain.setTargetAtTime(Math.sin(m), t, 0.05);
    },
  };
  setters.mix(8, 0); setters.tone(6, 0);
  return shell(ctx, input, out, setters);
}

/* wah — envelope-following bandpass. The rectified, smoothed signal is
   patched straight into the filter's frequency, so it opens when you dig in */
function createWah(ctx) {
  const input = ctx.createGain();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 6;
  const makeup = ctx.createGain(); makeup.gain.value = 2.2; // bandpass loses level
  // envelope follower built from plain nodes: |x| then a very low lowpass
  const rect = ctx.createWaveShaper();
  const n = 512, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
  rect.curve = curve;
  const smooth = ctx.createBiquadFilter();
  smooth.type = 'lowpass'; smooth.frequency.value = 9;
  const envAmt = ctx.createGain();
  input.connect(bp).connect(makeup);
  input.connect(rect).connect(smooth).connect(envAmt).connect(bp.frequency);
  const setters = {
    _nodes: { bp, rect, smooth, envAmt, makeup },
    sens: (v, t) => envAmt.gain.setTargetAtTime((v / 10) * 4500, t, 0.05),
    peak: (v, t) => bp.Q.setTargetAtTime(1 + (v / 10) * 14, t, 0.05),
    heel: (v, t) => bp.frequency.setTargetAtTime(180 + (v / 10) * 900, t, 0.05),
  };
  setters.sens(6, 0); setters.peak(6, 0); setters.heel(3, 0);
  return shell(ctx, input, makeup, setters);
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
  drive:   { create: createDrive,   params: ['amount', 'tone', 'level', 'character'] },
  delay:   { create: createDelay,   params: ['time', 'feedback', 'mix'] },
  chorus:  { create: createChorus,  params: ['rate', 'depth', 'mix'] },
  tremolo: { create: createTremolo, params: ['rate', 'depth'] },
  filter:  { create: createFilter,  params: ['cutoff', 'resonance'] },
  phaser:  { create: createPhaser,  params: ['rate', 'depth', 'feedback'] },
  reverb:  { create: createReverb,  params: ['size', 'mix'] },
  ring:    { create: createRing,    params: ['freq', 'mix'] },
  comp:    { create: createCompressor, params: ['sustain', 'attack'] },
  eq:      { create: createEQ,      params: ['bass', 'mid', 'treble', 'freq'] },
  octave:  { create: createOctave,  params: ['blend', 'tone'] },
  crush:   { create: createCrush,   params: ['bits', 'tone', 'mix'] },
  wah:     { create: createWah,     params: ['sens', 'peak', 'heel'] },
  level:   { create: createLevel,   params: ['gain'] },
};
