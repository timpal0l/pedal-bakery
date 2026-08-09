# Onboarding — Pedal Bakery

You're looking at a browser app where you describe a sound in English and an
LLM bakes you a guitar pedal: a 3D box with artwork, knobs wired to a real
Web Audio effect chain, that you cable up on a virtual pedalboard with other
people in realtime.

If you haven't set up your machine yet, start with `WINDOWS-SETUP.md`.
`README.md` is the full feature tour — this file is about working *on* the
code.

## Get it running

```sh
python3 bakery/server.py          # then open http://localhost:8123
```

Use `PORT=8124 python3 bakery/server.py` if 8123 is taken.

Two things to know about running it:

- The **first click matters.** Browsers refuse to make sound until the user
  interacts with the page, so the CREATE BAKERY click doubles as that gesture.
  No click, no audio.
- **BAKE needs Claude Code** installed and logged in — the server literally
  runs `claude -p` on your subscription to design the pedal. The shelf of
  pre-baked pedals works without it.

Add `?solo=1` to the URL to skip the lobby and get a quick offline board.
That's the fastest way to poke at something.

## The one idea to understand first

Everything is a **pedal spec** — a single JSON object. It's what the LLM
writes, what every file in `specs/` holds, and the only thing the app loads.
Nothing else crosses between the layers.

```json
{ "name": "Drowned Cathedral",
  "enclosure": { "width": 3.2, "depth": 2.4, "height": 0.6, "color": "#1c3a34" },
  "chain":     [ { "id": "warp", "type": "chorus", "params": { "rate": 1.5 } } ],
  "controls":  [ { "id": "k2", "label": "SLOW", "target": "warp.rate" } ] }
```

The `chain` is assembled from a fixed module library in `js/modules.js` — the
LLM picks and configures modules but never writes DSP. That's deliberate: a
bad generation can be boring, but it can't be broken. Every parameter lives
in knob-space 0–10 and each module owns its own curve to real units.

## Layout, and the rules that keep it clean

```
js/config.js     shared constants (the E chord)
js/modules.js    the effect building blocks (Web Audio DSP)
js/audio.js      engine: sources, per-pedal rigs, chain routing, amp
js/board.js      pure data: who is cabled to whom
js/layout.js     spec -> (u,v) positions for controls on the face plate
js/artwork.js    procedural face-plate painting (canvas)
js/scene.js      Babylon world: grid, amp, pedals, cables
js/net.js        multiplayer transport
js/main.js       the wiring — start reading here
bakery/server.py static files + /specs + /bake
```

Three separation rules hold the whole thing together:

- `board.js` knows nothing about 3D or audio
- `audio.js` knows nothing about 3D
- `scene.js` knows nothing about audio

`main.js` is the only file allowed to touch everything. If you find yourself
importing audio into the scene, you're solving it in the wrong place.

## The footgun: the op layer

**This one will bite you.** Every board is a multiplayer room. Since the
multiplayer work, every mutation of board state in `js/main.js` must go
through the op layer:

```js
applySpawn(...)          // apply it locally
net.sendOp(op)           // and tell everyone else
```

A direct mutation looks perfectly fine on your screen and **silently
desyncs** everyone else in the room. If you add a new kind of op, mirror it
in `apply_op` in `bakery/server.py` so the server can replay it.

## Poking at it while it runs

The app exposes hooks on `window.__pedal` for automation and debugging —
`instances()`, `spawn`, `remove`, `connect`, `disconnect`, `chain()`, `set`,
`state`, `screenPos`, `setCamera`. Open the console and try:

```js
__pedal.instances()      // what's on the floor
__pedal.chain()          // what's actually cabled to the amp
```

Uncaught errors collect in `window.__errors`, which is how the app gets
verified headlessly.

**No sound?** Ninety percent of the time it's the cables: the source has to
reach the amp through an unbroken chain. That's the rule of the app, not a
bug.

## Good first changes

Roughly in order of difficulty:

1. **Hand-write a pedal.** Drop a JSON file into `specs/` and reload — it's
   on the shelf. Copy an existing one and change the colors and knob labels.
2. **Retune the bakery's taste.** `PROMPT` in `bakery/server.py` is the
   entire creative brief given to the LLM. Change it, bake something, see
   what comes out different.
3. **Add an effect module.** Write a factory in `js/modules.js` (in/out nodes
   plus 0–10 param setters), then register it in *both* `MODULES` there and
   in `bakery/server.py` — the server copy is how the LLM learns it exists.
   Miss the second one and your module is invisible to the bakery.

## Working with Claude Code in here

Ask it to explain before asking it to change: *"walk me through how a click
on a knob ends up changing the audio"* will teach you more than reading
`main.js` top to bottom.

Two things worth telling it when you start a task in this repo:

- board mutations in `main.js` go through the op layer, never direct
- the layer separation rules above

It won't infer either from the code alone, and both are easy to violate
invisibly.
