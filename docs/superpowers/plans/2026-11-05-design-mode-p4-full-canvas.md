# Design mode P4: the full canvas

Status: planned 2026-11-05; owner answered 1a, 2b, 3a (with a Copy button), 4a. P4a built 2026-11-05 and approved by the owner; P4e built 2026-11-06 ([P4e plan](2026-11-05-design-mode-p4e-comments.md)) and approved; P4b built and approved 2026-11-06; P4c built 2026-11-06 and approved; P4d, P4f and P4g built 2026-11-06. Spec: [design mode](../specs/2026-10-31-design-mode-design.md) §5.5–§5.7. Branch: `claude/project-thread-29fzrr` (PR #778), on top of P0–P3.

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

One migration, done in P4a, so later slices only add fields. P4a added only the page fields; the new kinds, frame fields and caps below arrive with the slices that use them, as optional fields the version 2 parser learns to read.

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

As built (2026-11-05):
- `renderer/shared/design-canvas/pages.ts` holds the page edits (add after the page on screen, rename, duplicate with remapped groups, delete with its frames and comments, move, move frames to a page). Each page keeps its own view; panning is not an undo step, and undo restores page names and order but leaves each page's view where it is.
- The toolbar (`renderer/design/design-toolbar.tsx`) has the page picker, Select, Hand, Note (`N`) and Add (Group, File…, Image…). Text, Frame, Draw and Shape join it in P4b, so it shows only tools that work today. `StudioCanvas` gained an additive `toolbar` prop; Create Images keeps its rail. The zoom controls stay at the bottom right: at the top right they sat under the Linux window controls.
- Deleting a page shows a toast with Undo. `canvas_focus` on a frame on another page brings that page on screen first.
- The Keyboard Shortcuts list (⌘/) and Settings show a **Design canvas** section while design mode is available.
- Frame caps stayed at 200 until P4b brought small elements (now 1 000, 400 per page).

### P4b: drawing tools

- **Text:** click to place, type to grow. It uses the rich text editor from P4c, so P4c's editor is built first inside this slice.
- **Frame:** drag to draw an artboard.
- **Rectangle and Oval:** drag to draw. Shift keeps them square or round.
- **Arrow and Line:** drag between points. Ends that land on a frame attach to it, and the ends can be dragged later.
- **Pencil:** freehand, smoothed, and simplified to at most 2 000 points.
- **Pen:** click for corners, drag for curves, Enter or Escape to finish.
- Every new element can be selected, moved, resized, duplicated, deleted and undone like any frame.
- Aiden tools: `canvas_place_frame` accepts `text`, `shape`, `connector` and `frame`, so Aiden can draw flows and diagrams. Strokes stay person-only.

As built (2026-11-06):
- The toolbar gained Text (`T`), Frame (`F`), a **Shapes** menu (Rectangle `R`, Oval `O`, Arrow `⇧L`, Line `L`) and a **Draw** menu (Pencil `P`, Pen `⇧P`). Each menu shows the tool last picked from it. A tool stays on until Escape or another tool, so several shapes can be drawn in a row; Text and Frame go back to Select after one.
- A click without a drag makes a standard size: rectangle 160×100, oval 120×120, artboard 640×400, text 240 wide, line 160 long. Shift keeps boxes square and lines at 45° steps.
- Text is plain text for now, edited in place (double-click or Enter; Escape or ⌘↩ to finish; an empty text block is removed). The formatting bar and the Markdown subset arrive with P4c, so this slice does not build P4c's editor first as planned above.
- Shapes carry a centred label in `text`, edited the same way. Colours come from a fixed palette (`ink`, `gray`, and `blue` to `pink` mapped to the `--chart-*` tokens); fills are a soft mix of the colour over the surface, so they follow light, dark and every theme preset.
- Arrows and lines attach an end dropped on a frame to the middle of the side facing the other end (`renderer/shared/design-canvas/connectors.ts`). They follow their frames when those move, resize, or are moved by Aiden. When a frame is deleted or moved to another page, its end stays where it was as a free end. The ends of a selected connector can be dragged to re-attach them.
- Pencil lines are simplified (Ramer–Douglas–Peucker, at most 2 000 points) and smoothed. Pen: click for corners, drag for curves; Enter, Escape or a double-click finishes, and a click on the first point closes the path.
- Artboards are containers like groups: an item drawn or dropped inside one joins it and moves with it, and containers do not nest.
- Caps: 1 000 frames, 400 per page, 2 000 points per stroke, stroke width 1–24. The smallest size is per kind (lines 1, text and shapes 8, others 40).
- Aiden: `canvas_place_frame` and `canvas_update_frame` take `text`, `shape`, `connector` (`from`/`to` as a frameId and optional side, or a point) and `frame`; `canvas_read` reports labels, colours and connector ends. Strokes stay person-only. A batch drawing tool is a possible follow-up.
- Known gap: dragging or resizing any node, including notes from before P4b, can log Chromium's "ResizeObserver loop completed with undelivered notifications" as an uncaught renderer error. It is harmless but noisy, and is left for P5.

### P4c: rich notes

- A formatting bar on the selected note or text: size (Small, Medium, Large), text colour, bold, italic, underline, link, bullet and numbered list, note colour, and Comment (P4e).
- It is built on the composer's existing rich text stack where possible, and stores the Markdown subset.

As built (2026-11-06):
- The composer turned out to be a plain textarea, so there was no rich text stack to reuse. Notes and text items use a small contenteditable editor (`renderer/design/nodes/rich-text-editor.tsx`) on the browser's own editing commands. It starts from the stored Markdown and hands Markdown back after each change; pasted and dropped content comes in as plain words.
- The Markdown subset (`renderer/shared/design-canvas/rich-text.ts`): `**bold**`, `*italic*`, `<u>underline</u>`, `[links](…)`, and `- ` or `1. ` lines for lists; every other line is a paragraph. Links keep only http, https and mailto addresses. Reading the editor back (`renderer/design/rich-text-dom.ts`) keeps only what the subset holds, so pasted markup, scripts and other tags never reach the document. Notes and text read back the same after a reload, and Aiden reads and writes the same Markdown.
- The bar appears above a selected note or text item and while its words are edited: Text size (Small, Medium, Large), Text colour, Bold, Italic, Underline, Link, Bulleted list, Numbered list, Note colour (notes only) and Comment, which opens a comment on that note or text. Marks and lists apply to the selected words, or to all of them when nothing is being edited. Size and colours apply to the whole note or text item, not to single words.
- ⌘B, ⌘I and ⌘U (Ctrl on Windows and Linux) format inside an editor; the editor takes them before the app's own ⌘B (sidebar). ⌘K stays the command palette, so links come from the bar's Link button.
- Notes gained `size`, `color` and `fill`; a note's default size is Small. Shape labels stay plain words.

### P4d: frame actions, Present and export

- Each frame's title row gets:
  - **Open full window:** a file frame opens in the in-app browser panel. An artifact opens in its existing viewer.
  - **Download:** PNG from `capturePage` at 2×, PDF through `printToPDF`, or the original file.
- **Present:** a full-window walk through the page's top-level frames in reading order. The arrow keys move between frames, Escape leaves, and Reduce Motion is respected.
- **Print mode and paper:** Flow or Fixed, Letter or A4, set on artboard and file frames (side panel) and used by PDF export.

As built (2026-11-06):
- Pages, artifacts and images get two buttons at the end of their title row (`renderer/design/nodes/frame-actions.tsx`): **Open full window** and **Download**.
- **Open full window** shows that one frame alone, filling the window, with a small bar that names it and a Close button (Esc also closes). A page or artifact is live and takes input there. This replaces the plan's in-app browser panel: the browser panel would load the page outside the `aiden-design:` sandbox, and the full window keeps the same no-network page.
- **Download** offers **PNG image**, **PDF** and **Original file**; images offer only the original file. Below them, **PDF paper** (Letter or A4) and **PDF layout** (Flow to the paper, or Fixed at design width) are kept on the frame (`paper`, `printMode`; only pages and artifacts carry them). They live in this menu until the P4f side panel exists.
- Export runs in main (`designCanvas:export`, `main/handlers/design-canvas.ts`): the frame is read from the stored canvas (the renderer saves first, and when the canvas can't be saved it says so instead of exporting an older copy; the Code and Tweaks tabs do the same), a save dialog asks where, and a hidden, sandboxed window with no preload draws the page from its own `aiden-design:` or artifact address (`main/services/design-canvas/frame-render.ts`). PNG is twice the CSS pixels, at the page's design width (artifacts use their box width, 320 to 1440 px) and its full height up to 8,000 px. PDF uses `printToPDF` with 0.4 in margins: Flow prints at full size and lets the page wrap; Fixed scales the design width to the paper's printable width (at most 2×). The original file is copied; an artifact saves as its standalone HTML.
- The PNG is drawn by zooming the hidden window 2× and capturing it, not through the DevTools protocol, which never answers in a hidden window on Linux.
- Artboards, notes, text, shapes and lines have no Download yet: an artboard is a box on the canvas, not a page, so it needs a canvas renderer of its own. That is left for later.
- **Present** (top right of the canvas) fills the window and walks the page's top-level frames row by row from the top and left to right within a row (`renderer/shared/design-canvas/presentation.ts`); lines, drawn strokes and frames inside groups are skipped. → ↓ Space Enter PageDown go on, ← ↑ Backspace PageUp go back, Home and End jump, Esc stops. A bar at the bottom shows "2 of 5 · name" with Previous, Next and Exit. Each frame is fitted to the window (no animation under Reduce Motion); the page's saved view is not changed, and the canvas goes back to where it was on Exit. Only the presented frame is drawn, with what is in it and the arrows between those; neighbours, even overlapping ones, are not. On a narrow canvas the Present button shows only its icon.
- On Linux without a desktop title bar, the canvas's top row now stops short of Aiden's own window buttons.

### P4e: point, comment, draw marks, send to Aiden (the original P4)

Detailed plan: [P4e](2026-11-05-design-mode-p4e-comments.md).

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

As built (2026-11-06):
- The panel opens with the side-panel button at the canvas's top right or `I` (not ⌥⌘I, which the menu keeps for Toggle Developer Tools). It sits at the canvas's right edge, 352 px wide, and is remembered per device. It is hidden while presenting.
- **Properties** (`renderer/design/design-side-panel.tsx`) shows the selected item's name and kind, then only the sections that apply: X, Y, Width and Height; Design width (390, 768, 1280, 1440; changing it scales the frame's width); Background and Corners for artboards (`fill`, `radius`, default 4 px); Corners for rectangles; Fill, Outline or Colour and Stroke width for shapes and lines; PDF paper and layout for pages and artifacts (they also stay in the Download menu); and a **Layout guide** (4, 8 or 12 columns with 16 px gutters and margins, or an 8 px grid) on pages, artifacts and artboards (`guide`). The guide is drawn only on the canvas (`nodes/layout-guide.tsx`) and is never in an export or the presentation.
- **Layers** lists the page's items front-most first, with an artboard's or group's members under it (`renderer/design/layers-core.ts`). A click selects; a double-click or F2 renames; dragging a row above or below another reorders it; ⌥↑ and ⌥↓ step it forward or back. Only siblings trade places, so a container always stays behind its items. Each row has **Hide** and **Lock**. A hidden item is not drawn (a hidden container hides its members), not presented and not live; a locked item cannot be moved, resized or deleted on the canvas, and a duplicate is not locked.
- **Code** shows a page's file or an artifact's HTML, read-only and highlighted, with **Copy code**. Main reads it (`designCanvas:source`) from the granted workspace or the artifact store and cuts it at 512 KiB.
- New frame fields: `radius`, `guide`, `hidden` and `locked`; `fill` is also an artboard's background.

### P4g: tweaks

- **Dark switch** on any file or artifact frame. The bridge sets `color-scheme` and `data-theme="dark"` on the page root, and the `aiden-design` skill teaches Aiden to write pages that follow both.
- **Page-declared tweaks:** a page can declare simple controls (switch, choice, number, colour) in a `<script type="application/aiden-tweaks">` JSON block. The bridge applies the values as CSS variables or data attributes, and the frame saves its values in `tweaks`. Nothing is written to the source.

As built (2026-11-06):
- A fourth side-panel tab, **Tweaks**, for the selected page or artifact. The panel is now 352 px wide so the four tabs fit.
- **Dark** (`dark` on the frame). On a page, the bridge sets `data-theme="dark"` and `color-scheme: dark` on the root element, and the iframe's own color scheme follows, so a page that uses `prefers-color-scheme` follows it too. Switching off puts back whatever the page had. On an artifact, Dark draws it with the dark variant of the person's theme even while Aiden is light (`renderer/design/artifact-theme.ts`); off, it follows Aiden's appearance as before.
- **The page's tweaks** are read from the page's file (`renderer/shared/design-canvas/tweaks.ts`): a switch, a choice (segmented for up to three short options, otherwise a menu), a number slider and a colour well, at most 24. Each sets one CSS variable or one `data-*` attribute on the root element: a number on a variable gets its unit, and a switch sets a variable to 1 or 0 or an attribute to "true" or "false". The frame keeps only the values that differ from the page's defaults, keyed by target (`tweaks`), so **Reset tweaks** and going back to a default both leave the page as its file says. A slider and the colour well change the page when they are let go, so one drag is one undo step.
- Values reach a live page as a `set-tweaks` message; a page's first load and each reload after a change on disk carry them on the address (`aiden-dark=1`, `aiden-tweaks=…`), which the bridge applies before the page draws. Export uses the same address, and a dark artifact exports with the dark theme.
- The `aiden-design` skill tells Aiden to give every page a dark look under `:root[data-theme="dark"]` and how to declare tweaks; `canvas_read` reports a frame's `dark`, `tweaks` and `hidden`.

### P4h: editing text inside a page

- Double-click text inside an entered live frame to edit it in place. The bridge makes only that element editable.
- A formatting bar offers heading level, bold, italic, underline, link, list, alignment and Comment.
- Saving (Question 1: a): a plain text change is written straight into the file at the matched place, and a formatting change is sent to Aiden as a scoped request.
- If the edit can't be matched to exactly one place in the source, it is sent to Aiden as a scoped request instead, and the person is told so.
- Undo restores the file.
- It needs the source stamps from §5.5, so it lands after P4e's bridge.

As built (2026-11-06):
- A double-click inside an entered page makes the paragraph, heading, list item, link, button or cell under the pointer editable (a bold word or a span is edited with the block it sits in). `↩` or **Done** finishes, `Esc` puts the words back, and a click elsewhere in the page also finishes. Double-clicks do nothing until the page is entered.
- The formatting bar above the page (`renderer/design/nodes/page-text-bar.tsx`) has Text style (Paragraph, Heading 1–3), Bold, Italic, Underline, Link, Bulleted list, three alignments, Comment and Done. Its buttons never take the focus, so the page keeps its selection.
- A change is plain when only words changed: the same element, style and inline shape, and the same number of text runs. Each changed text run is written into the page's file (`designCanvas:editText`, planned by `renderer/shared/design-canvas/text-edit.ts`) only where its old words are found exactly once as a whole text run outside tags, scripts, styles, comments and the title, with any entity spelling and any run of whitespace. When the element carries a `data-aiden-src` stamp, only that line and the 30 after it count. New words are escaped. At most 20 runs of 4,000 characters each.
- Anything else (a formatting change, or words found more than once or not at all) becomes a queued comment on that element for Aiden, with what it was and what it should be, and a toast says so.
- Writes go one at a time, in the order they were made: main holds a lock per file, checks the file is still what it planned against, and writes it atomically. They wait for the canvas to save, since main finds the page's file in the saved canvas. If the canvas can't be saved, or the file changes during a write, the edit goes to Aiden as a queued comment instead.
- `⌘Z` on the canvas puts the file's old words back (and `⇧⌘Z` writes them again) until the next change on the canvas itself, which `⌘Z` then undoes first.

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
