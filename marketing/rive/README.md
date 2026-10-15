# Aiden character — Rive marketing assets

A vector rebuild of the app-icon ghost as one Rive rig, plus rendered exports.

## Layout

| Path | What |
|---|---|
| `aiden/` | Rive CLI project (`scene.rml` is generated — don't hand-edit) |
| `tools/build_scene.py` | Source of truth: art, timelines, state machine, view model |
| `tools/render.py` | Renders clips and stills into `exports/` |
| `exports/aiden.riv` | The interactive file for web / in-app (pure RML, no scripts, so no signing needed) |
| `exports/transparent/` | `*.webm` VP9 with alpha (web); `*.mov` ProRes 4444 with alpha for Keynote/Final Cut/Premiere/After Effects (local only, ~50 MB each) |
| `exports/square/` | 1080×1080 H.264 on the navy backdrop (social) |
| `exports/wide/` | 1920×1080 H.264 on the navy backdrop (launch videos, App Store previews) |
| `exports/gif/` | 540px, 30fps looping GIFs |
| `exports/stills/` | 2160px transparent PNG poses |
| `exports/frames/` | 1080px transparent PNG sequences, 60fps, for compositing (local only) |

The ProRes masters, the frame sequences, and `.render/` are gitignored; run `render.py` to regenerate them. CI ignores `marketing/` entirely (`scripts/ci-changes.mjs`), and pushes to `main` that change only this folder do not cut a release.

Every clip is a seamless loop: `hello` (wave, then float), `idle`, `thinking`, `celebrate`, `lookaround`.

## The rig's controls

Artboard `Aiden` (1080×1080), state machine `Aiden`, view model `Aiden`:

| Property | Type | Effect |
|---|---|---|
| `mood` | enum `idle` / `thinking` / `celebrate` | Switches the body animation with a 350ms blend |
| `wave` | trigger | One wave of the right arm (layers over any mood) |
| `showBackground` | boolean, default `false` | Fades in the navy gradient backdrop; off = transparent |
| `hover` | boolean | Set by the rig itself. While the pointer is over the body, it keeps waving |

Always on: a floating bob and a blink cycle. Pointer movement anywhere on the artboard turns the face and leans the body toward the cursor (Joystick + `ListenerAlignTarget`, no scripts).

Web sketch (`@rive-app/canvas`; this snippet has not been tested):

```js
const r = new rive.Rive({
  src: "aiden.riv", canvas, stateMachines: "Aiden", autoplay: true, autoBind: true,
  onLoad: () => {
    r.resizeDrawingSurfaceToCanvas();
    const vm = r.viewModelInstance;
    vm.enum("mood").value = "thinking";
    vm.boolean("showBackground").value = true;
    vm.trigger("wave").trigger();
  },
});
```

## Rebuilding

```bash
python3 marketing/rive/tools/build_scene.py      # regenerate scene.rml
rive marketing/rive/aiden                        # live preview window (hover and move the mouse)
python3 marketing/rive/tools/render.py           # every clip + stills + aiden.riv (~2.5 min)
python3 marketing/rive/tools/render.py celebrate # one clip
python3 marketing/rive/tools/render.py --stills
python3 marketing/rive/tools/render.py --encode-only   # re-encode from exports/frames
```

Requires the `rive` CLI, `ffmpeg`, and Pillow.

The CLI only captures over an opaque background, so `render.py` makes transparency by **difference matting**. It renders every frame twice, over black and over white, using render-only copies of the scene in `.render/`. Then ffmpeg solves `alpha = 255 − (white − black)` and `colour = black / alpha`. Soft edges, the shadow, and the fading rim light keep their true colour and alpha.

To get a `.rev` that opens in the Rive editor, run `rive login` and then `rive marketing/rive/aiden --once --rev=aiden.rev`.
