#!/usr/bin/env python3
"""Render the Aiden character clips and stills to marketing/rive/exports/.

    python3 marketing/rive/tools/render.py               # everything
    python3 marketing/rive/tools/render.py hello idle    # just these clips
    python3 marketing/rive/tools/render.py --stills      # just the stills
    python3 marketing/rive/tools/render.py --encode-only # re-encode from exports/frames

Needs: rive CLI, ffmpeg, Pillow.

The rive CLI captures on an opaque clear colour, so transparency is recovered
by difference matting: every frame is rendered over pure black and pure white
(render-only copies of the scene with a matte plate), then ffmpeg solves
alpha = 1 - (white - black) and un-premultiplies the colour.
"""
import math
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_scene  # noqa: E402

HERE = Path(__file__).resolve().parent.parent          # marketing/rive
PROJECT = HERE / "aiden"
WORK = HERE / ".render"
EXPORTS = HERE / "exports"
FPS = 60
JOBS = 10


def lookaround_pointer(k, n):
    """One slow orbit around the character that never crosses the body."""
    t = 2 * math.pi * (k / n)
    x = 540 + 480 * math.sin(t)
    y = 560 - 430 * math.cos(t)
    return f"--pointer=move@{x:.1f},{y:.1f}"


# name: (frames, data flags, per-frame pointer fn or None)
CLIPS = {
    "hello":      (240, ["--data=wave=1"], None),
    "idle":       (240, [], None),
    "thinking":   (240, ["--data=mood=thinking"], None),
    "celebrate":  (192, ["--data=mood=celebrate"], None),
    "lookaround": (240, [], lookaround_pointer),
}

# name: (advance frames, data flags, extra args)
STILLS = {
    "hero":           (1, [], []),
    "wave":           (22, ["--data=wave=1"], []),
    "thinking":       (90, ["--data=mood=thinking"], []),
    "celebrate-jump": (38, ["--data=mood=celebrate"], []),
    "celebrate-land": (64, ["--data=mood=celebrate"], []),
    "look-left":      (4, [], ["--pointer=move@40,420"]),
    "look-right":     (4, [], ["--pointer=move@1040,420"]),
}


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, cmd))}\n{r.stdout}\n{r.stderr}")
    return r


def prepare_projects():
    for matte, color in (("black", "FF000000"), ("white", "FFFFFFFF")):
        d = WORK / matte
        d.mkdir(parents=True, exist_ok=True)
        (d / "rive.yaml").write_text(f"name: aiden-{matte}\n")
        build_scene.build(d / "scene.rml", matte=color)
        run(["rive", str(d), "--verify", "--quiet"])
    build_scene.build()  # keep the real project in sync


def shoot(project, out, advance, data, extra, viewport=None):
    cmd = ["rive", str(project), f"--screenshot={out}", "--quiet", *data]
    if viewport:
        cmd += [f"--viewport={viewport}x{viewport}", "--fit=contain"]
    if extra:
        if advance > 1:
            cmd.append(f"--advance={advance - 1}")
        cmd += extra
        cmd.append("--advance=1")
    else:
        cmd.append(f"--advance={advance}")
    run(cmd)


def matte_to_rgba(black_pattern, white_pattern, out_pattern, single=False):
    # A = over black, B = over white. alpha = 255 - (B - A); colour = A / alpha.
    graph = ("[0:v]format=gbrp,split[b1][b2];[1:v]format=gbrp,split[w1][w2];"
             "[b1][w1]blend=all_expr='clip(A*255/max(255-(B-A)\\,1)\\,0\\,255)'[c];"
             "[w2][b2]blend=all_mode=difference,extractplanes=g,negate[a];"
             "[c][a]alphamerge,format=rgba[out]")
    rate = [] if single else ["-framerate", str(FPS)]
    run(["ffmpeg", "-y", "-loglevel", "error", *rate, "-i", str(black_pattern), *rate, "-i", str(white_pattern),
         "-filter_complex", graph, "-map", "[out]", *([] if not single else ["-frames:v", "1"]), str(out_pattern)])


def backdrop(w, h):
    """The navy gradient + glow from the rig's Backdrop, at any size."""
    c0, c1, c2 = (0x00, 0x3C, 0x8A), (0x0B, 0x27, 0x68), (0x10, 0x1B, 0x53)
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            # top-right -> bottom-left
            t = ((w - x) / w + y / h) / 2
            if t < 0.55:
                u = t / 0.55
                c = tuple(round(c0[i] + (c1[i] - c0[i]) * u) for i in range(3))
            else:
                u = (t - 0.55) / 0.45
                c = tuple(round(c1[i] + (c2[i] - c1[i]) * u) for i in range(3))
            px[x, y] = c
    glow = Image.new("L", (w, h), 0)
    r = int(min(w, h) * 0.45)
    ImageDraw.Draw(glow).ellipse((w // 2 - r, int(h * 0.48) - r, w // 2 + r, int(h * 0.48) + r), fill=85)
    glow = glow.filter(ImageFilter.GaussianBlur(r * 0.45))
    img.paste(Image.new("RGB", (w, h), (0x3D, 0x6B, 0xE0)), (0, 0), glow)
    return img


def render_clip(name):
    frames, data, pointer = CLIPS[name]
    print(f"[{name}] rendering {frames} frames x 2 mattes")
    jobs = []
    for matte in ("black", "white"):
        d = WORK / "frames" / name / matte
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
        for k in range(1, frames + 1):
            extra = [pointer(k, frames)] if pointer else []
            jobs.append((WORK / matte, d / f"{k:04d}.png", k, data, extra))
    with ThreadPoolExecutor(JOBS) as pool:
        list(pool.map(lambda j: shoot(*j), jobs))

    png_dir = EXPORTS / "frames" / name
    shutil.rmtree(png_dir, ignore_errors=True)
    png_dir.mkdir(parents=True)
    src = WORK / "frames" / name
    matte_to_rgba(src / "black" / "%04d.png", src / "white" / "%04d.png", png_dir / "%04d.png")
    encode_clip(name)


def encode_clip(name):
    png_dir = EXPORTS / "frames" / name
    seq = ["-framerate", str(FPS), "-i", str(png_dir / "%04d.png")]
    ff = ["ffmpeg", "-y", "-loglevel", "error"]

    print(f"[{name}] encoding")
    # transparent masters
    run([*ff, *seq, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
         "-vendor", "apl0", str(EXPORTS / "transparent" / f"{name}.mov")])
    run([*ff, *seq, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28",
         "-row-mt", "1", "-auto-alt-ref", "0", str(EXPORTS / "transparent" / f"{name}.webm")])
    # on the brand backdrop
    bg_sq, bg_wide = WORK / "bg-1080.png", WORK / "bg-1920x1080.png"
    still = ["-framerate", str(FPS), "-loop", "1", "-i"]
    run([*ff, *still, str(bg_sq), *seq, "-filter_complex", "[0][1]overlay=shortest=1,format=yuv420p",
         "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-movflags", "+faststart",
         str(EXPORTS / "square" / f"{name}-1080.mp4")])
    run([*ff, *still, str(bg_wide), *seq, "-filter_complex", "[0][1]overlay=420:0:shortest=1,format=yuv420p",
         "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-movflags", "+faststart",
         str(EXPORTS / "wide" / f"{name}-1920x1080.mp4")])
    run([*ff, *still, str(bg_sq), *seq, "-filter_complex",
         "[0][1]overlay=shortest=1,fps=30,scale=540:-1:flags=lanczos,split[a][b];"
         "[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a",
         "-loop", "0", str(EXPORTS / "gif" / f"{name}-540.gif")])


def render_stills():
    print("[stills] rendering")
    out = EXPORTS / "stills"
    out.mkdir(parents=True, exist_ok=True)
    tmp = WORK / "stills"
    tmp.mkdir(parents=True, exist_ok=True)
    jobs = [(WORK / m, tmp / f"{n}-{m}.png", adv, data, extra, 2160)
            for n, (adv, data, extra) in STILLS.items() for m in ("black", "white")]
    with ThreadPoolExecutor(JOBS) as pool:
        list(pool.map(lambda j: shoot(*j), jobs))
    for n in STILLS:
        matte_to_rgba(tmp / f"{n}-black.png", tmp / f"{n}-white.png", out / f"aiden-{n}-2160.png", single=True)


def main(argv):
    stills_only = "--stills" in argv
    names = [a for a in argv if not a.startswith("--")] or ([] if stills_only else list(CLIPS))
    for sub in ("transparent", "square", "wide", "gif", "frames", "stills"):
        (EXPORTS / sub).mkdir(parents=True, exist_ok=True)
    prepare_projects()
    if not (WORK / "bg-1080.png").exists():
        backdrop(1080, 1080).save(WORK / "bg-1080.png")
        backdrop(1920, 1080).save(WORK / "bg-1920x1080.png")
    for n in names:
        (encode_clip if "--encode-only" in argv else render_clip)(n)
    positional = [a for a in argv if not a.startswith("--")]
    if stills_only or (not positional and "--encode-only" not in argv):
        render_stills()
    run(["rive", str(PROJECT), "--once", "--quiet"])
    shutil.copy(PROJECT / "build" / "aiden.riv", EXPORTS / "aiden.riv")
    print(f"done -> {EXPORTS}")


if __name__ == "__main__":
    main(sys.argv[1:])
