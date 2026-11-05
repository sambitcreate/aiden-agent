# Design mode

Status: proposed 2026-10-31 (v2, canvas). It replaces the Design Studio half of the [Design Studio + Create Images rebuild](../../plans/design-studio-create-images-rebuild-plan.md). DS-1a merged in #385, DS-1b never started, and nothing has ever been visible without `AIDEN_EXPERIMENTAL_DESIGN_STUDIO`. Create Images is not affected.

v1 of this spec used browser tabs as the canvas. v2 replaces them with an infinite canvas, at the owner's request ("a canvas like the Create Images panel where the user can roam around like Figma, open-design or Paper; the user creates things with an agent, points, annotates").

## 1. Why change course

Design Studio built a second product next to chat:

- hidden `design-project` chats;
- its own project store, manifest and run service;
- a locked generation profile;
- a `/design` route that still shows an empty placeholder.

Since then, ordinary chats gained most of what Studio meant to add:

- `render_artifact` visuals;
- the in-app browser with Annotate (⌘.), which captures React source and a screenshot crop;
- workspaces on every chat (#667 gives no-workspace chats an Aiden-managed private folder).

Create Images also shipped a generic pan-and-zoom canvas engine (`renderer/canvas/StudioCanvas`, built on xyflow). The missing piece is a design canvas built on that engine, plus a protocol the agent can use to put work on it.

## 2. What we take from prior art

- **open-design** (nexu-io/open-design) has no infinite canvas. It shows one sandboxed iframe at a time. Its value is in three places:
  - element picking through `data-od-source-path` stamps;
  - comment anchoring through `data-od-comment-id` attributes, which the agent is told to preserve, plus fuzzy re-anchoring when they are lost;
  - an `<attached-preview-comments>` block that hard-scopes an edit to the commented elements.
  - **We copy:** source stamps, comment IDs written into the source, the anchored, stale and lost states, the hard-scope block, draw marks stored as 0..1 fractions, a keep-alive pool for iframes, fixed-width iframes scaled with `transform`, `ev.source` checks on every message, and a `get_active_context`-style read.
  - **We avoid:**
    - React and Babel loaded from a CDN;
    - `allow-same-origin`;
    - `foreignObject` screenshots (we use `capturePage`).
- **tldraw's agent starter kit** gives the agent a viewport screenshot, the shapes in view, and clusters of shapes just outside it. Its actions are typed and sanitised, and coordinates are relative to the viewport. We copy that context shape.
- **Paper** exposes `create_artboard`, `write_html` and `update_styles` over MCP and asks for small writes. We copy the small-write habit: edit one frame's file, not the whole canvas.

## 3. Decision

Design mode is a per-chat layout on an ordinary workspace chat. In it, the right side becomes an infinite design canvas.

- **Owner answers (2026-10-31):**
  - it is attached to a workspace or Aiden-managed folder;
  - it ships to people (default-on with a kill switch);
  - it is desktop only for now, with a shape that is ready for phones later.
- **Scope:** any chat with a folder workspace or private folder. Bots and the Assistant do not get it.
- **State:**
  - `designMode` lives on the chat in main chat metadata, so it survives a restart and a window reload.
  - The canvas document belongs to the chat and is owned by main.
- **Source of truth:**
  - Designs are files in the workspace, normally `design/<slug>.html` plus its assets.
  - The canvas records where each frame sits and what it shows. It never holds the design itself.
  - People can open, commit, diff and keep the files without Aiden.

## 4. Layout

```
┌ sidebar (scoped) ┬ chat column ─┬ design canvas (infinite) ─────────────┐
│ ‹ All workspaces │ 420 px       │  ┌ A · Calm ─┐ ┌ B · Bold ─┐   ▢ note │
│ aiden-site       │ (360–560,    │  │  frame    │ │  frame  ①│           │
│  · Landing hero  │  draggable)  │  └───────────┘ └───────────┘           │
│  · Pricing page  │              │                                        │
│                  │ composer     │  [V H ✎ 💬]  ·  zoom 64% · fit         │
└──────────────────┴──────────────┴────────────────────────────────────────┘
```

- **Sidebar:**
  - It shows only the chat's project: an "‹ All workspaces" back row, then a heading styled like a workspace row (folder icon and workspace name, with the branch and path in tertiary text), then that project's drafts and chats.
  - The back row clears the scope for this window session. It does not leave design mode. While the scope is cleared, a "Show only <workspace>" row at the top of the full list brings it back.
  - While the scoped list has nothing to show (for example while the chat list briefly reloads empty, or the workspace was removed), the full list renders in its place and the scope is kept, so it comes back on its own.
  - For a private-folder chat it shows the Chats group.
- **Chat column:**
  - Default 420 px, minimum 360, maximum 560, with a drag divider.
  - The width is renderer-local and global, not per chat (`aiden-agent.design.chat-width`).
  - Messages fill the column: `--chat-content-max-width: none`, with a 16 px left gutter and the usual Live-pill clearance on the right.
  - The terminal drawer stays in the chat column.
  - The top bar keeps its actions whole: the title may shrink to nothing, the actions never shrink, and when the header is narrower than 480 px of content, Quick View and Terminal move into the ••• tools menu.
- **Canvas region:**
  - It takes everything left over, with a minimum of 320 px. It is one region named "Design canvas"; while empty it reads "Ask Aiden to design something, or add a note."
  - It replaces the side panel while design mode is on. On entry the panel and Quick View always close, and their state is saved only if the saved copy is missing or stale. Both are restored on exit.
  - The browser panel stays reachable through **Open in browser** on a frame, which leaves design mode's canvas visible and opens the panel overlaid.
- **Live pill:** it stays inside the chat column's bottom-right corner, clear of the canvas zoom, fit and minimap controls. In the stacked layout showing the canvas it sits at the canvas's bottom-left.
- **Narrow windows** (decided from the width of the content container, not the window):
  - At 680 px or more (chat minimum 360 plus canvas minimum 320) the chat and canvas sit side by side ("split").
  - Below 680 px they stack: a "Chat | Canvas" segmented control in the top bar shows one of them, and the hidden one is `inert` and hidden from assistive tech while staying mounted. The choice is remembered per chat for the window session.
  - While stacked, a banner reads "Design mode needs a wider window" with **Widen window** and a dismiss button. It shows only when widening can work: the window is not fullscreen or maximized and the display's work area is at least 1280 px wide. A widen that fails hides it; a widen that succeeds lets the next resize decide.
- **Resizing is only for a person's entry.** Turning design mode on in this window with the toggle, ⇧⌘L or `/design` may collapse the sidebar (when that alone makes room for the split) or, when it would not, widen the window to 1280 px within the work area (not animated under Reduce Motion). Launch, reload, switching chats and a change broadcast from another window never resize anything; they only show the banner when it applies. After a widen, the sidebar reopens if the split still fits with it. On exit the sidebar reopens only if design mode collapsed it.
- **Exit** restores the previous panel tab, panel width, open state and sidebar.

## 5. The canvas

### 5.1 Engine and navigation

The canvas reuses `StudioCanvas` with its own node registry (`renderer/design/`).

- **Navigation:**
  - Wheel or trackpad pans.
  - ⌘ or Ctrl plus wheel, or a pinch, zooms toward the pointer.
  - Space-drag or the Hand tool (H) pans.
  - Zoom is 10–400 %; Shift+1 fits all and Shift+2 fits the selection.
  - A minimap toggles with M.
- **Tools:**
  - V selects, H pans, C comments, D draws.
  - Escape returns to V.
- **Editing:**
  - Frames can be selected, multi-selected with a marquee, moved, resized with `NodeResizer`, duplicated (⌘D) and deleted.
  - ⌘Z and ⇧⌘Z undo and redo canvas edits. Edits Aiden makes to source files are not undone.
- **Escape order:**
  1. It closes a popover.
  2. It leaves an entered frame.
  3. It returns to the Select tool.
  4. It never leaves design mode.
- **Leaving design mode** is explicit: the toggle, ⌘⇧L, the pill's ✕, or `/design off`.

### 5.2 Frame kinds

| Kind | Shows | Source |
|---|---|---|
| `file` | a workspace HTML file, live | `aiden-design:` scheme, sandboxed iframe |
| `artifact` | a `render_artifact` visual | existing `aiden-genui:` preview |
| `image` | a workspace image (png, jpg, webp, gif, svg as image) | `aiden-design:` scheme, `<img>` |
| `note` | a sticky note with plain text, at most 2 000 characters | stored in the document |
| `group` | a labelled direction ("A · Calm") that holds frames side by side | stored in the document |

- Every frame has a title, a position, a size and an optional `groupId`.
- File and artifact frames render at a design width (default 1280, presets 390, 768, 1280 and 1440) and scale with `transform` to fit their box.
- A localhost `page` frame that shows a dev server is deferred. Until then, **Open in browser** on a file frame opens it in the browser panel.

### 5.3 Live iframes

- At most 6 frames are live at once. A frame is live when it is entered, selected, or among the largest frames on screen.
  - Every other frame shows its last snapshot, taken with `capturePage` when it leaves the live set.
  - If no snapshot exists yet, it shows a skeleton with its title.
- Below 25 % zoom every frame shows its snapshot.
- **Interaction shield:**
  - A frame ignores pointer input (`pointer-events: none`) until the person double-clicks it or presses Enter on it.
  - Once entered, it receives input and carries `nodrag nowheel`.
  - Escape leaves the frame.
- **Reload:** when its file or any asset under the same folder changes on disk, the frame reloads in place. The file watch is debounced by 150 ms and scoped to the open frames.

### 5.4 The `aiden-design:` scheme

It serves workspace files into frames. URL: `aiden-design://<grant>/<relative-path>`.

- **Grants:**
  - A grant is a random token. Main maps it to one chat and that chat's workspace root.
  - It lives as long as design mode is on for that chat in this app run.
  - A grant for a removed or re-rooted workspace is revoked.
- **Paths:**
  - A path resolves under the root with `realpath` containment. Symlinks that escape, `..`, absolute paths, dotfiles and dot-folders (`.git`, `.env`) are refused.
  - Files above 8 MiB are refused.
  - Only these types are served: HTML, CSS, JS, JSON, SVG, the png, jpg, gif and webp image types, woff and woff2 fonts, and text.
- **Responses:**
  - **CSP:** `default-src 'none'; script-src aiden-design: 'unsafe-inline'; style-src aiden-design: 'unsafe-inline'; img-src aiden-design: data: blob:; font-src aiden-design: data:; media-src aiden-design: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`.
  - **Libraries:** the vendored generative-ui libraries (`chart.js`, `plotly.js`, `katex`, and `aiden-ui.css`) are available under `aiden-design://<grant>/__aiden/lib/<name>`.
- **Bridge:** main injects one bridge script into every HTML response. It is served from `__aiden/bridge.js`, its contents are fixed, and it is listed in the CSP.
- **Sandbox:** frames are iframes with `sandbox="allow-scripts"` only. They have no same origin, no forms, no popups and no top navigation.
- **Main window:**
  - Its `frame-src` adds `aiden-design:`.
  - The navigation guards refuse `aiden-design:` as a top-level destination.
- **Network:** none. Designs that need a font or image must ship it in the workspace. The `aiden-design` skill tells Aiden this.

### 5.5 The bridge

The bridge talks to the canvas over `postMessage`. Every message carries the frame's nonce, and the canvas checks `event.source === iframe.contentWindow`.

- **Messages from the frame:**
  - `ready {docHeight}`;
  - `pick {selector, text, tag, rect, sourcePath?, commentId?}`;
  - `anchors {commentId → rect | null}`;
  - `resize {docHeight}`.
- **Messages to the frame:**
  - `pick-mode on|off`;
  - `locate {commentIds[], fallbacks[]}`;
  - `highlight {selector | commentId}`.
- **Picking:**
  - It uses the element under the pointer.
  - Alt widens the pick to the parent.
  - Shift adds to a lasso selection.
- **Source stamps:** when Aiden writes HTML it adds `data-aiden-src="<file>:<line>"` to meaningful elements, and the bridge reports the nearest stamp. Files without stamps still work, with a selector and text only.

### 5.6 Comments, pointing and annotating

People comment on the canvas, and Aiden turns comments into edits.

- **Comment tool (C):**
  - **On a live frame:** a click picks an element through the bridge, and a pin with a text box appears on it.
  - **Elsewhere:** a click drops a free pin at canvas coordinates.
- **Draw tool (D):**
  - It draws freehand marks over a frame or the canvas.
  - Marks are stored as points normalised to 0..1 inside their frame, or in canvas coordinates if they are drawn outside one.
  - A set of marks becomes one annotation, with an optional note.
- **Anchoring:**
  - On save, Aiden is asked to write `data-aiden-comment="<uuid>"` onto the picked element in the source, and to keep it on later edits.
  - Until that happens, and whenever the ID goes missing, the pin re-anchors with a fuzzy score: selector 4, text 2, tag 1, and up to 1 for distance from the last position. A score of 2 or more counts as a match.
  - Pins have three states: **anchored**, **stale** (re-anchored by score) and **lost** (shown as a ghost pin at the last position with "Element not found").
- **Sending:**
  - Open comments collect in a tray above the composer, and **Send N comments** sends them as one message.
  - Each comment becomes a `BrowserAnnotation`-style chip: a text attachment plus a `capturePage` crop of the frame region.
  - The model receives an `<attached-design-comments>` block that lists the frame file, the selector, the source stamp, the comment ID and the note. It adds: "Change only these elements unless told otherwise."
- **After sending:**
  - Sent comments turn into a quiet "sent" state.
  - When Aiden's turn ends and the frame reloads, they resolve if their element still anchors. People can reopen them.
- **Comment storage:** comments live in the canvas document, not the source. Only the comment ID is written into the source.

### 5.7 The canvas document

- **Path:** `userData/design-canvases/<chatId>.json`.
- **Writes:** main reads and writes it with an atomic write plus a revision check (compare and swap), the same way the Create Images workflow store does.
- **Shape (version 1):**

```ts
type DesignCanvasV1 = {
  version: 1;
  revision: number;
  viewport: { x: number; y: number; zoom: number };
  frames: DesignFrame[];        // at most 200
  comments: DesignComment[];    // at most 500
};
type DesignFrame = {
  id: string; kind: "file" | "artifact" | "image" | "note" | "group";
  title: string; x: number; y: number; w: number; h: number;
  groupId?: string; designWidth?: 390 | 768 | 1280 | 1440;
  path?: string;      // file, image: workspace-relative
  mediaId?: string;   // artifact
  text?: string;      // note
  createdBy: "person" | "aiden";
};
type DesignComment = {
  id: string; frameId?: string; x: number; y: number;
  anchor?: { commentId: string; selector: string; text: string; tag: string; sourcePath?: string };
  marks?: { points: [number, number][] }[];
  note: string; state: "open" | "sent" | "resolved"; anchorState: "anchored" | "stale" | "lost";
  createdAt: string;
};
```

- **Edits:** the renderer saves with an 800 ms debounce and the base revision. On a revision conflict, it reloads the document and reapplies the person's pending edit.
- **Broadcasts:** main broadcasts `designCanvas:updated {chatId, revision}`, so Aiden's tool edits show up live.
- **Deletion:** deleting a chat deletes its canvas document. Forks do not copy it.
- **Validation:**
  - The parser rejects unknown kinds.
  - It clamps sizes to 40–8 000 px and coordinates to ±1 000 000.
  - It drops frames whose `path` fails containment.

## 6. Aiden on the canvas

### 6.1 Tools

The canvas tools are host-owned and registered only for desktop turns in a chat with design mode on.

| Tool | Does | Returns |
|---|---|---|
| `canvas_read` | Describes the canvas. | The viewport, the frames in view with their kind, title, path, box, group and open comments, a summary of the frames outside the view clustered by group, and the selection. With `{snapshot: true}` it also attaches a downscaled screenshot of the canvas region (longest side at most 1 568 px). |
| `canvas_place_frame` | Adds a frame. It takes `{kind: "file" \| "image" \| "note" \| "group", path?, text?, title, x?, y?, w?, h?, groupId?, designWidth?}`. | The new frame's ID and box. If x and y are left out, the frame goes to the right of the last frame in its group, or of the current view, with a 64 px gap. |
| `canvas_update_frame` | Moves, resizes, retitles or regroups a frame. | The frame. |
| `canvas_remove_frame` | Removes a frame Aiden created. Removing a person's frame needs `confirm: true` and shows a one-line notice in chat. | `removed`. |
| `canvas_focus` | Pans and zooms to frames, but only while the person is not interacting with the canvas. | `focused` or `skipped`. |

Rules:

- **Paths:**
  - A path must be workspace-relative and pass the same containment as the scheme.
  - The file must already exist, so Aiden writes it first with its normal file tools.
- **Coordinates:** they are canvas units, and the tool results say so.
- **Visuals:** in design mode, every `render_artifact` result is also placed on the canvas as an `artifact` frame. Placing the same title again replaces the frame's content and keeps its position, which matches how the artifact store replaces by title.
- **Limits:** at most 20 canvas tool calls per turn. Above that, the tool returns `limit_reached`.
- **Unavailable:** remote, Telegram, Bot, CLI and unattended turns do not get the tools.

### 6.2 Entering design mode

People can enter design mode three ways:

- the top-bar **Design** toggle (`aria-pressed`);
- ⌘⇧L, as keybinding `design.toggle`. ⌘⇧D is not used because it is the default of the off-by-default global `dictation.toggle`; ⌘⇧G is find-previous and ⌘⌥D is the macOS Dock toggle;
- `/design`, which turns it on, or `/design off`.

The command is available only in desktop chats with a workspace.

Aiden uses a host-owned `design_mode` tool:

- **Input:** `{ action: "enter" | "exit", reason: string }`. The reason is at most 200 characters and is shown on the card.
- **enter:** shows a consent card with **Enter design mode** and **Not now**, then returns `{ status: "entered" | "declined" | "already" | "unavailable" }`.
- **exit:** needs no consent and returns `"exited"` or `"already"`.
- **Pattern:** it follows `aiden_open`. Main sends the request, the renderer confirms, and main resolves the result.
- **When it is offered:** only when Settings → Inline visuals is `automatic`. People can still enter design mode themselves in every mode.

### 6.3 The `aiden-design` skill and prompt

A built-in desktop skill, `aiden-design`, joins the desktop-only artifact skills and is excluded from Remote, Telegram and Bots. It tells Aiden to:

- write each design as a self-contained HTML file under `design/`, with assets beside it and no network;
- use `aiden-design:` library paths for charts and math;
- add `data-aiden-src` stamps to meaningful elements, and keep `data-aiden-comment` IDs;
- place each file with `canvas_place_frame`, at most 3 directions per request, each in its own group;
- make small edits to one file at a time;
- treat each comment as an edit request scoped to its element;
- say which file changed.

While design mode is on, the system prompt adds a short "Design mode is on" section. It points to the skill and includes a one-line canvas summary (the frame count and the open comments).

## 7. Contracts

- **Chat record:**
  - `ChatMeta.designMode?: true`; absent means off.
  - The store setter is `setDesignMode(id, enabled)`; the IPC is `chats:setDesignMode`.
  - The change is broadcast on `chats:metadata-updated` with a `designMode` field.
  - Forks do not inherit it.
- **Canvas IPC:**
  - `designCanvas:get(chatId)`;
  - `designCanvas:save(chatId, doc, baseRevision)`, which returns `{ok, revision} | {conflict, doc}`;
  - `designCanvas:grant(chatId)`, which returns the scheme grant;
  - `designCanvas:capture(rect)`, which returns a PNG data URL of a main-window region;
  - the `designCanvas:updated` broadcast.
- **Remote:**
  - The Remote chat projection does not include `designMode`, and the canvas tools are not offered remotely.
  - The canvas document is plain JSON owned by main, and frames point at workspace files, so a later Remote revision can project it for a read-only phone viewer.
- **CLI:** no change.
- **Analytics:** add these events:
  - `design_mode_entered {source: "toggle" | "shortcut" | "slash" | "aiden"}`;
  - `design_mode_exited`;
  - `design_mode_declined`;
  - `design_comments_sent {count_bucket}`.

  Each goes in the registry, gets a row in `docs/analytics.md` and a test.

## 8. Retiring Studio (P0)

Remove the following:

- the `/design` route and placeholder;
- the Design nav row and the `designStudio` capability;
- `design.open`;
- `designProjectsApi` and the preload design channels;
- `main/services/design/*` and `main/handlers/design/*`;
- `renderer/shared/design/*`;
- `generation-profile.ts`;
- the `designRun` paths in `llm-client.ts`;
- the startup wiring;
- the `test:design-studio` scripts.

Keep the following:

- `renderer/canvas/*` and studio assets, which Create Images and now design mode use;
- the Pi `finishTurn` harness, which subagents use;
- `generation-stream.ts`;
- the `ChatOwnerV1` parser, so any hidden `design-project` chat on a developer machine stays hidden.

Studio data already on disk is left untouched: no migration and no deletion.

## 9. Flag and launch

- P1 to P4 build behind `AIDEN_EXPERIMENTAL_DESIGN_MODE` (capability `designMode`).
- P5 makes it default-on. `AIDEN_DESIGN_MODE=0` turns it off, and a patch release can flip the default back.
- There are no remote feature flags.

## 10. Phases

| Phase | Delivers | Done when |
|---|---|---|
| P0 | Studio retired | No design route, row, IPC or store. `npm run test` and type-check pass. Create Images still works behind its flag. |
| P1 | Shell and state | Toggle, ⌘⇧L and `/design` enter and leave. The chat column and an empty canvas region resize, the sidebar is scoped, small-window rules work, and the state survives a reload. Covered by an E2E spec. |
| P2 | Canvas and frames | Pan, zoom, select, move, resize, undo. Note, group, image and file frames can be added by hand ("Add frame" picks a workspace file). The `aiden-design:` scheme, the live-iframe pool, snapshots, the interaction shield and reload on change all work. The document persists with revision CAS. |
| P3 | Aiden on the canvas | The canvas tools, artifact auto-placement, the `design_mode` tool and consent card, the `aiden-design` skill, and the prompt section. |
| P4 | The full canvas | The bridge, picking, the comment and draw tools, pins with their three anchor states, the tray, batch send with crops and the scoped block, and resolution after reload. Widened 2026-11-05 (owner chose "add everything shown"): pages, text, frame, shape, arrow, line, pencil and pen tools, rich notes, frame download, full window and Present, PDF export, a side panel (properties, layers, code, tweaks), a per-frame dark switch and editing text inside a page. See the [P4 plan](../plans/2026-11-05-design-mode-p4-full-canvas.md). |
| P5 | Launch | Analytics, the onboarding gallery tile with code-drawn art, docs, screenshots and the default-on flip. |

Plans are written before each phase starts: [P0](../plans/2026-10-31-design-mode-p0-retire-studio.md), [P1](../plans/2026-10-31-design-mode-p1-layout.md).

## 11. User journeys

**1. "Make me a pricing page" (Aiden-led).**

1. Raj asks, in a workspace chat with Inline visuals set to automatic, for a pricing page.
2. Aiden calls `design_mode` with "Comparing three directions is easier side by side." A card appears: **Enter design mode** or **Not now**.
3. Raj chooses Enter.
   - The sidebar narrows to his project, the chat slides into a 420 px column, and an empty canvas fills the rest.
   - Aiden writes `design/pricing-calm.html`, `-bold.html` and `-editorial.html`, and places each one in its own group: A · Calm, B · Bold and C · Editorial.
   - The frames appear one by one, and the canvas fits them in view.
4. Raj pans around and zooms into B. He presses C, clicks B's plan cards and types "use A's spacing". He then clicks C's hero and types "too loud".
5. He chooses **Send 2 comments**. Aiden edits only those elements in those two files. Both frames reload in place, and the pins resolve.
6. He says "go with B". Aiden ports B into `src/pages/pricing.tsx` and calls `design_mode` exit. The canvas document stays, so `/design` brings the frames back.

**2. "Let me sketch the onboarding flow" (person-led).**

1. Mia types `/design` in her `aiden-site` chat. The canvas opens empty.
2. She adds a note ("3 steps: welcome, connect, done") and drags in `assets/brand/logo.svg` with **Add frame**.
3. She asks "lay out the three screens at phone width next to my note". Aiden reads the canvas, writes three files, and places them at 390 px design width to the right of her note, in a group named "Onboarding".
4. She presses D, circles the second screen's button, notes "primary, not ghost", and sends. Aiden edits `design/onboarding-2.html`.
5. She presses ⌘⇧L to leave. Her sidebar and panel come back as they were.

## 12. Open questions and resolutions

- Resolved 2026-10-31: "make it live" means shipping design mode only. Create Images stays behind its own flag and is being worked on in a separate thread, so design mode keeps its edits to shared canvas code additive.
- Localhost `page` frames, which would put a dev server on the canvas, are deferred until the core loop has shipped.
