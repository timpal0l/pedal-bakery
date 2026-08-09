# CLAUDE.md

Pedal Bakery: an LLM bakes guitar pedals from text descriptions, you cable
them up on a 3D board, multiple people share the board live. Plain static
files plus one Python server — no build step, no package.json, no npm.

`README.md` is the feature tour. `ONBOARDING.md` orients a new contributor.
This file is the rules.

## Run it

```sh
python3 bakery/server.py            # http://localhost:8123
PORT=8124 python3 bakery/server.py  # a test instance
```

Port 8123 is often already held by someone else's long-running server —
start a second instance on another port rather than killing it.

`?solo=1` boots with no lobby and no server round-trip, which is the fast
path for headless screenshots and single-player poking. Player identity
lives in `sessionStorage`, so two browser tabs act as two players.

`BAKE` shells out to `claude -p` (see `run_claude` in `bakery/server.py`), so
it needs the CLI logged in. `python3 bakery/seed.py [--workers N]` bulk-bakes
the shelf.

## The one rule: every board mutation goes through the op layer

Since multiplayer, **never mutate board state directly in `js/main.js`.** Do
both halves:

```js
applyKnob({ id, control, value });                  // local
net.sendOp({ type: 'knob', id, control, value });   // everyone else
```

A direct mutation renders correctly on your screen and **silently desyncs
every other client**. There is no error, no warning, and the person who broke
it is the one person who can't see it.

The pieces:

- `applyOp(op)` in `js/main.js` is the inbound dispatcher; the `apply*`
  family under it (`applySpawn`, `applySpawnPost`, `applyRemove`, `applyMove`,
  `applyKnob`, `applyToggle`, `applyBypass`, `applyVolume`, `applyTone`,
  `applyBpm`) are the local halves.
- `net.sendOp(op)` broadcasts. Use `net.sendOpThrottled(key, op)` for
  continuous gestures like knob drags, and `net.flushOps()` when the gesture
  ends.
- **A new op type must be mirrored in `apply_op` in `bakery/server.py`**
  (~line 378), or the server can't replay it and the room won't survive a
  restart or a late joiner.

Wire envelope is `{ t: 'op', op: {...} }`.

## Layer boundaries

The spec JSON is the only currency between layers. Hold these:

- `js/board.js` — pure cabling data. Knows nothing about 3D or audio.
- `js/audio.js` — Web Audio engine. Knows nothing about 3D.
- `js/scene.js` — Babylon world. Knows nothing about audio.
- `js/main.js` — the only file allowed to touch everything.

If a fix seems to need audio inside the scene, it belongs in `main.js`.

## Adding an effect module

Two registrations, in two languages, and missing the second is the usual bug:

1. A factory in `js/modules.js` — in/out nodes plus 0–10 param setters — and
   an entry in `MODULES` there.
2. The same module and its param names in `bakery/server.py`, which is how
   the LLM learns it exists and how the server validates generated specs.

All params live in knob-space 0–10; each module owns its own curve to real
units. The LLM never writes DSP — it only picks and configures modules, which
is why a bad generation can be boring but never broken.

## Headless testing

`window.__pedal` (end of `js/main.js`) drives the app without a mouse:
`instances()`, `posts()`, `spec(id)`, `state(id)`, `spawn`, `spawnSource`,
`spawnAmp`, `remove`, `connect`, `disconnect`, **`chains`**, `set`,
`setSource`, `tone`, `volume`, `bpm`, `select`, `selected()`, `screenPos`,
`camera()`, `setCamera`, `net()`, `join`, `create`.

Note it is `chains`, not `chain()` — `README.md` gets this wrong.

Uncaught errors accumulate in `window.__errors`; check it after any headless
run. Verification is done with synthetic pointer events against these hooks.

## Babylon traps

- **Box side-face UVs render rotated 90°.** Use `CreatePlane` for anything
  with readable artwork or text on a side face.
- **Set an ArcRotateCamera's `target` before `alpha`/`beta`/`radius`.**
  Assigning `target` recomputes the others from the current position and
  clobbers whatever you just set. `setCamera` in `js/main.js` already does
  this in the right order — match it.

## Repo habits

Several sessions commit directly to `main` on this repo at once, so the
working tree and `HEAD` can move mid-task. Re-read a file immediately before
editing it rather than trusting an earlier read. `js/main.js`, `js/scene.js`
and `bakery/server.py` are the contended ones.

`specs/*.json` is live data — the shelf, with baked pedals auto-saved there.
`rooms/` is gitignored server state. Don't tidy either.
