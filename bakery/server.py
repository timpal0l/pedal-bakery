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
import os
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
PORT = int(os.environ.get("PORT", "8123"))

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
    "eq":      ["bass", "mid", "treble", "freq"],
    "level":   ["gain"],
}

ART_STYLES = ("gradient", "burst", "stripes", "dots", "waves", "checker", "diagonal", "rings", "flake", "plaid")

# amp cabinet vocabulary — keep in sync with js/artwork.js + js/scene.js
GRILLE_STYLES = ("weave", "diagonal", "tweed", "salt", "oxblood", "metal", "stripes")
TOLEX_STYLES = ("levant", "smooth", "tweed", "western", "sparkle")
AMP_FORMATS = ("practice", "combo", "stack")
LOGO_STYLES = ("script", "block", "badge", "none")
AMP_KNOB_CAP = {"practice": 3, "combo": 5, "stack": 6}
AMP_MAX_W = {"practice": 2.4, "combo": 3.6, "stack": 4.6}
MIN_KNOB_PITCH = 0.5  # world units; the 3D knob bezel is 0.36 wide

PROMPT = """You are the Pedal Bakery: you turn a description of a guitar sound into a JSON spec for a virtual effect pedal. Reply with ONLY one JSON object — no markdown fences, no commentary.

Schema (all numeric params are knob-space 0-10):
{{
  "kind": "pedal" | "amp",
  "shape": "box" | "round",
  "name": "1-3 words, wildly varied",
  "tagline": "short vibe line, lowercase",
  "enclosure": {{ "width": number, "depth": number, "height": number, "color": "#hex" }},  (ranges differ for pedals vs amps — see rules)
  "cabinet": {{ "format": "practice"|"combo"|"stack", "speakers": 1|2|4, "grille": {{ "style": "weave"|"diagonal"|"tweed"|"salt"|"oxblood"|"metal"|"stripes", "color": "#hex", "accent": "#hex" }}, "tolex": "levant"|"smooth"|"tweed"|"western"|"sparkle", "trim": "#hex", "panel": "#hex", "logo": "script"|"block"|"badge"|"none" }},  (AMPS ONLY — omit for pedals)
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
- eq: bass, mid, treble (each 0-10 = -12..+12 dB, 5 flat), freq (mid center 300Hz->3kHz)
- level: gain (0 silent, 5 unity, 10 hot)

Rules:
- kind: decide from the description. Anything said to be an amp/combo/stack/cab (or that only makes sense as one) is an AMP; otherwise it's a pedal. An amp is a chain terminator — its chain is the amp's tone stack (drive/filter/comp/reverb/level fit well) and its controls are its panel knobs.
- PEDAL enclosure ranges: width 1.1-4.2, depth 1.6-3.2, height 0.35-0.9.
- AMP enclosure is the CABINET: width = across the front, depth = front-to-back (0.9-2.4), height = how tall it stands. Pick a format and size it honestly:
  * "practice": cute bedroom cube — width 1.4-2.0, height 0.9-1.3, 1 speaker, 1-3 knobs
  * "combo": classic gigging box — width 2.4-3.4, height 1.6-2.4, 1-2 speakers, 3-5 knobs
  * "stack": amp head on a big straight cab — width 2.6-3.8, height 3.0-4.5, 4 speakers, 4-6 knobs
  SIZE WORDS ARE LAW: "big/huge/massive/wall of sound" means a stack near the top of its ranges; "tiny/small/little/bedroom" means practice near the bottom; unstated usually means combo.
- AMP LOOKS (the 3D matters as much as the sound): enclosure.color is the tolex vinyl color — COLOR WORDS ARE LAW ("BIG ORANGE AMP" = a stack wrapped in loud orange tolex). Fill the cabinet block boldly and make every amp look like it came from a different builder: cream tolex + oxblood grille, surf-blue sparkle + silver weave, tweed + brown diagonal, black levant + basketweave + gold trim, industrial grey + metal grille + chrome trim... "trim" is the piping color, "panel" the control-plate color, "logo" the lettering style used on the grille and panel.
- DO NOT DEFAULT THE FINISH. "levant" (pebbled black-amp vinyl) is the boring safe pick — reach for smooth, tweed, western or sparkle whenever the vibe allows, and pick the grille cloth from the whole list rather than always "weave". Vintage/country/jazz -> tweed or smooth cream; surf/60s -> sparkle; modern/metal/industrial -> metal or oxblood; only genuinely black-box amps get levant.
- AMP SIZE IS NOT KNOB COUNT: a small cabinet simply carries fewer knobs (a 1.5-wide practice amp fits 2). Never widen a cabinet just to hold more controls — pick the size the description implies, then choose knobs that fit.
- chain: 1-6 modules in signal order that genuinely produce the described sound.
- params are the default knob positions: choose musical values that already sound like the description.
- controls: 1-8 knobs (amps: cap at the format's knob count above) targeting the most expressive params, each target must be an existing "moduleId.param". Do not give a knob and a switch the same target.
- switches: 0-2, for character flips (boost, bright, wobble-double...).
- VARY THE HARDWARE with the sound. For pedals: a one-trick fuzz is a mini box (width ~1.2, 1-2 knobs); a classic stomp is ~2.2 wide with 3-4 knobs; a complex multi-effect monster is a wide console (width 3-4.2, depth up to 3.2, 5-8 knobs, taller box). Pick the format the described sound deserves — do not default to medium.
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
        detail = (r.stderr.strip() or r.stdout.strip() or "no output — is `claude` logged in?")
        raise RuntimeError(f"claude CLI failed (exit {r.returncode}): {detail[:300]}")
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
            # for amps width is across the front, depth is front-to-back
            "width": (clamp(enc.get("width"), 1.4, 4.6, 2.8) if kind == "amp"
                      else clamp(enc.get("width"), 1.1, 4.2, 2.2)),
            "depth": (clamp(enc.get("depth"), 0.9, 2.4, 1.4) if kind == "amp"
                      else clamp(enc.get("depth"), 1.6, 3.2, 2.2)),
            "height": (clamp(enc.get("height"), 0.8, 4.6, 2.0) if kind == "amp"
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
    if kind == "amp":
        validate_cabinet(raw, spec)
    else:
        if n >= 5:
            e["width"] = max(e["width"], 2.4)
            e["depth"] = max(e["depth"], 2.2)
        if n >= 7:
            e["width"] = max(e["width"], 3.0)
            e["depth"] = max(e["depth"], 2.4)
    if e["width"] < 1.6:
        spec["switches"] = spec["switches"][:1]
    return spec


def validate_cabinet(raw: dict, spec: dict):
    """Amps only: clamp the looks block and keep cabinet, format, speakers and
    knob count physically coherent. Every missing field falls back to a classic."""
    cab = raw.get("cabinet") or {}
    grille = cab.get("grille") or {}
    e = spec["enclosure"]

    fmt = cab.get("format")
    if fmt not in AMP_FORMATS:  # infer from the box the LLM asked for
        fmt = "stack" if e["height"] >= 2.8 else "practice" if e["height"] <= 1.3 else "combo"
    speakers = cab.get("speakers")
    if speakers not in (1, 2, 4):
        speakers = {"practice": 1, "combo": 2, "stack": 4}[fmt]

    if fmt == "practice":
        e["height"] = clamp(e["height"], 0.8, 1.4, 1.1)
        if speakers == 4:
            speakers = 1
    elif fmt == "combo":
        e["height"] = clamp(e["height"], 1.4, 2.6, 1.9)
    else:  # stack
        e["height"] = clamp(e["height"], 2.8, 4.6, 3.6)
        e["width"] = max(e["width"], 2.4)
    if speakers == 4:
        e["width"] = max(e["width"], 2.6)

    # The described SIZE wins: never inflate a cabinet to make room for knobs —
    # that flattened every 3-knob practice amp to the same width. Instead the
    # panel takes what fits at a minimum pitch (js/layout.js squeezes and falls
    # back to two rows), and surplus knobs are dropped. A little amp with two
    # knobs is the honest outcome.
    e["width"] = min(e["width"], AMP_MAX_W[fmt])
    fits = max(1, int(0.86 * e["width"] / MIN_KNOB_PITCH))
    spec["controls"] = spec["controls"][:min(AMP_KNOB_CAP[fmt], fits)]

    spec["cabinet"] = {
        "format": fmt,
        "speakers": speakers,
        "grille": {
            "style": grille.get("style") if grille.get("style") in GRILLE_STYLES else "weave",
            "color": hex_or(grille.get("color"), "#3a332b"),
            "accent": hex_or(grille.get("accent"), "#59503e"),
        },
        "tolex": cab.get("tolex") if cab.get("tolex") in TOLEX_STYLES else "levant",
        "trim": hex_or(cab.get("trim"), "#d6c58f"),
        "panel": hex_or(cab.get("panel"), "#141416"),
        "logo": cab.get("logo") if cab.get("logo") in LOGO_STYLES else "block",
    }


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
    """Baked pedals join the shelf permanently as specs/baked-*.json. Display
    names must be unique too — the shelf keys thumbnails and ordering on them —
    so a repeat name gets a mark-II suffix, like a reissued amp."""
    taken = set()
    for f in (ROOT / "specs").glob("*.json"):
        try:
            taken.add(json.loads(f.read_text()).get("name", ""))
        except Exception:
            pass
    if spec["name"] in taken:
        romans = ("II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X")
        for r in romans:
            if f"{spec['name']} {r}"[:28] not in taken:
                spec["name"] = f"{spec['name']} {r}"[:28]
                break
    base = "baked-" + (re.sub(r"[^a-z0-9]+", "-", spec["name"].lower()).strip("-") or "pedal")
    path, n = ROOT / "specs" / f"{base}.json", 2
    while path.exists():
        path, n = ROOT / "specs" / f"{base}-{n}.json", n + 1
    path.write_text(json.dumps(spec, indent=2))
    return path.name


# --- multiplayer: rooms, WebSocket relay, canonical state ------------------
#
# A "bakery" is a room: an invite code, a canonical board state, and a set of
# connected players. Clients send small JSON ops over a WebSocket; the server
# applies each op to its canonical state (so late joiners get a correct
# snapshot) and relays it to every other player in the room. Presence (where
# each player's camera and cursor are) is relay-only, never stored.
# Rooms persist to rooms/<code>.json so a bakery survives server restarts.

ROOMS_DIR = ROOT / "rooms"
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I lookalikes
PLAYER_COLORS = ["#e4572e", "#3a7bd5", "#2ea44f", "#b04ae0",
                 "#e0a800", "#00b8c4", "#d54a86", "#7a6ff0"]
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_WS_MESSAGE = 512 * 1024


def empty_state():
    return {"pedals": {}, "posts": {}, "cables": []}


def apply_op(state, op):
    """Mirror of the client-side op semantics — keeps the snapshot truthful."""
    t = op.get("type")
    pedals, posts, cables = state["pedals"], state["posts"], state["cables"]
    if t == "spawn":
        pedals[op["id"]] = {"spec": op["spec"], "st": op["st"], "pos": op["pos"]}
    elif t == "spawnPost":
        posts[op["id"]] = {"ptype": op["ptype"], "st": op["st"], "pos": op["pos"]}
    elif t == "move":
        node = pedals.get(op["id"]) or posts.get(op["id"])
        if node:
            node["pos"] = {"x": op["x"], "z": op["z"]}
    elif t == "remove":
        pedals.pop(op["id"], None)
        posts.pop(op["id"], None)
        state["cables"] = [c for c in cables if op["id"] not in c]
    elif t == "connect":
        f, to = op["from"], op["to"]
        # a connect racing a remove must not leave a dangling cable in the
        # canonical state (a snapshot with one would poison late joiners) —
        # raising also stops the relay, so peers never see the dead op
        if (f not in pedals and f not in posts) or (to not in pedals and to not in posts):
            raise ValueError(f"connect to missing node: {f} -> {to}")
        state["cables"] = [c for c in cables if c[0] != f and c[1] != to] + [[f, to]]
    elif t == "disconnect":
        idx = 0 if op["kind"] == "out" else 1
        state["cables"] = [c for c in cables if c[idx] != op["node"]]
    elif t == "knob":
        node = pedals.get(op["id"])
        if node:
            node["st"].setdefault("values", {})[op["control"]] = op["value"]
    elif t == "toggle":
        node = pedals.get(op["id"])
        if node:
            node["st"].setdefault("switches", {})[op["sw"]] = op["on"]
    elif t == "bypass":
        node = pedals.get(op["id"])
        if node:
            node["st"]["on"] = op["on"]
    elif t == "volume":
        node = posts.get(op["id"])
        if node:
            node["st"]["volume"] = op["value"]
    elif t == "tone":
        node = posts.get(op["id"])
        if node and isinstance(op.get("patch"), dict):
            node["st"].update(op["patch"])
    elif t == "bpm":  # the room-wide transport clock
        state["bpm"] = op["value"]
    else:
        raise ValueError(f"unknown op type: {t!r}")


class Client:
    def __init__(self, player_id, name, color, conn):
        self.player_id = player_id
        self.name = name
        self.color = color
        self.conn = conn
        self.send_lock = threading.Lock()
        self.dead = False

    def send(self, obj):
        if self.dead:
            return False
        try:
            ws_send(self.conn, self.send_lock, json.dumps(obj).encode())
            return True
        except OSError:
            self.dead = True
            return False


class Room:
    def __init__(self, code, state=None, created=None):
        self.code = code
        self.state = state or empty_state()
        self.created = created or time.time()
        self.lock = threading.Lock()
        self.save_lock = threading.Lock()
        self.clients = []
        self.dirty = False

    # Relay order must match canonical apply order, so sends happen under
    # room.lock (lock order is always room.lock -> send_lock, never reversed).
    # Callers that already hold the lock pass locked=True.
    def broadcast(self, obj, exclude=None, locked=False):
        if locked:
            self._bcast(obj, exclude)
        else:
            with self.lock:
                self._bcast(obj, exclude)

    def _bcast(self, obj, exclude):
        dead = [c for c in self.clients if c is not exclude and not c.send(obj)]
        for c in dead:  # failed sends leave the room immediately
            self.clients.remove(c)
            c.dead = True

    def drop(self, client):
        with self.lock:
            if client not in self.clients:
                return False
            self.clients.remove(client)
        client.dead = True
        return True

    def path(self):
        return ROOMS_DIR / f"{self.code}.json"

    def save(self):
        with self.lock:
            doc = {"code": self.code, "created": self.created, "state": self.state}
            data = json.dumps(doc, indent=1)
            self.dirty = False
        with self.save_lock:  # concurrent saves share one .tmp path
            ROOMS_DIR.mkdir(exist_ok=True)
            tmp = self.path().with_suffix(".tmp")
            tmp.write_text(data)
            tmp.replace(self.path())


ROOMS = {}
ROOMS_LOCK = threading.Lock()


def valid_code(code):
    return bool(re.fullmatch(f"[{CODE_ALPHABET}]{{5}}", code or ""))


def get_room(code, create=False):
    code = str(code or "").upper()
    if not valid_code(code):
        return None
    with ROOMS_LOCK:
        room = ROOMS.get(code)
        if room:
            return room
        path = ROOMS_DIR / f"{code}.json"
        if path.exists():
            try:
                doc = json.loads(path.read_text())
                room = Room(code, doc.get("state") or empty_state(), doc.get("created"))
            except Exception as exc:
                print(f"[room] corrupt {path.name} ({exc}) — starting fresh")
                room = Room(code)
        elif create:
            room = Room(code)
        else:
            return None
        ROOMS[code] = room
    if create:
        room.save()
    return room


def new_room():
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(5))
        with ROOMS_LOCK:
            exists = code in ROOMS or (ROOMS_DIR / f"{code}.json").exists()
        if not exists:
            return get_room(code, create=True)


def room_saver():
    """Flush dirty rooms to disk every couple of seconds (knob drags are chatty)."""
    while True:
        time.sleep(2)
        with ROOMS_LOCK:
            rooms = list(ROOMS.values())
        for room in rooms:
            if room.dirty:
                try:
                    room.save()
                except OSError as exc:
                    print(f"[room] save failed for {room.code}: {exc}")


# --- WebSocket framing (RFC 6455, the parts browsers actually use) ----------

def ws_send(conn, lock, payload, opcode=0x1):
    ln = len(payload)
    if ln < 126:
        header = struct.pack("!BB", 0x80 | opcode, ln)
    elif ln < 65536:
        header = struct.pack("!BBH", 0x80 | opcode, 126, ln)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 127, ln)
    with lock:
        conn.sendall(header + payload)


def read_exact(rfile, n):
    data = b""
    while len(data) < n:
        chunk = rfile.read(n - len(data))
        if not chunk:
            raise ConnectionError("socket closed")
        data += chunk
    return data


def ws_read_frame(rfile):
    b1, b2 = read_exact(rfile, 2)
    fin, opcode = b1 & 0x80, b1 & 0x0F
    masked, ln = b2 & 0x80, b2 & 0x7F
    if ln == 126:
        ln = struct.unpack("!H", read_exact(rfile, 2))[0]
    elif ln == 127:
        ln = struct.unpack("!Q", read_exact(rfile, 8))[0]
    if ln > MAX_WS_MESSAGE:
        raise ConnectionError(f"frame too large ({ln} bytes)")
    mask = read_exact(rfile, 4) if masked else None
    data = read_exact(rfile, ln) if ln else b""
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return fin, opcode, data


def ws_read_message(rfile):
    """One complete message; transparently answers nothing (pings are handled
    by the caller so it can write). Returns (opcode, bytes) or (0x8, b'')."""
    opcode0, buf = None, b""
    while True:
        fin, opcode, data = ws_read_frame(rfile)
        if opcode in (0x8, 0x9, 0xA):  # close / ping / pong pass through
            return opcode, data
        if opcode0 is None:
            opcode0 = opcode
        buf += data
        if len(buf) > MAX_WS_MESSAGE:
            raise ConnectionError("message too large")
        if fin:
            return opcode0, buf


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True  # ops must not sit in Nagle buffers

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Dev server: never let a browser keep serving yesterday's app code
        # from cache. Editing a file and reloading must always show the edit.
        if self.path.split("?")[0].endswith((".js", ".html", ".css", "/")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/ws":
            return self.handle_websocket()
        if route == "/room/check":
            q = parse_qs(urlparse(self.path).query)
            room = get_room((q.get("code") or [""])[0])
            if not room:
                return self._json(404, {"error": "no such bakery"})
            with room.lock:
                players = [{"name": c.name, "color": c.color} for c in room.clients]
                pedals = len(room.state["pedals"])
            return self._json(200, {"code": room.code, "players": players, "pedals": pedals})
        if route != "/specs":
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

    # -------------------------------------------------- websocket sessions --

    def handle_websocket(self):
        q = parse_qs(urlparse(self.path).query)
        param = lambda k, d="": (q.get(k) or [d])[0]
        room = get_room(param("code"))
        key = self.headers.get("Sec-WebSocket-Key")
        if "websocket" not in self.headers.get("Upgrade", "").lower() or not key:
            return self.send_error(400, "expected a WebSocket upgrade")

        accept = base64.b64encode(
            hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True

        player_id = re.sub(r"[^a-zA-Z0-9_-]", "", param("player"))[:24]
        name = param("name").strip()[:24] or "player"
        if not room or not player_id:
            lock = threading.Lock()
            reason = "no such bakery" if player_id else "missing player id"
            try:
                ws_send(self.connection, lock, json.dumps(
                    {"t": "error", "error": reason}).encode())
                ws_send(self.connection, lock, b"", opcode=0x8)
            except OSError:
                pass
            return

        with room.lock:
            # a reconnecting player replaces their stale connection; tell the
            # old socket why it died so a duplicated tab can mint a fresh id
            # instead of the two tabs evicting each other forever
            stale = [c for c in room.clients if c.player_id == player_id]
            for c in stale:
                room.clients.remove(c)
                c.dead = True
                try:
                    ws_send(c.conn, c.send_lock, json.dumps(
                        {"t": "error", "error": "taken over — player id connected elsewhere"}).encode())
                    c.conn.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            used = {c.color for c in room.clients}
            color = next((c for c in PLAYER_COLORS if c not in used), PLAYER_COLORS[0])
            client = Client(player_id, name, color, self.connection)
            room.clients.append(client)
            others = [{"id": c.player_id, "name": c.name, "color": c.color}
                      for c in room.clients if c is not client]
            snapshot = json.dumps({
                "t": "welcome", "code": room.code,
                "you": {"id": player_id, "name": name, "color": color},
                "players": others, "state": room.state,
            })
            # welcome + join go out under the same lock hold that registered
            # us, so no relayed op can ever reach this socket before its
            # snapshot, and join ordering matches op ordering for everyone
            try:
                ws_send(self.connection, client.send_lock, snapshot.encode())
            except OSError:
                room.clients.remove(client)
                client.dead = True
                return
            room.broadcast({"t": "join", "player":
                            {"id": player_id, "name": name, "color": color}},
                           exclude=client, locked=True)
        print(f"[room {room.code}] {name} ({player_id}) joined "
              f"({len(room.clients)} online)")

        self.connection.settimeout(75)
        pinged = False
        try:
            while not client.dead:
                try:
                    opcode, data = ws_read_message(self.rfile)
                except socket.timeout:
                    if pinged:  # two silent windows -> gone
                        break
                    ws_send(self.connection, client.send_lock, b"", opcode=0x9)
                    pinged = True
                    # a timeout latches SocketIO._timeout_occurred; clear it
                    # or every later rfile read raises OSError instantly and
                    # the browser's answering pong can never rescue the peer
                    raw = getattr(self.rfile, "raw", None)
                    if raw is not None:
                        raw._timeout_occurred = False
                    continue
                pinged = False
                if opcode == 0x8:
                    break
                if opcode == 0x9:  # ping -> pong
                    ws_send(self.connection, client.send_lock, data, opcode=0xA)
                    continue
                if opcode != 0x1:  # pong / binary -> ignore
                    continue
                try:
                    msg = json.loads(data)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue  # "5" and [1] are valid JSON but not messages
                self.handle_ws_message(room, client, msg)
        except (ConnectionError, OSError):
            pass
        finally:
            if room.drop(client):
                room.broadcast({"t": "leave", "player": player_id})
                if room.dirty:
                    try:
                        room.save()
                    except OSError:
                        pass
            print(f"[room {room.code}] {name} left ({len(room.clients)} online)")

    def handle_ws_message(self, room, client, msg):
        t = msg.get("t")
        if t == "op":
            op = msg.get("op") or {}
            try:
                with room.lock:
                    apply_op(room.state, op)
                    room.dirty = True
                    # relayed inside the same lock hold as the apply: every
                    # client receives ops in exactly canonical order
                    room.broadcast({"t": "op", "op": op, "from": client.player_id},
                                   exclude=client, locked=True)
            except Exception as exc:
                print(f"[room {room.code}] bad op from {client.name}: {exc}")
        elif t == "pos":
            room.broadcast({"t": "pos", "player": client.player_id,
                            "x": msg.get("x"), "z": msg.get("z"),
                            "cx": msg.get("cx"), "cz": msg.get("cz")},
                           exclude=client)
        elif t == "shelf":  # someone baked — everyone refreshes the shelf
            room.broadcast({"t": "shelf"}, exclude=client)
        # heartbeats and unknown types need no reply

    def do_POST(self):
        if self.path == "/room":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length:
                    self.rfile.read(length)
                room = new_room()
                print(f"[room {room.code}] created")
                self._json(200, {"code": room.code})
            except Exception as exc:
                self._json(500, {"error": str(exc)[:300]})
            return
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
    threading.Thread(target=room_saver, daemon=True).start()
    print(f"Pedal Bakery on http://localhost:{PORT} (serving {ROOT})")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
