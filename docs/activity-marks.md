# Aiden activity marks

Aiden shows agent activity with small vector **activity marks**. They replaced the `thinking-orbs` canvas animations on desktop, iOS and Android. This file is the single source of truth for their geometry and timing. Each platform draws the same marks natively:

| Platform | Implementation | Engine |
|---|---|---|
| Desktop | `renderer/components/aiden-activity-mark.tsx` + `.aiden-mark` rules in `renderer/styles.css` | Inline SVG, CSS keyframes on `transform` / `opacity` |
| iOS | `ios/AidenOnTheGo/Features/Shared/ActivityMarks/` | `CAShapeLayer`s driven by `CAKeyframeAnimation` (render server, no per-frame main-thread work) |
| Android | `android/.../features/shared/activitymarks/` | Compose `Canvas`, a frame clock read only in the draw phase (no recomposition per frame) |

The interactive gallery that the set was chosen from is `docs/aiden-thinking-animations.html`.

## Rules

- **Cheap by construction.** At most 11 shapes per mark. Animate only translation, rotation, scale and opacity. No blur, filters, masks, gradients or per-frame allocation.
- **Ink.** Draw in a single ink colour. Chat and transcript marks use the foreground/text colour. Desktop Live uses the accent colour.
- **Still pose.** When a mark is inactive (terminal subagent, idle Live), when Reduced Motion is on (the system setting *or* the in-app preference), or when it is off-screen, freeze it on its pose at `t = 0`. Never hide a mark in place of animating it.
- **Same names everywhere.** `tri-step`, `quad-shuffle`, `compose`, `scan-grid`, `glance`, `bounce`, `helix-calm`, `helix-twist`, `helix-swell`, `helix-duplex`, `helix-flat`.

## Coordinate system and timing model

- Every mark is drawn in a **24 × 24 view box** and scaled uniformly to the rendered size (20 pt/dp inline, 16 for compact tool rows, 64 for Live). Lengths below are view-box units.
- A *track* animates one property of one shape (or group). It has a duration `D`, a delay `d` (usually negative), and keyframes `(offset, value)` with offsets in `[0, 1]`.
- Local time for a track at clock time `t` is `u = ((t − d) mod D) / D`. Find the keyframe segment containing `u`, normalise progress within it, apply that segment's easing, and interpolate linearly between the two values. Equal neighbouring values mean a hold.
- Unless a keyframe says otherwise, a track uses one easing for every segment.
- Transforms compose as: translate, then rotate, then scale, all about the stated origin. "About centre" means the shape's own bounding-box centre.

### Easings (CSS cubic-bezier control points)

| Name | x1, y1, x2, y2 |
|---|---|
| `turn` | 0.5, −0.45, 0.25, 1.45 (overshoots both ends on purpose) |
| `shuffle` | 0.65, 0, 0.35, 1 |
| `compose` | 0.4, 0, 0.2, 1 |
| `inOut` | 0.42, 0, 0.58, 1 (CSS `ease-in-out`) |
| `look` | 0.5, 0, 0.3, 1 |
| `bounce` | 0.45, 0, 0.55, 1 |

## Marks

### `tri-step` (thinking)

- Shapes: three circles, r = 2.6, at (12, 5.5), (17.63, 15.25) and (6.37, 15.25), inside one group.
- Group rotation about (12, 12), D = 2.7 s, d = 0, easing `turn`:

| offset | 0 | 0.22 | 0.3333 | 0.5533 | 0.6666 | 0.8866 | 1 |
|---|---|---|---|---|---|---|---|
| degrees | 0 | 120 | 120 | 240 | 240 | 360 | 360 |

### `quad-shuffle` (working: tool calls)

- Shapes: four circles, r = 2.4. Each has a home position, a "diagonal" offset `a`, and a "corner" offset `b`:

| circle | home (cx, cy) | a (dx, dy) | b (dx, dy) |
|---|---|---|---|
| top-left | (7, 7) | (−2.2, −2.2) | (10, 0) |
| top-right | (17, 7) | (−7.4, 2.6) | (0, 10) |
| bottom-left | (7, 17) | (7.4, −2.6) | (0, −10) |
| bottom-right | (17, 17) | (2.2, 2.2) | (−10, 0) |

- Translation, D = 2.6 s, d = 0, easing `shuffle`. Keyframes: 0 → (0,0); 0.18 → a; 0.36 → (0,0); 0.56 → b; 0.72 → b; 0.90 → (0,0); 1 → (0,0).

### `compose` (responding)

- Shapes: three rounded rects, height 2.6, corner radius 1.3, x = 4: (y 5.5, width 16), (y 10.7, width 12), (y 15.9, width 14). Index i = 0, 1, 2.
- Horizontal scale about the rect's **left-centre**, plus opacity. D = 2.2 s, d = i × 0.16 s − 1.1 s, easing `compose`:

| offset | 0 | 0.35 | 0.70 | 1 |
|---|---|---|---|---|
| scaleX | 0.16 | 1 | 1 | 0.16 |
| opacity | 0.35 | 1 | 1 | 0.35 |

### `scan-grid` (searching, visualizing)

- Shapes: a 3 × 3 grid of circles, r = 1.9, at x, y ∈ {6, 12, 18}. The column index (0, 1, 2) is i.
- Uniform scale about centre, plus opacity. D = 1.5 s, d = i × 0.18 s − 0.45 s (so the frozen t = 0 pose shows the first column lit), easing `inOut`:

| offset | 0 | 0.30 | 0.70 | 1 |
|---|---|---|---|---|
| scale | 1 | 1.18 | 1 | 1 |
| opacity | 0.2 | 1 | 0.2 | 0.2 |

### `glance` (waiting for approval or an answer)

- Shapes: two rounded rects ("eyes"), 3.4 × 7, corner radius 1.7, at x = 7 and x = 13.6, y = 8.5, inside one group.
- Group translateX, D = 4 s, d = 0, easing `look`: 0 → 0; 0.14 → 0; 0.24 → −2.6; 0.40 → −2.6; 0.52 → 2.6; 0.68 → 2.6; 0.80 → 0; 1 → 0.
- Each eye's scaleY about centre (a blink), D = 4 s, d = 0, easing `inOut`: 0 → 1; 0.86 → 1; 0.90 → 0.1; 0.94 → 1; 1 → 1.

### `bounce` (preparing, model loading, stopping, queued subagents)

- Shapes: three circles, r = 2.4, at (5.5, 13), (12, 13), (18.5, 13). Index i = 0, 1, 2.
- translateY, D = 1.2 s, d = i × 0.13 s, easing `bounce`: 0 → 0; 0.27 → −5; 0.55 → 0; 1 → 0.

### Helix family (Live)

- Shapes: two strands of five circles, r = 1.8, at x ∈ {4, 8, 12, 16, 20}, y = 12. Column index i = 0…4. Strand **a** has phase `ph = 0` and strand **b** has `ph = 0.5`. Draw strand b first, so strand a passes over it.
- Each circle has two tracks with the same duration `D` and easing `inOut`. With `dᵢ = −(i × step) − ph × D`:
  - **Position:** translateY, delay `dᵢ`. 0 → −amp; 0.5 → +amp; 1 → −amp.
  - **Depth:** scale about centre and opacity, delay `dᵢ + D/4`. 0 → (zf, 1); 0.5 → (zb, ob); 1 → (zf, 1).

| mark | used for | amp | D | step | zf | zb | ob | extra |
|---|---|---|---|---|---|---|---|---|
| `helix-calm` | Live ready (frozen) | 3.4 | 3.6 s | 0.3 s | 1.12 | 0.78 | 0.5 | Shown inactive, so it rests on its t = 0 pose |
| `helix-twist` | Live connecting | 5 | 1.5 s | 0.375 s | 1.3 | 0.55 | 0.3 | Full twist across the width |
| `helix-swell` | Live listening | 3 | 1.6 s | 0.2 s | 1.3 | 0.6 | 0.35 | Second wave, below |
| `helix-duplex` | Live thinking / speaking / acting | 5 | 2 s | 0.2 s | 1.3 | 0.6 | 0.35 | Each strand-b circle is filled at 55% ink (per circle, like SVG `fill-opacity`, not a group fade) |
| `helix-flat` | Live error / unavailable | 0 | — | — | 1 | 1 | 1 | No animation. The whole mark is composited once at 45% opacity, so the overlapping strands don't darken |

- **Swell second wave:** an extra translateY added on top of the position track. It is not scaled by depth: desktop puts it on a wrapper `<g>`, iOS uses an additive animation, and Android adds it in the draw pass. D = 2.3 s, d = i × −0.45 s, easing `inOut`: 0 → −amp2; 0.5 → +amp2; 1 → −amp2. `amp2 = 3` by default. With a 0–1 voice level, `amp2 = 1 + 4 × level` (desktop rounds the level to five steps so it can stay in CSS).

## Phase mapping

| Activity | Mark |
|---|---|
| Thinking (no visible output yet) | `tri-step` |
| Responding (text streaming) | `compose` |
| Working (a tool is running) | `quad-shuffle` |
| Searching (find, glob, grep, list, read or search tools) | `scan-grid` |
| Visualizing (`render_artifact`) | `scan-grid` |
| Preparing / queued / model loading / stopping | `bounce` |
| Waiting for approval or an answer | `glance` |
| Subagent: queued or starting | `bounce` |
| Subagent: needs attention | `glance` |
| Subagent: running | from its activity: searching → `scan-grid`, reviewing context → `tri-step`, writing a report → `compose`, otherwise by role (scout `scan-grid`, planner `tri-step`, others `quad-shuffle`) |
| Subagent: finished, failed or stopped | same mark, frozen |
| Live | Helix family as tabled above; approval uses `glance` |
