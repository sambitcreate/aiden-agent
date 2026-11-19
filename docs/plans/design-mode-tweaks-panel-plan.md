# Design mode: a DialKit-style Tweaks panel

Status: built 2026-11-18 on `claude/project-thread-m755wc`, waiting on the owner's review of the screenshots and the PR. Owner's answers: 1a, 2a, 3a + b.

Inspired by [DialKit](https://www.dialkit.dev/) and Material's parametric prototyping write-up. This is a native rebuild of the ideas inside the design canvas's Tweaks tab, not an embedded library: no new dependency, and nothing reaches the network.

## What changed

- **More kinds of control.** A page's `<script type="application/aiden-tweaks">` block may now declare `text` (words on a `data-*` attribute that also fill every `[data-aiden-text="<name>"]` element), `pad` (two numbers on one square, one target per axis) and `action` (a button that sends the page an `aiden-tweak-action` event). Any control may name a `group`, which puts it in a folder. A page may declare 24 targets (a pad counts as two), 8 buttons and 8 folders (`DESIGN_TWEAK_LIMITS`).
- **Panel.** Numbers keep their slider and gain a typed value that may sit between steps but never past the ends. Folders fold, and stay folded per page on this device. The pad works by dragging or with the arrow keys (Shift for ten steps), and each axis can be typed. Buttons press the running page.
- **Versions.** Save version keeps the frame's values and Dark switch as V2, V3 and so on (up to 12, stored on the frame as `tweakVersions`); V1 is always the file as it is. A version's picture is taken when it is saved or shown and kept in memory for this app run only, so after a restart a version shows its name alone (answer 1a). Show all adds a group beside the page with one copy per version, in rows of up to four.
- **Actions.** Shuffle picks random values inside each control's limits and steps (words and buttons are left alone). Send to Aiden queues the values as a comment on the frame that rides with the next message (answer 2a). Copy puts the same summary on the clipboard. Make default writes the values into the page's file as its defaults (`designCanvas:bakeTweaks`): a managed `<style data-aiden-tweaks>` block for variables, attributes on `<html>`, the declaration's defaults, and the words in place where they stand once. Words that can't be placed stay on the frame. Its toast offers Undo (`designCanvas:undoBakeTweaks`), which puts the file back only while nothing else has changed it.
- **Floating panel.** While the person is inside a page that has controls, the same controls float over the canvas at the top right (answer 3a + b), unless the side panel's Tweaks tab already shows that page. It folds to its title and stays folded next time.
- **Aiden.** The `aiden-design` skill describes the new controls, folders and the action event, and allows up to 24 values in folders for a component being tuned. `canvas_read` lists a page's versions by name.

## Code

- Model: `renderer/shared/design-canvas/tweaks.ts` (types, limits, parsing, shuffle, summary, bake, versions).
- Bridge: `main/services/design-canvas/bridge-source.ts` (text fill and restore, the action event).
- Main: `main/handlers/design-canvas.ts` (`designCanvas:bakeTweaks`, `designCanvas:undoBakeTweaks`, shared `rewriteFrameFile`).
- Renderer: `renderer/design/design-tweaks-panel.tsx` (editor and floating panel), `renderer/design/tweak-versions.ts` (Show all layout and in-memory pictures), `renderer/design/frame-source.ts`, and the canvas operations in `renderer/design/design-canvas.tsx`.

## Tests

- `renderer/shared/design-canvas/tweaks.test.ts`, `main/services/design-canvas/bridge-source.test.ts`, `main/handlers/design-canvas.test.ts` (Make default and Undo), `renderer/shared/design-canvas/canvas-summary.test.ts`.
- `renderer/design/design-tweaks-panel.test.tsx` and `renderer/design/tweak-versions.test.ts` (new).
- `tests/e2e/design-canvas.spec.ts`: the Tweaks panel flow from typed values to Show all, with light and dark screenshots.

## Not in this change

- Presets shared across pages, spec overlays and a tweak combination grid (options B to D in the research doc) are not started.
- Version pictures are not saved to disk (answer 1a).
