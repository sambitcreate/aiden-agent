# Design mode P4: the full canvas

Status: planned 2026-11-05; owner answered 1a, 2b, 3a (with a Copy button), 4a. In progress from P4a. Spec: [design mode](../specs/2026-10-31-design-mode-design.md) §5.5–§5.7. Branch: `claude/project-thread-29fzrr` (PR #778), on top of P0–P3.

**Goal:** the canvas does everything in the owner's 2026-11-05 reference screenshots of a design canvas (owner chose "add everything shown"). That is the original P4 (point, comment, draw, and send comments to Aiden) plus:
- drawing tools;
- rich notes;
- frame actions;
- a side panel;
- tweaks;
- editing text inside a page;
- pages.

**Constraints:**
- Everything stays behind `AIDEN_EXPERIMENTAL_DESIGN_MODE`.
- No new network access. Frames stay sandboxed (`allow-scripts` only) and the `aiden-design:` CSP is unchanged except where a slice says so.
- The canvas document stays main-owned, with revision CAS. Every new kind is readable and writable by Aiden's canvas tools, so Aiden can draw diagrams as well as place pages.
- Writes to workspace files respect the chat's workspace permission. Read-only or no-access workspaces get no in-place editing, and code saves are disabled there.
- Every slice that changes the UI is shown to the owner as light and dark screenshots before approval (standing rule).
- Aiden's design system (`GUI.md`, `docs/design-guide.md`, semantic tokens) is used throughout. The reference screenshots set the feature list, not the look.

## What the reference shows, and where it lands

| Reference feature | Today | Slice |
|---|---|---|
| Pan, zoom %, fit, minimap, Select (V), Hand (H) | built (P2) | P4a: toolbar restyle only |
| Pages (Page 1 ▾) | – | P4a |
| Rename a frame from its title | – | P4a |
| Text tool, Frame tool | – | P4b |
| Shapes: rectangle, oval, arrow, line | – | P4b |
| Pencil (freehand) and Pen (bezier) | – | P4b |
| Sticky notes with size, colour, bold, italic, lists, note colour | plain-text notes | P4c |
| Per-frame download, open full window | – | P4d |
| Present (play) | – | P4d |
| Print mode Flow / Fixed, paper Letter / A4, PDF export | – | P4d |
| Comment mode: click anything, pin, "@Aiden", Send to Aiden, voice | – | P4e (the original P4) |
| All comments panel | – | P4e |
| Side panel: Properties, layer list, artboard size, background, radius, layout guide | – | P4f |
| Code tab: the frame's source | – | P4f |
| Tweaks: dark switch per frame, page-declared tweaks | – | P4g |
| Editing text inside a page with a formatting bar | – | P4h |
| Share | – | later, its own project (Question 2: b) |
| "Unsaved changes" banner | not needed | – (the canvas saves itself) |

## Document schema v2

One migration, done in P4a, so later slices only add fields.

- `version: 2`, read-migrated from v1, written as v2 only.
- `pages: { id; name; viewport }[]`, at least one. Frames and comments get a `pageId`. v1 documents migrate to one page named "Page 1".
- New frame kinds:
  - `text`: a canvas text block in rich text.
  - `shape`: `rect | oval`, with fill, stroke and corner radius from a fixed token palette.
  - `connector`: an arrow or line, with two ends that are each a point or a frame id plus side. A connector follows a frame when it moves.
  - `stroke`: a pencil or pen path. Points are in canvas units (pen points carry bezier handles), with a stroke width and a token colour.
  - `frame`: an empty artboard drawn with the Frame tool, which can hold shapes and text like a group.
- `note` and `text` store rich text as a small Markdown subset: bold, italic, underline, links, bullet and numbered lists, and three sizes. That keeps them readable to Aiden and safe to render with the existing Markdown renderer. Notes get a `color` from the note palette.
- Frame fields:
  - `hidden` and `locked`, from the layer list;
  - `z`, for order;
  - `background` and `radius`, for artboards;
  - `tweaks`, the per-frame values (P4g).
- Caps: frames 200 → 1 000, because strokes and shapes are small. A stroke has at most 2 000 points. A page has at most 400 frames. Comments stay at 500.
- Tests: migration fixtures (v1 → v2 round trip), caps, and connector-follow on move.

## Slices

Each slice lands as its own commits with behavioral tests, then screenshots for approval.

### P4a: toolbar, pages, rename (foundation)

- A floating toolbar at the canvas's top left: page picker, Select, Hand, Text, Frame, Note, Draw ▾ (Pencil P, Pen ⇧P), Shape ▾ (Rectangle R, Oval O, Arrow ⇧L, Line L). The shortcuts are added to the design canvas keymap and the Keyboard Shortcuts dialog.
- Zoom controls and the minimap move to a top-right cluster with the Present button (P4d) and the side-panel toggle (P4f).
- Pages: add, rename, duplicate, delete with undo, and reorder in the picker. Each page has its own viewport.
- Rename: double-click a frame's title, or F2.
- Schema v2 migration.
- Aiden tools: `canvas_read` and `canvas_place_frame` take an optional `page`, and `canvas_read` lists the pages.

### P4b: drawing tools

- **Text:** click to place, type to grow. It uses the rich text editor from P4c, so P4c's editor is built first inside this slice.
- **Frame:** drag to draw an artboard.
- **Rectangle and Oval:** drag to draw. Shift keeps them square or round.
- **Arrow and Line:** drag between points. Ends that land on a frame attach to it, and the ends can be dragged later.
- **Pencil:** freehand, smoothed, and simplified to at most 2 000 points.
- **Pen:** click for corners, drag for curves, Enter or Escape to finish.
- Every new element can be selected, moved, resized, duplicated, deleted and undone like any frame.
- Aiden tools: `canvas_place_frame` accepts `text`, `shape`, `connector` and `frame`, so Aiden can draw flows and diagrams. Strokes stay person-only.

### P4c: rich notes

- A formatting bar on the selected note or text: size (Small, Medium, Large), text colour, bold, italic, underline, link, bullet and numbered list, note colour, and Comment (P4e).
- It is built on the composer's existing rich text stack where possible, and stores the Markdown subset.

### P4d: frame actions, Present and export

- Each frame's title row gets:
  - **Open full window:** a file frame opens in the in-app browser panel. An artifact opens in its existing viewer.
  - **Download:** PNG from `capturePage` at 2×, PDF through `printToPDF`, or the original file.
- **Present:** a full-window walk through the page's top-level frames in reading order. The arrow keys move between frames, Escape leaves, and Reduce Motion is respected.
- **Print mode and paper:** Flow or Fixed, Letter or A4, set on artboard and file frames (side panel) and used by PDF export.

### P4e: point, comment, draw marks, send to Aiden (the original P4)

As the spec describes in §5.5 and §5.6:
- the bridge, picking, the Comment tool (C), and pins with anchored, stale and lost states;
- the draw-mark annotations;
- the tray above the composer, and "Send N comments" with crops and the `<attached-design-comments>` block;
- resolution after reload.

Additions from the reference:
- The comment box says what it is attached to ("Option A › text 'Favorites'").
- It has a "Send to Aiden" checkbox (on: it goes in the next send; off: it stays a comment).
- It has a microphone that uses the existing dictation.
- An **All comments** panel lists comments with filters (open, sent, resolved) and jumps to each one.

### P4f: side panel

A panel on the canvas's right edge with three tabs. It opens with the toggle or ⌥⌘I.

- **Properties:**
  - x, y, width and height;
  - design width presets (390, 768, 1280, 1440);
  - background and radius (artboards and shapes);
  - fill, stroke and stroke width (shapes and strokes);
  - print mode and paper;
  - a layout guide (columns or a grid, drawn over the frame).
- **Layers:** a tree of the page's frames by group. You can select, rename, reorder by dragging, hide and lock.
- **Code:** a file frame's source, read-only, with syntax highlighting and a Copy button (Question 3: a, with Copy).
- **Tweaks:** see P4g.

### P4g: tweaks

- **Dark switch** on any file or artifact frame. The bridge sets `color-scheme` and `data-theme="dark"` on the page root, and the `aiden-design` skill teaches Aiden to write pages that follow both.
- **Page-declared tweaks:** a page can declare simple controls (switch, choice, number, colour) in a `<script type="application/aiden-tweaks">` JSON block. The bridge applies the values as CSS variables or data attributes, and the frame saves its values in `tweaks`. Nothing is written to the source.

### P4h: editing text inside a page

- Double-click text inside an entered live frame to edit it in place. The bridge makes only that element editable.
- A formatting bar offers heading level, bold, italic, underline, link, list, alignment and Comment.
- Saving (Question 1: a): a plain text change is written straight into the file at the matched place, and a formatting change is sent to Aiden as a scoped request.
- If the edit can't be matched to exactly one place in the source, it is sent to Aiden as a scoped request instead, and the person is told so.
- Undo restores the file.
- It needs the source stamps from §5.5, so it lands after P4e's bridge.

## Order and size

The order is P4a, then P4e (the core loop: point at something and Aiden changes it), then P4b, P4c, P4d, P4f, P4g and P4h, then P5 (launch). (Question 4: a.)

These sizes are rough, at the pace of P3:
- P4a: about one day.
- P4e: two to three days.
- P4b: two to three days.
- P4c: one day.
- P4d: one to two days.
- P4f: two days.
- P4g: one day.
- P4h: two to three days.

Each slice gets its own E2E coverage in `tests/e2e/design-mode.spec.ts`.

## Questions for the owner (answered 2026-11-05: 1a, 2b, 3a with a Copy button, 4a)

1. **Text edits inside a page.**
   - a) Plain text changes are saved straight into the file, and formatting changes go to Aiden. (Recommended.)
   - b) Every edit goes to Aiden.
   - c) Every edit is saved straight into the file.
2. **Share.** Aiden has no cloud of its own.
   - a) Skip a share link; Download (PNG, PDF, file) covers sending work to someone. (Recommended.)
   - b) Plan a share link later as its own project.
3. **Code tab.**
   - a) View only; changes go through Aiden or your editor. (Recommended.)
   - b) View and edit, saving to the file.
4. **Order.**
   - a) Comments and "send to Aiden" right after the toolbar and pages, because they are the heart of design mode. (Recommended.)
   - b) All the drawing tools first.
