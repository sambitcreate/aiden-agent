# Design mode P3: Aiden on the canvas

Status: in progress, 2026-11-05. P3a, P3b and P3c done. Spec: [design mode §6](../specs/2026-10-31-design-mode-design.md#6-aiden-on-the-canvas). Branch: `claude/project-thread-29fzrr` (PR #778), on top of P0–P2.

**Goal:** in a chat with design mode on, Aiden can see the canvas, put its own designs on it, and tidy them, without the person adding frames by hand.

**Constraints:**
- Everything stays behind `AIDEN_EXPERIMENTAL_DESIGN_MODE`.
- Canvas tools exist only for attended desktop turns in a chat whose `designMode` is on, with a workspace folder. Remote, Telegram, Bot, Assistant, CLI and unattended turns never get them.
- No new network access.
- The canvas document stays main-owned. Aiden's edits go through `DesignCanvasStore.update` and are broadcast on `designCanvas:updated`, so the renderer's existing remote-refetch path shows them.

## Slices

Each slice lands as its own commit set with behavioral tests. Screenshots are needed before approval for any slice that changes the UI.

### P3a: canvas tools (no new UI)

1. Move `placeFrame`, `DESIGN_FRAME_GAP` and the clamps out of `renderer/design/canvas-adapter-core.ts` into the pure `renderer/shared/design-canvas/placement.ts`, so main can import them. The adapter re-exports them, so the renderer is unchanged.
2. `renderer/shared/design-canvas/canvas-summary.ts` (pure):
   - `describeCanvas(doc, view)` builds the `canvas_read` answer: the viewport, the frames in view (kind, title, path, box, group, open comment count), groups outside the view summarized as counts, and the totals.
   - `canvasPromptLine(doc)` builds the one-line summary for the prompt.
3. `main/services/design-canvas/canvas-tools.ts` adds four tools:
   - `canvas_read` (replay safe).
   - `canvas_place_frame` (`file | image | note | group`). File and image paths must already exist and resolve inside the workspace through `resolveDesignFile`. File frames default to 1280 design width and a 640 × 436 box.
   - `canvas_update_frame` (move, resize, retitle, regroup, note text).
   - `canvas_remove_frame`. A person's frame needs `confirm: true`.
   - The tools allow at most 20 calls per turn, then return `limit_reached`. Coordinates are canvas units.
   - The tools are created with `createDesignCanvasTools({ chatId, workspaceRoot, store, broadcast })`.
4. Wiring in `llm-client.ts`: offer the tools when the flag is on, the chat has `designMode`, and the owner is a local renderer (not remote). Exclude Bot, Assistant-unattended, Telegram and `excludeToolNames`. Add a short, static "Design mode is on" system prompt section, and put `canvasPromptLine` in the volatile prompt slot so a changing canvas never breaks the prompt cache. Both arrive as the `aiden.design-canvas` runtime extension.
5. Tests:
   - The placement cases stay in the adapter suite, which reaches `placeFrame` through its re-export.
   - A summary suite.
   - A tools suite against a real `DesignCanvasStore` in a temp folder: place, update, remove, the person-frame guard, path containment (traversal, missing file, symlink escape), the per-turn limit, and the broadcast on every change.
   - A gating test for the wiring predicate.

### P3b: visuals become artifact frames

While design mode is on, each `render_artifact` result is placed as an `artifact` frame, keyed by `mediaId`. Placing the same title again replaces the frame's media and keeps its position. Tests cover first placement, a same-title replacement, and design mode off (nothing placed).

As built: frames are placed after the turn's artifacts are committed, so a failed turn never leaves a frame pointing at a discarded visual. Only frames Aiden placed are swapped by title; a person's frame with the same title is left alone. The placement runs only in a turn that got the canvas tools (the same `designCanvasToolsAllowed` gate) and re-checks that design mode is still on. The canvas's artifact frame reloads when its media changes.

### P3c: the `aiden-design` skill

This is a built-in desktop skill, kept beside `AIDEN_ARTIFACTS_SKILL`, and dropped with `withoutSkills` on Remote, Telegram and Bots. It tells Aiden to:
- write self-contained HTML under `design/` with no network;
- use `aiden-design:` library paths;
- stamp elements with `data-aiden-src` and keep `data-aiden-comment` IDs;
- place each file with `canvas_place_frame`, with at most 3 directions per request, each in its own group;
- make small edits;
- say which file changed.

The prompt section points to the skill.

As built: the skill is registered only while `AIDEN_EXPERIMENTAL_DESIGN_MODE` is on, and a turn keeps it only when it also gets the canvas tools (one `designCanvasOffered` decision). Library paths are root-relative (`/__aiden/lib/<name>`), so they resolve under each page's own grant. A test checks that every canvas tool and library the skill names really exists.

### P3d: `design_mode` tool, consent card and `canvas_focus` (UI)

- `design_mode {action, reason}` follows the `aiden_open` request/acknowledge pattern.
  - `enter` shows an in-chat card with **Enter design mode** and **Not now**.
  - `exit` needs no consent.
  - The tool is offered only when Inline visuals is `automatic`.
- `canvas_focus` asks the renderer to fit frames, and is skipped while the person is interacting with the canvas.
- `canvas_read {snapshot: true}` attaches a downscaled capture of the canvas region through the renderer.
- Card states get light and dark screenshots, and the E2E extends `design-mode.spec.ts`.

## Deferred to P4 and P5

The following stay out of P3:
- comments, picking and draw marks (P4);
- analytics events, the onboarding tile, docs and the default-on flip (P5);
- the four P2 minors in `.memory/design-mode.md`.
