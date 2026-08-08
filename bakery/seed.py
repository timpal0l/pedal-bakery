#!/usr/bin/env python3
"""Seed the Pedal Bakery with a starting library of sound objects.

Fires curated descriptions at the running bakery server (which bakes each
one with claude -p and saves it to specs/). Cache hits are skipped for
free, so re-running only bakes what's missing.

Usage: python3 bakery/seed.py [--workers 4]
"""

import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BAKE_URL = "http://localhost:8123/bake"

DESCRIPTIONS = [
    # --- amps ---------------------------------------------------------------
    "a sparkling clean american amp with endless headroom and glassy top",
    "a british invasion combo amp, chimey and jangly with bite when pushed",
    "a huge full stack amp for arena metal, tight lows and scooped mids",
    "a tiny bedroom practice amp, warm and boxy with cute breakup",
    "a vintage tweed amp that breaks up sweetly when you dig in",
    "a jazz combo amp, dark round and utterly clean",
    "a doom stack amp with a huge low end that rattles the walls",
    "a garage rock amp, raw and slightly broken sounding",
    "a surf amp with drippy spring reverb built in and shimmering cleans",
    "a bass amp that growls, deep and punchy with grindy mids",
    "an ancient supro-style amp with a torn speaker rasp",
    "a boutique class-A amp with harmonic sparkle and touch sensitivity",
    # --- drive family --------------------------------------------------------
    "a smooth tube overdrive with a mid hump, the classic green pedal sound",
    "a transparent overdrive that just makes everything better",
    "a big fluffy fuzz with endless sustain, the wall of doom",
    "a spitty velcro fuzz that gates and sputters",
    "a sharp rodent distortion with a filthy midrange snarl",
    "a treble booster for pushing amps into singing leads",
    "a clean boost with tons of headroom for solos",
    "an octave-flavored fuzz that screams in the upper registers",
    "a bass fuzz that keeps the low end intact while shredding the top",
    "a soft vintage germanium fuzz, warm and woolly",
    "a modern high gain metal distortion, tight and percussive",
    "a broken transistor radio distortion, lofi and crumbly",
    # --- delay family --------------------------------------------------------
    "a warm analog delay with dark decaying repeats",
    "a pristine digital delay with crystal clear repeats",
    "a tape echo with wobbly worn-out repeats that get darker as they fade",
    "a slapback delay for rockabilly twang",
    "a self-oscillating dub delay that spirals into chaos",
    "a rhythmic multi-tap style echo for ambient patterns",
    "a lofi delay with crushed and filtered repeats",
    "a shimmering delay that blooms into a wash of echoes",
    # --- reverb family -------------------------------------------------------
    "a drippy spring reverb like an old amp tank",
    "a huge cathedral reverb with a tail that lasts forever",
    "a small room reverb, subtle and natural",
    "a plate reverb, smooth and dense like a studio classic",
    "a shimmer reverb that sounds like an angel choir behind you",
    "a haunted reverb that swells and breathes like a ghost",
    "an infinite freeze reverb that sustains like an organ pad",
    "a gated reverb, huge then suddenly gone, very 80s drums energy",
    # --- modulation family ---------------------------------------------------
    "a lush 80s analog chorus, wide and dreamy",
    "a seasick vibrato that warbles like a broken tape deck",
    "a slow underwater flanger with deep metallic sweeps",
    "a jet plane flanger, dramatic and whooshy",
    "a warm vintage phaser with a slow syrupy swirl",
    "a fast bubbly phaser like a leslie cabinet spinning",
    "a smooth optical tremolo like an old brownface amp",
    "a hard chopping helicopter tremolo",
    "a rotary speaker swirl, doppler and all",
    "a random warbling pitch wobble like a dying walkman",
    # --- eq and dynamics -----------------------------------------------------
    "a surgical 3-band eq pedal for sculpting the perfect tone",
    "a bass-boosting eq that adds thump without mud",
    "a treble-taming eq for harsh amps, smooth and dark",
    "a mid-scoop eq for that djent chug shape",
    "a telephone eq that makes everything tiny and nasal",
    "a studio compressor that glues everything together",
    "a squishy chicken-pickin compressor with sharp attack",
    "an always-on sustainer that makes notes bloom forever",
    "a limiter that slams everything flat, brutal and loud",
    # --- weird and experimental ----------------------------------------------
    "a ring modulator that turns guitar into robot bells",
    "an alien transmission pedal, metallic sidebands and static",
    "a broken church organ underwater, slow and haunted",
    "a pedal that sounds like neon lights buzzing in the rain",
    "a cosmic drone machine for ambient soundscapes",
    "an 8-bit video game console pedal, blippy and crushed",
    "a pedal that makes guitar sound like a cello section",
    "a haunted music box, delicate and detuned",
    "a swarm of angry bees with a stinger boost switch",
    "a submarine sonar pedal with pinging echoes",
    "a pedal that sounds like winter, cold glassy and still",
    "a lava lamp in pedal form, slow blobby and warm",
    "a rusty machine factory rhythm pedal, industrial clank",
    "a pedal that sounds like a dial-up modem falling in love",
    "a black hole pedal that swallows the note then spits it back",
    "a glass harmonica shimmer, fragile and pure",
    # --- genre boxes ---------------------------------------------------------
    "the ultimate stoner rock fuzz rig in one pedal",
    "a black metal wall of icy tremolo and reverb",
    "a death metal chug machine, percussive and evil",
    "a reggae dub station with deep echoes and filtered skanks",
    "a funk machine with auto filter quack and tight compression",
    "a country twang box, bright compressed and snappy",
    "a shoegaze dream machine, fuzz drowned in reverb",
    "a post-rock swell pedal that builds cathedrals of sound",
    "a psychedelic 60s swirl, phasey fuzzy and backwards-feeling",
    "a grunge plaid-flannel distortion, thick and sarcastic",
    "a synthwave pedal, neon chorus over glassy compression",
    "a blues junior companion, warm drive with singing sustain",
    "a jazz fusion smooth machine, clean compression and subtle chorus",
    "a punk rock buzzsaw, all downstrokes and attitude",
    "an ambient texture generator for film scores",
    "a desert blues pedal, dusty hypnotic and warm",
    # --- utility-ish ---------------------------------------------------------
    "a volume swell pedal for violin-like fade-ins",
    "a subtle always-on tone sweetener",
    "a low end fattener that adds octave weight",
    "a presence lifter that helps solos cut through the mix",
    "a noise sculptor that turns hiss into texture",
    "a warm tape saturation box, gentle glue and grit",
    "a stereo widener that makes everything huge",
    "a vintage console preamp color box",
]


def bake(desc):
    body = json.dumps({"description": desc}).encode()
    req = urllib.request.Request(BAKE_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.loads(r.read())
        spec = data["spec"]
        tag = "cache" if data.get("cached") else f"{time.time() - t0:4.0f}s"
        kind = spec.get("kind", "pedal").upper()
        print(f"  [{tag:>5}] {kind:<5} {spec['name']:<24} <- {desc[:52]}", flush=True)
        return True
    except Exception as exc:
        print(f"  [FAIL ] {desc[:52]} :: {exc}", flush=True)
        return False


if __name__ == "__main__":
    workers = 4
    if "--workers" in sys.argv:
        workers = int(sys.argv[sys.argv.index("--workers") + 1])
    print(f"Seeding {len(DESCRIPTIONS)} sound objects with {workers} workers…", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(bake, DESCRIPTIONS))
    ok = sum(results)
    print(f"\nDone: {ok}/{len(DESCRIPTIONS)} baked in {(time.time() - t0) / 60:.1f} min", flush=True)
