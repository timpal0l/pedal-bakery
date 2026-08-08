#!/usr/bin/env python3
"""Pedal Bakery server.

Serves the static app AND provides POST /bake, which asks Claude Code
(headless: `claude -p`, uses your logged-in subscription) to design a pedal
spec from a text description. The spec is validated/clamped here before it
reaches the browser, so a weird generation can only ever be boring, not
broken.

Run:  python3 bakery/server.py        (then open http://localhost:8123)
Needs the `claude` CLI installed and logged in.
"""

import base64
import difflib
import hashlib
import json
import re
import secrets
import socket
import struct
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
PORT = 8123

# keep in sync with js/modules.js
MODULES = {
    "drive":   ["amount", "tone", "level"],
    "delay":   ["time", "feedback", "mix"],
    "chorus":  ["rate", "depth", "mix"],
    "tremolo": ["rate", "depth"],
    "filter":  ["cutoff", "resonance"],
    "phaser":  ["rate", "depth", "feedback"],
    "reverb":  ["size", "mix"],
    "ring":    ["freq", "mix"],
    "comp":    ["sustain", "attack"],
    "level":   ["gain"],
}

ART_STYLES = ("gradient", "burst", "stripes", "dots", "waves", "checker", "diagonal", "rings", "flake", "plaid")

PROMPT = """You are the Pedal Bakery: you turn a description of a guitar sound into a JSON spec for a virtual effect pedal. Reply with ONLY one JSON object — no markdown fences, no commentary.

Schema (all numeric params are knob-space 0-10):
{{
  "kind": "pedal" | "amp",
  "shape": "box" | "round",
  "name": "1-3 words, wildly varied",
  "tagline": "short vibe line, lowercase",
  "enclosure": {{ "width": 1.1-4.2, "depth": 1.6-3.2, "height": 0.35-0.9, "color": "#hex" }},
  "artwork": {{ "style": "gradient"|"burst"|"stripes"|"dots"|"waves"|"checker"|"diagonal"|"rings"|"flake"|"plaid", "palette": ["#hex","#hex","#hex"], "textColor": "#hex" }},
  "chain": [ {{ "id": "shortId", "type": "<module>", "params": {{ "<param>": 0-10 }} }} ],
  "controls": [ {{ "id": "shortId", "label": "UPPERCASE, max 7 chars", "target": "moduleId.param" }} ],
  "switches": [ {{ "id": "shortId", "label": "UPPERCASE", "target": "moduleId.param", "off": 0-10, "on": 0-10 }} ]
}}

Available modules and their params (each param 0-10, module owns the real-unit curve):
- drive: amount (clean->fuzz), tone (dark->bright), level
- delay: time (60ms->1.2s), feedback, mix
- chorus: rate, depth, mix (10 = full vibrato)
- tremolo: rate, depth (STEREO ping-pong: full depth sweeps ear to ear)
- filter: cutoff (dark->open lowpass), resonance
- phaser: rate, depth, feedback
- reverb: size, mix
- ring: freq (30Hz->2kHz ring modulator: bells, robots, aliens), mix
- comp: sustain (squeeze + makeup gain), attack
- level: gain (0 silent, 5 unity, 10 hot)

Rules:
- kind: decide from the description. An AMP is a chain terminator — its chain is the amp's tone stack (drive/filter/comp/reverb/level fit well) and its controls are front-panel knobs; give it a tall cabinet (height 1.2-2.2). Anything said to be an amp/combo/stack/cab is an amp; otherwise it's a pedal.
- chain: 1-6 modules in signal order that genuinely produce the described sound.
- params are the default knob positions: choose musical values that already sound like the description.
- controls: 1-8 knobs targeting the most expressive params, each target must be an existing "moduleId.param". Do not give a knob and a switch the same target.
- switches: 0-2, for character flips (boost, bright, wobble-double...).
- VARY THE HARDWARE with the sound. A one-trick fuzz is a mini box (width ~1.2, 1-2 knobs). A classic stomp is ~2.2 wide with 3-4 knobs. A complex multi-effect monster is a wide console (width 3-4.2, depth up to 3.2, 5-8 knobs, taller box). Pick the format the described sound deserves — do not default to medium.
- shape: "round" (fuzz-face style circular pedal, max 4 knobs, suits simple vintage circuits) or "box". Use round sometimes — variety matters. Amps are always boxes.
- name, palette, art style, enclosure color: match the vibe. Be bold and varied; different sounds should look like they came from different builders.
- NAMES MUST VARY in structure: mix single evocative words ("Vermilion", "Motorik"), compounds ("Rustbucket"), place/person names ("Saint Fuzz", "Osaka Drift"), and puns — never the same Adjective-Noun formula twice in a row.
- BE BOLD WITH PARAMS: defaults must already SOUND like the description. A filthy fuzz wants amount 8-10; a subtle shimmer wants depth 2. Never park everything near 5, and prefer distinctive module combos (ring, comp, phaser, tremolo where they fit) over defaulting to drive+reverb.
- KNOB COUNT MUST VARY — do NOT default to 4. One-trick boxes get 1-2 knobs. Classic stomps 3-4. Rich or complex descriptions get 6-8 knobs exposing secondary parameters (tone, level, feedback, attack, resonance...). Spread across the whole 1-8 range.

Description of the wanted sound:
{description}"""


def run_claude(description: str) -> dict:
    prompt = PROMPT.format(description=description)
    r = subprocess.run(
        ["claude", "-p", prompt, "--output-format", "json"],
        capture_output=True, text=True, timeout=240,
    )
    if r.returncode != 0:
        raise RuntimeError(f"claude CLI failed: {r.stderr.strip()[:300]}")
    payload = json.loads(r.stdout)
    text = payload.get("result", "")
    match = re.search(r"\{.*\}", text, re.S)  # tolerate fences or stray prose
    if not match:
        raise ValueError("no JSON object in Claude's reply")
    return json.loads(match.group(0))


def clamp(v, lo, hi, default):
    try:
        return min(hi, max(lo, float(v)))
    except (TypeError, ValueError):
        return default


def hex_or(value, default):
    return value if isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value) else default


def slug(value, fallback):
    s = re.sub(r"[^a-z0-9_-]", "", str(value).lower())[:16]
    return s or fallback


def validate(raw: dict) -> dict:
    """Clamp everything the LLM invented into ranges the app can always render."""
    enc = raw.get("enclosure") or {}
    art = raw.get("artwork") or {}
    palette = art.get("palette") or []
    kind = raw.get("kind") if raw.get("kind") in ("pedal", "amp") else "pedal"
    shape = raw.get("shape") if raw.get("shape") in ("box", "round") and kind == "pedal" else "box"
    spec = {
        "kind": kind,
        "shape": shape,
        "name": str(raw.get("name") or "Mystery Loaf")[:28],
        "tagline": str(raw.get("tagline") or "")[:48],
        "enclosure": {
            "width": clamp(enc.get("width"), 1.1, 4.2, 2.2),
            "depth": clamp(enc.get("depth"), 1.6, 3.2, 2.2),
            "height": (clamp(enc.get("height"), 1.1, 2.2, 1.5) if kind == "amp"
                       else clamp(enc.get("height"), 0.35, 0.9, 0.5)),
            "color": hex_or(enc.get("color"), "#4a4f5a"),
        },
        "artwork": {
            "style": art.get("style") if art.get("style") in ART_STYLES else "gradient",
            "palette": [hex_or(p, d) for p, d in zip(list(palette) + ["", "", ""], ["#5b6ee1", "#232946", "#eebbc3"])][:3],
            "textColor": hex_or(art.get("textColor"), "#ffffff"),
        },
        "chain": [], "controls": [], "switches": [],
    }

    seen = set()
    for i, m in enumerate((raw.get("chain") or [])[:6]):
        mtype = m.get("type")
        if mtype not in MODULES:
            continue
        mid = slug(m.get("id"), f"m{i}")
        if mid in seen:
            mid = f"{mid}{i}"
        seen.add(mid)
        params = {p: clamp(v, 0, 10, 5) for p, v in (m.get("params") or {}).items()
                  if p in MODULES[mtype]}
        spec["chain"].append({"id": mid, "type": mtype, "params": params})
    if not spec["chain"]:
        raise ValueError("Claude produced no usable effect modules")

    def target_ok(target):
        mod_id, _, param = str(target).partition(".")
        mod = next((m for m in spec["chain"] if m["id"] == mod_id), None)
        return mod is not None and param in MODULES[mod["type"]]

    used = set()
    for i, c in enumerate((raw.get("controls") or [])[:8]):
        if not target_ok(c.get("target")):
            continue
        cid = slug(c.get("id"), f"k{i}")
        if cid in used:
            cid = f"{cid}{i}"
        used.add(cid)
        spec["controls"].append({
            "id": cid,
            "label": str(c.get("label") or cid).upper()[:8],
            "target": c["target"],
        })
    if not spec["controls"]:
        raise ValueError("Claude produced no usable knobs")
    if shape == "round":
        spec["controls"] = spec["controls"][:4]
        d = (spec["enclosure"]["width"] + spec["enclosure"]["depth"]) / 2
        spec["enclosure"]["width"] = spec["enclosure"]["depth"] = clamp(d, 1.8, 2.8, 2.2)

    for i, s in enumerate((raw.get("switches") or [])[:2]):
        if not target_ok(s.get("target")):
            continue
        sid = slug(s.get("id"), f"s{i}")
        if sid in used:
            continue
        used.add(sid)
        spec["switches"].append({
            "id": sid,
            "label": str(s.get("label") or sid).upper()[:8],
            "target": s["target"],
            "off": clamp(s.get("off"), 0, 10, 0),
            "on": clamp(s.get("on"), 0, 10, 10),
        })

    # physical coherence: many knobs need a big box; minis get one toggle max
    n = len(spec["controls"])
    e = spec["enclosure"]
    if n >= 5:
        e["width"] = max(e["width"], 2.4)
        e["depth"] = max(e["depth"], 2.2)
    if n >= 7:
        e["width"] = max(e["width"], 3.0)
        e["depth"] = max(e["depth"], 2.4)
    if e["width"] < 1.6:
        spec["switches"] = spec["switches"][:1]
    return spec


# --- bake cache: same or similar description -> reuse the saved pedal -------
SIMILAR = 0.8  # 1.0 = identical; 0.8 catches rewordings of the same idea

def norm_desc(text):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", text.lower())).strip()


def similarity(a, b):
    ta, tb = set(a.split()), set(b.split())
    jaccard = len(ta & tb) / max(1, len(ta | tb))
    seq = difflib.SequenceMatcher(None, a, b).ratio()
    return max(jaccard, seq)


def find_cached(description):
    """Best saved pedal whose original description matches this one."""
    n = norm_desc(description)
    if not n:
        return None, 0.0
    best, best_score = None, 0.0
    for f in (ROOT / "specs").glob("*.json"):
        try:
            spec = json.loads(f.read_text())
        except Exception:
            continue
        baked_from = spec.get("bakedFrom")
        if not baked_from:
            continue
        score = similarity(n, norm_desc(baked_from))
        if score > best_score:
            best, best_score = spec, score
    return (best, best_score) if best_score >= SIMILAR else (None, best_score)


def save_spec(spec):
    """Baked pedals join the shelf permanently as specs/baked-*.json."""
    base = "baked-" + (re.sub(r"[^a-z0-9]+", "-", spec["name"].lower()).strip("-") or "pedal")
    path, n = ROOT / "specs" / f"{base}.json", 2
    while path.exists():
        path, n = ROOT / "specs" / f"{base}-{n}.json", n + 1
    path.write_text(json.dumps(spec, indent=2))
    return path.name


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] != "/specs":
            return super().do_GET()
        specs = []
        for f in sorted((ROOT / "specs").glob("*.json")):
            try:
                spec = json.loads(f.read_text())
                spec["_mtime"] = f.stat().st_mtime
                specs.append(spec)
            except Exception as exc:
                print(f"[shelf] skipping {f.name}: {exc}")
        specs.sort(key=lambda s: str(s.get("name", "")))
        self._json(200, specs)

    def do_POST(self):
        if self.path != "/bake":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            description = str(body.get("description", ""))[:500]
            cached, score = find_cached(description)
            if cached:
                print(f"[bakery] cache hit ({score:.2f}): {cached['name']} for {description!r}")
                self._json(200, {"spec": cached, "cached": True, "similarity": round(score, 2)})
                return
            print(f"[bakery] baking: {description!r}")
            spec = validate(run_claude(description))
            spec["bakedFrom"] = description
            fname = save_spec(spec)
            print(f"[bakery] done: {spec['name']} — "
                  + " -> ".join(m["type"] for m in spec["chain"]) + f" (saved {fname})")
            self._json(200, {"spec": spec, "cached": False})
        except Exception as exc:  # anything -> readable error in the UI
            print(f"[bakery] FAILED: {exc}")
            self._json(500, {"error": str(exc)[:300]})

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"Pedal Bakery on http://localhost:{PORT} (serving {ROOT})")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
