# Generative UI Artifacts Plan

Status: Active  
Date: 2026-08-26  
Sources: Google Antigravity blog [Visualizing with the help of Antigravity](https://antigravity.google/blog/visualizing-with-the-help-of-antigravity) (2026-08-26), [Antigravity changelog 2.11.0](https://antigravity.google/changelog), [Artifacts overview](https://antigravity.google/docs/artifacts), Aiden `docs/pi-gui-artifacts.md`, `display_image` extension, Designer Mode plan, ChatGPT work-surface notes.

## Outcome

Aiden should let the attended desktop agent present **interactive, zero-install HTML visualizations** (charts, diagrams, dashboards, mockups) **inline in chat**, with expand and offline export — without loading Pi’s disk extension loader, without writing into the user’s git worktree by default, and without weakening the renderer CSP.

This is **not** Antigravity Planning Mode (implementation plans, HITL approve/reject, browser recordings). Those stay out of this plan.

## Research verdict: best integration path

**Copy Aiden’s existing GUI-artifact path, not Antigravity’s undocumented internals and not Pi coding-agent plugins.**


| Option                                                                                        | Verdict                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official Pi extension loader (`@earendil-works/pi-coding-agent`, `discoverAndLoadExtensions`) | **Reject.** Aiden deliberately does not depend on that package. Executable user plugins in Electron main are a trust decision we already refused.                                                  |
| Ordinary `buildAgentTools` tool                                                               | **Reject for this feature.** GUI presentation is chat-scoped, non-replayable, and must not leak HTML into Pi history. `docs/pi-gui-artifacts.md` requires a chat-scoped `PiAgentRuntimeExtension`. |
| New Electron `<webview>`                                                                      | **Reject for MVP.** Disabled today; Designer Mode already prefers iframe; Electron discourages webview.                                                                                            |
| Designer Mode Vite/Onlook preview                                                             | **Do not wait on, do not merge.** Designer is source-mapped preview of the user’s running app with write-back. GenUI is a **self-contained generated document** with no project toolchain.         |
| **Chat-scoped** `PiAgentRuntimeExtension` **+** `chat:artifact` **+ sandboxed** `iframe`      | **Adopt.** Same shape as `aiden.gui.display-image`.                                                                                                                                                |


Antigravity 2.11.0 is the product reference for *what users see* (inline HTML in chat, Chart.js / Plotly / KaTeX, export standalone HTML, inspect, `/generative_ui`). Official docs for GenUI are thin: `docs/artifacts` still describes planning files, not widget sandbox, MIME, or a render tool schema. Aiden should **invent a tight contract** rather than guess Antigravity’s IPC.

## What Antigravity actually shipped (and what to copy)

Documented or changelog-backed:

- Agents produce **interactive HTML/CSS/JS** artifacts; users interact in an **artifact preview panel**.
- **Zero-dependency / offline**: no extra npm install; export and reopen later.
- **Inline HTML in chat** (2.11.0).
- Host support for **KaTeX, Chart.js, Plotly** in widgets and previews.
- Slash `/generative_ui` plus natural language.
- Theme-aware widget form controls and scrollbars (2.11.0 fix).
- File-backed artifact panel (nested-dir listing bugfix implies **real files** in Antigravity’s app data, not only chat blobs).

Do **not** copy as GenUI:

- Implementation Plan / Walkthrough approval gates.
- Artifact Review Policy, CLI `/artifact` file picker.
- Nano Banana **raster** mockups (images already have `display_image`).
- Browser-agent JS execution policy (different surface).



## Architecture

```
prepareGeneration (attended desktop chat only)
  → aiden.gui.generative-ui  (PiAgentRuntimeExtension)
      tool render_artifact({ title, html } | { title, path })
      → validate + normalize HTML
      → stage in app-owned store (not the workspace tree)
      → emit ChatArtifactEventV1 present
      → tool result to the model is short text only (no HTML)
renderer
  → parse fail-closed
  → inline artifact frame (sandboxed iframe srcdoc/blob)
  → expand dialog; later expanded work-surface tab
  → persist opaque media id + metadata on the assistant message
```



### 1. Inbuilt Pi extension (Aiden adapter, not Pi loader)

New module modeled on `main/services/display-image-extension.ts`:

- **id:** `aiden.gui.generative-ui`
- **tool:** `render_artifact`
- **replay:** `declarePiRuntimeReplay(..., "never")`
- **enablement:** same gate as `shouldEnableDisplayImageExtension` (workspace chat, not Telegram, not Assistant, permission ≠ `"none"`, not excluded). Bots and child agents do not inherit it.
- **system prompt (host-owned, short):** when a chart, diagram, dashboard, interactive explainer, or UI mockup would help, call `render_artifact` instead of dumping a huge Markdown table or asking the user to open a browser. Prefer vanilla HTML/CSS/JS. Host injects Chart.js, Plotly, and KaTeX. Do not fetch remote scripts or call network APIs from the artifact. Do not use this for ordinary prose or raster images (`display_image`).

Parameters (TypeBox, fail closed):


| Field   | Rules                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title` | 1–120 chars, no control characters                                                                                                                                                                                         |
| `html`  | Optional. UTF-8 HTML document or fragment. Hard cap (see limits). Mutually exclusive with `path`.                                                                                                                          |
| `path`  | Optional. Workspace-relative `.html` / `.htm` file. Same path pinning as `display_image` (realpath, lexical containment, regular file). Read into the stage; **do not** leave the renderer pointing at the workspace path. |


Prefer `html` **for generation**. `path` exists so the agent can refine a file it already wrote for the user; the presented bytes are still copied into the app-owned store so reopen/export do not depend on the file remaining.

Replace/update: a later call in the **same generation** with the same title may replace the previous staged artifact (iteration). Across messages, each successful call is a new artifact unless we later add an explicit `replaceId` (post-MVP).

### 2. Artifact contract (`ChatArtifactV1`)

Extend the closed union in `renderer/shared/chat-artifacts.ts` **without weakening the image parser**.

New kind `"html"` (name TBD in implementation; do not reuse `"image"` keys):

- `id`, `title`, `mimeType: "text/html"`, `size`, **opaque** `mediaId` (not a filesystem path).
- Live IPC must **not** ship multi-megabyte HTML through the existing image-style base64 attachment if that blows chat JSON. Follow `docs/pi-gui-artifacts.md`: kinds that outgrow the inline envelope use an **app-owned media ID** and a narrow protocol (`chat:artifact-media` or reuse a host-owned fetch with stream/chat/generation/media authorization).
- Renderer parser: exact keys, version, kind, size bounds, id/title length. Unknown kinds still drop.

Durable persistence: assistant message holds metadata + `mediaId`; bytes live under Electron `userData`, keyed by chat/generation/toolCall, `0600`, crash-recoverable like `display-image-artifact-store`. Pending stages block send/copy/export for that chat.

### 3. Sandbox (the actual product risk)

Guest HTML is **untrusted**. Never `dangerouslySetInnerHTML` into the Aiden renderer. Never `allow-same-origin` together with `allow-scripts` on a frame that can see the parent origin.

MVP iframe contract:

- `sandbox="allow-scripts"` only (opaque unique origin).
- `srcdoc` built by **main**, or a `blob:` / custom protocol URL whose body main already wrapped. Renderer does not concatenate agent HTML.
- Host wrapper injects a **strict CSP**: `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- Parent CSP (`main-window.html`): add the **narrowest** `frame-src` that permits this guest (`blob:` and/or `'unsafe-inline'` srcdoc as required). Do not widen `script-src` of the privileged renderer.
- Block: remote `<script src>`, `<iframe>`, `<object>`, `<embed>`, `<meta http-equiv>`, `javascript:` URLs, inline event handler *as a defense in depth* (sandbox is primary). Allow only host-injected Chart.js / Plotly / KaTeX.
- No Node, no `window.aidenAPI`, no popups, no downloads from the guest, no camera/mic/geolocation/clipboard/filesystem.
- `postMessage` from guest is **ignored** in MVP (no Designer-style bridge). Inspect mode, if added later, is host-only overlays — not a guest-privileged API.

This is stricter than “whatever Antigravity does”; their widget sandbox is undocumented.

### 4. Host libraries (zero-dependency for the *project*)

Bundle **Chart.js, Plotly, and KaTeX** (plus KaTeX fonts) inside Aiden. Inject them in the host wrapper so agent HTML can call `Chart` / `Plotly` / render math **offline**. Record licenses in `THIRD_PARTY_NOTICES.md`.

- No CDN in preview or export.
- Export inlines wrapper + libs + artifact HTML into **one** `.html` file the user can open later.
- Do not add D3 / Three / React unless a later phase explicitly allowlists them as additional bundled hosts.

Aiden markdown already uses KaTeX in the **parent** renderer; the guest copy is a separate, sandboxed bundle. Do not share the parent KaTeX global with the iframe.

### 5. UI (Aiden language, Antigravity layout idea)

Read `docs/chatgpt-desktop-ui-inspiration.md` and the specimen HTML before building chrome. Use tokens from `renderer/styles.css` / `appearance.ts`.

**MVP (inline + expand):**

- Compact **artifact frame** in the assistant column (same max width as images, ~`max-w-[42rem]`, capped height, `bg-control` / well, separator border).
- Chrome: title, expand, export. No floating decorative badges.
- Activity feed line via `safeToolDescriptor("render_artifact")` (e.g. “Render artifact” + title).
- Expand: existing Dialog pattern (image lightbox analog) with a larger sandboxed frame. Keyboard focus, Escape, reduced motion.
- Fallback: if iframe blocked or HTML rejected, show an accessible file card (title + export still available when bytes exist).

**Not MVP:**

- Bolting Preview onto the compact Environment 480–720 overlay (Designer plan already warns this breaks the conversation at 1000px).
- Full “artifact tabs” work-surface (ChatGPT inspiration item 15) until inline frames work.
- Element inspector (Antigravity “click to inspect”). Nice; not required to ship the tool.

**Later:** one expanded work-surface tab that can host the same `mediaId` iframe, reusing Review/Files layout primitives — still not the Environment status card.

### 6. Slash command

Aiden’s `/` catalog is **app actions**, not Pi prompt templates (`docs/plans/completed/slash-commands-and-skill-invocation-plan.md`). Copying Antigravity `/generative_ui` as a hidden prompt would violate that.

- **v1:** no new slash row. Natural language + extension `systemPrompt` is enough.
- **v2 (optional):** a new slash `kind: "turn-instruction"` (or skill-like host instruction) named `/visualize` / `/generative-ui` that sends the remaining argument as a user turn **plus** a host-owned instruction to prefer `render_artifact`. Requires registry, availability (`workspace-required` + idle chat), tests, and must not invent a Pi extension command channel.



### 7. Surfaces that stay dark


| Surface                                             | Behavior                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram / scheduled / Assistant / Bots / subagents | Tool not contributed (same as `display_image`).                                                                                                                                         |
| iOS / Android                                       | No HTML iframe in v1. Optional later: “artifact on Mac” metadata or raster snapshot — separate plan. When viewing on ios and android say Cant view on this device. View in Aiden Agent. |
| Compaction / Pi history                             | Text acknowledgement only.                                                                                                                                                              |




### 8. Onboarding

No need to add anything on onbaording.

## Limits (starting numbers; tune with tests)


| Bound                      | Starting value                           |
| -------------------------- | ---------------------------------------- |
| HTML bytes per artifact    | 512 KiB UTF-8                            |
| Artifacts per response     | 4                                        |
| Artifacts per chat         | 40                                       |
| Staged HTML bytes per chat | 8 MiB                                    |
| Title                      | 120 chars                                |
| Tool wall time             | match other GUI tools; abort on `signal` |


Refuse oversize, non-UTF-8, and path escapes with a **specific** tool error the model can recover from.

## Phases



### Phase 0 — Contract spike (no product UI)

Prove in tests:

1. Closed-union parser accepts `html` and still rejects mutated `image` payloads.
2. Main wrapper CSP + `sandbox` flags: guest `fetch('https://example.com')` fails; guest cannot read parent DOM via `window.parent.document`.
3. `frame-src` change does not allow arbitrary renderer frames.

**Exit:** written GO on containment. If srcdoc + CSP cannot block network, stop and evaluate main-owned `WebContentsView` with `session.setPermissionRequestHandler` deny-all and partition — still not `<webview>`.

### Phase 1 — Extension + store + IPC

`render_artifact` tool, enablement gate in `prepareGeneration`, durable stage, `chat:artifact` present/reset, timeline descriptor, recovery blocking composer. Unit tests beside `display-image-extension.test.ts`. Register `npm run test:generative-ui` (or extend `test:display-image` if the suite stays cohesive) in `package.json` pretest.

### Phase 2 — Inline frame + expand + export

Renderer frame component, Dialog expand, save-dialog export of standalone HTML with inlined host libs. Tokenized chrome. Tests for parser, fallback, export bounds, keyboard, and “pending stage blocks copy/export”.

### Phase 3 — Host viz libraries + prompt quality

Bundle Chart.js, Plotly, KaTeX; document allowed globals in the tool description; golden fixtures (line chart, simple interactive control) that render without network. Theme variables passed into the wrapper (color-scheme, canvas/text tokens as CSS variables). Update `docs/pi-gui-artifacts.md`.

### Phase 4 — Productization

Add `/visualize` instruction slash; consider expanded work-surface tab. Inspector only if Phase 0–3 stay tight.

## Explicit non-goals

- Pi coding-agent extension marketplace or loading `.pi` plugins.
- Arbitrary CDN / npm from the artifact.
- Executing workspace Vite/React apps inside this frame (Designer Mode).
- Planning-artifact review (approve diffs/plans).
- Shipping HTML artifacts to Telegram or Aiden On The Go in this plan.
- Storing generated HTML in the user’s repository unless they export or the agent used `path` for a file they asked to keep.



## Tests (minimum)

- Extension: enablement matrix, path escape, oversize, cancel-before-present, replay never, HTML not in `AgentToolResult`.
- Store: crash recovery, pending blocks, quotas.
- Parser: exact keys, unknown kind drop, image parser unchanged.
- Sandbox: network blocked, parent DOM unreachable (jsdom or Playwright fixture).
- UI: live present, reload dedupe, expand/export, reduced-motion, empty/error fallback.
- Onboarding asset contract when the tile is added.



## Open questions (decide in Phase 0, do not block the plan)

1. `srcdoc` vs blob URL vs `WebContentsView` after the containment spike.
2. Whether live IPC uses `mediaId` only (preferred) or a small HTML preview inline.
3. Whether same-generation retitle replaces or appends.



## Implementation notes

- Do not register this on `piAgentRuntimeExtensions` global registry.
- Keep Designer and GenUI iframe helpers separate until both exist; then extract a shared **containment** module only.
- Papercuts: log iframe/CSP friction in `.papercuts/troubleshooting.md` as it occurs.

