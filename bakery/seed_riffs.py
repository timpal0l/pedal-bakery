#!/usr/bin/env python3
"""Seed the riff shelf with phrases across many styles.

Usage: python3 bakery/seed_riffs.py [--workers 3]
"""
import json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = "http://localhost:8123/riff"

RIFFS = [
    "a chicago blues shuffle riff with a bent flat third and lots of swing",
    "a delta blues slide riff, loose and rolling with quarter-tone bends",
    "a rockabilly riff with walking bass and slapback-friendly staccato notes",
    "a classic hard rock power-chord riff with a pentatonic answer phrase",
    "a stoner rock riff in a slow dropped tuning, thick and hypnotic",
    "a doom metal riff with enormous space between the chords",
    "a thrash metal downpicked gallop with chromatic climbing notes",
    "a death metal tremolo riff, fast and evil, palm muted",
    "a black metal tremolo melody, icy and mournful, sixteenth notes",
    "a djent style syncopated chug riff with rests and one high accent",
    "a punk rock riff, eighth-note power chords with attitude",
    "a post-punk riff, angular and jittery with wide interval jumps",
    "a surf rock lead with fast tremolo picking and a phrygian descent",
    "a spaghetti western riff, lonely and wide with long ringing notes",
    "a reggae one-drop riff with offbeat skanks and a deep bass note",
    "a ska upstroke riff, bright and bouncy on the offbeats",
    "a dub riff with huge gaps for the echo to fill",
    "a funk riff with sixteenth ghost notes and octave pops",
    "a disco riff with octave jumps on every sixteenth",
    "a motown bassline style riff, melodic and walking",
    "a jazz bebop line with chromatic approach notes",
    "a jazz comping riff with rootless seventh chord stabs",
    "a bossa nova riff, syncopated and gentle with ninth chords",
    "a flamenco riff with rasgueado bursts and a phrygian cadence",
    "a saharan desert blues riff, hypnotic pentatonic loop with microtonal bends",
    "a tuareg style desert riff with quarter tones and a rolling triplet feel",
    "an arabic maqam hijaz riff with quarter-tone intervals",
    "a turkish saz style riff with neutral seconds and fast ornaments",
    "an indian raga inspired riff with microtonal slides and a drone root",
    "a gamelan inspired riff with stretched non-western intervals",
    "a klezmer riff in freygish with fast ornamental turns",
    "a celtic jig riff in compound time, lilting and fast",
    "a country chicken pickin riff with double stops and open strings",
    "a bluegrass flatpicking run, fast and busy with a strong downbeat",
    "a psychedelic 60s riff with a modal drone and sitar-like bends",
    "a shoegaze riff, slow chord swells drenched in space",
    "a post-rock riff, high arpeggios building over eight bars",
    "an ambient riff with just four notes and enormous decay",
    "a math rock riff in seven eight with odd accents",
    "a grunge riff, sludgy power chords with a tritone",
    "a britpop riff, jangly and major with a singalong shape",
    "an indie jangle riff with open strings ringing through the changes",
    "a slacker rock riff, laid back major seventh arpeggios behind the beat",
    "a synthwave riff, steady eighth-note octaves, neon and driving",
    "an 8-bit chiptune style riff, blippy arpeggios in sixteenths",
    "a hip hop guitar loop, sparse and hypnotic with a fat low note",
    "a trip hop riff, slow and smoky with lots of space",
    "a metalcore breakdown riff, half time and brutally simple",
    "a prog rock riff with a shifting time feel and a wide melodic leap",
    "an afrobeat guitar riff with tight syncopated single notes",
    "a highlife style riff, bright interlocking arpeggios",
    "a bolero riff, romantic and rubato with wide spacing",
    "a soul ballad riff with gospel style sixths and a slow build",
    "a garage rock riff, sloppy and loud with open fifths",
]

def bake(desc, tries=3):
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(URL, data=json.dumps({"description": desc}).encode(),
                                         headers={"Content-Type": "application/json"})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.loads(r.read())
            riff = data["riff"]
            micro = any(abs(n["s"] % 1) > 0.01 for n in riff["notes"])
            tag = "cache" if data.get("cached") else f"{time.time()-t0:4.0f}s"
            print(f"  [{tag:>5}] {riff['name']:<22} {len(riff['notes']):2d} notes"
                  f"{'  microtonal' if micro else ''}  <- {desc[:44]}", flush=True)
            return True
        except Exception as exc:
            if attempt == tries:
                print(f"  [FAIL ] {desc[:44]} :: {exc}", flush=True)
                return False
            time.sleep(4 * attempt)
    return False

if __name__ == "__main__":
    workers = 3
    if "--workers" in sys.argv:
        workers = int(sys.argv[sys.argv.index("--workers") + 1])
    print(f"Seeding {len(RIFFS)} riffs with {workers} workers…", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        ok = sum(pool.map(bake, RIFFS))
    print(f"\nDone: {ok}/{len(RIFFS)} in {(time.time()-t0)/60:.1f} min", flush=True)
