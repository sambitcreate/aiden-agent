# Pi GUI artifacts

Aiden can present structured, tool-produced artifacts in an attended desktop chat without asking a model to emit Markdown paths.

## Current image path

1. `prepareGeneration` contributes `aiden.gui.display-image` only to an attended workspace chat with non-`none` access.
2. The Pi-native `display_image({ path })` tool accepts a workspace-relative raster path. Main verifies the pinned workspace root, lexical containment, file identity, regular-file status, raster structure, compressed bytes, decoded dimensions, and pixel count. APNG plus animated or out-of-bounds GIF/WebP payloads are refused for now.
3. Before the tool reports success, main stages the normalized image bytes in an app-owned durable store keyed by chat, generation, and tool call. It then emits a `ChatArtifactEventV1` `present` event. The tool result returned to Pi is a short text acknowledgement and never contains image bytes.
4. The renderer validates the event before retaining it, renders the image immediately, falls back to a file card on browser decode failure, and deduplicates it against the terminal chat snapshot. Automatic provider retries retain completed, non-replayable image effects.
5. Main persists the normalized image on the assistant message through Aiden's existing bounded attachment contract and clears its staged copy. While a staged response is unresolved, the main-owned chat-read status keeps the composer blocked across navigation, and further sends, copies, and exports for that chat are refused. Startup recovery deduplicates a crash-left stage against ChatStore or restores each interrupted generation as an image-only assistant message with a fixed interrupted-response marker, so reopening, copying, and exporting do not depend on the source file still existing.

Each image is capped at 20 million decoded pixels. A response is capped at 8 MB and 40 million decoded pixels; a chat is capped at 32 MB, 64 million decoded pixels, and 100 assistant-displayed images. Durable in-flight stages share the same 32 MB and 64-million-pixel process-wide ceilings.

No raw local path, `file://` URL, SVG, or model-authored remote URL crosses into image rendering.

## Current HTML path

Design and roadmap: [Inline Generative UI](superpowers/specs/2026-10-08-inline-generative-ui-design.md). Phase 1 (desktop inline HTML) is described here.

1. **Availability.** `prepareGeneration` contributes `aiden.gui.generative-ui` to every attended desktop chat, with or without a workspace, subject to Settings → Appearance → **Inline visuals**:
   - **Automatic** (default): the tools are always registered.
   - **Only when I ask**: registered only on `/visualize` turns.
   - **Off**: never registered.

   The mode travels as `GenerationParams.inlineVisuals`. Telegram, Assistant, Bots, scheduled runs, and child agents do not inherit the extension. Reading a workspace `.html` file (`path`) still requires a workspace with file access.
2. **Tools.**
   - `render_artifact({ title, html } | { title, path }, layout?)` validates UTF-8 HTML (512 KiB), rejects remote scripts, frames and `javascript:` URLs, stages the bytes in `generative-ui-artifacts.json` (`0600`), and emits a `kind: "html"` `ChatArtifactEventV1` with an opaque `mediaId`. Its tool result is text only.
   - `visualize_guide({ modules })` returns design, HTML, chart, and interactivity guidance on demand (`main/services/generative-ui-guide.ts`), which keeps the system prompt short.

   Replay is `"never"` for both tools.
3. **Placement.** Each visual renders right after the activity row of the `render_artifact` call that produced it.
   - The message stores `htmlArtifactPlacements: [{ mediaId, toolCallId, layout? }]` beside `htmlArtifacts`, never inside it, because older builds drop the whole artifact list on an unknown key. The placement parser ignores unknown keys, so later fields never drop a placement.
   - Placement ids are the timeline's public `call-N` ids. `generative-ui-placements.ts` translates Pi's raw ids.
   - Artifacts with no placement or no matching step trail the response.
   - The live `present` event carries `toolCallId`.
   - **Width.** `layout` is `column` (default: the reading column, about 690px) or `wide`. A wide visual spans the chat pane inside a 1.5rem gutter, up to 80rem, and follows the window. It measures the pane through a size container on the transcript's scroll content, and stays in the column beside a docked Quick View card. Only `layout: "wide"` is stored. A same-title revision keeps its first position but takes the latest layout. Drafts follow the layout as soon as the streamed arguments name it.
4. **Preview.**
   - The renderer loads a **main-built** preview over `chats:htmlArtifactSrcdoc`. Main wraps the HTML and serves it from `aiden-genui://preview/<64-hex-token>` (`generative-ui-preview-store.ts`), with the guest CSP as a **response header**.
   - The iframe uses `src` (not `srcDoc`) and `sandbox="allow-scripts"` only. Parent `script-src` is not widened, and parent `frame-src` is `'self' aiden-genui:`.
   - Guest CSP sets `connect-src 'none'` and allowlists only the exact host-library URLs.
   - The frame is borderless and as tall as its content (64–1600px). The title, Expand and Export sit in a caption row below it. A neutral focus ring shows when focus arrives in the guest by Tab; a click into a visual draws none (the host cannot see focus moves inside a cross-origin guest).
5. **Guest bridge.** A host script injected before any model code:
   - reports content height;
   - relays Escape;
   - announces `ready` so the host can send the theme before the document loads;
   - applies live theme messages from the parent, which send allowlisted, sanitized semantic tokens (`renderer/shared/generative-ui-theme.ts`);
   - exposes a frozen `window.aiden` with `sendPrompt`, `theme` and `series`.

   The host accepts only the closed message schema in `generative-ui-bridge.ts`, and only from that frame's window. `sendPrompt` never sends by itself. A visual can never send as the user. Browser signals cannot prove which frame the user acted in: a sandboxed guest can `focus()` itself, `navigator.userActivation` is page-wide, and out-of-process frames hide hover from the page (three review rounds broke heuristics built on them, including in Electron). So an admitted request (at most 2,000 characters, one per 3 s per visual, `admitGuestPrompt`) only shows an Aiden-drawn confirmation chip under the visual quoting the text, with **Send** and **Dismiss**. The user's click on that app UI sends a normal visible turn through the composer's send path. While a run is starting, running, detached, or queued, the action reads **Add to draft** and puts the text in the composer instead. A newer request replaces the pending one.
6. **Kit.** Main serves `aiden-genui://aiden-ui.css`, a generated class kit that mirrors the shared components (`generative-ui-kit.ts`). When no renderer theme is supplied (export), the light default tokens are emitted.
7. **Streaming drafts.** While `render_artifact` arguments stream (and only when the tool is registered for the turn), main writes the partial HTML into a single-use draft preview whose CSP allows only the bridge's nonce. Partial markup renders progressively, and model scripts wait for the final artifact. The `draft` and `draft_end` events carry only the preview URL; draft HTML never reaches the renderer as a string. The presented artifact replaces the draft in the same row: the `present` event carries a ready preview URL (`src`), and the final frame starts at the draft's last height.
8. **Libraries.** Host Chart.js, Plotly, and KaTeX load from the `aiden-genui:` protocol (exact library names). Export inlines those libraries and the kit into one offline `.html` file and fails if a library is missing. There is no CDN.
9. **Persistence and clients.** Persistence stores metadata, the `mediaId`, and placements on the assistant message. Pending HTML stages share the existing image-recovery composer gate. iOS and Android still show the title plus “Can't view on this device. View in Aiden Agent.”; the Remote contract is unchanged in Phase 1, and turns sent from a paired phone run with inline visuals off.

Limits: 4 HTML artifacts per response, 40 per chat, 8 MiB staged HTML per chat, titles 1–120 characters without controls.

## Native visuals (`render_ui`)

The model composes a visual from Aiden's own component catalog instead of writing HTML. The guide and system prompt tell it to prefer `render_ui` and keep `render_artifact` for custom drawing or scripting.

1. **Markup.** `render_ui({ title, layout?, markup })` takes Aiden UI Markup (AUM): JSX-like catalog elements, `{expressions}` over `<Data name="…">{json}</Data>` and `<Visual state={{…}}>`, and actions (`sendPrompt`, `setState`, `openUrl`, `copy`). The catalog (`renderer/shared/aiden-ui/catalog.ts`) is the single source of truth. The `visualize_guide` `catalog` module is generated from it, and a test keeps the guide's example compiling cleanly.
2. **Compiler.** `renderer/shared/aiden-ui/` holds the shared pure TypeScript used by main, the renderer and the CLI:
   - **Parser (`parse.ts`).** Tolerant: auto-closes elements at a stream cut, drops an unfinished attribute, and treats `Data`, `Code`, `Math` and `Markdown` bodies as raw text.
   - **Expressions (`expression.ts`).** Expressions become a JSON AST and never JS. There is no `-`, `*`, `/`, method call or arrow function.
   - **Compile (`compile.ts`).** Unknown elements are dropped but their content kept; bad props are dropped. Every repair becomes a diagnostic returned to the model in the tool result.
   - **Evaluator (`evaluate.ts`).** Pure, own-properties only, prototype keys blocked, with a step budget and a 10,000-item list cap. Its semantics are pinned by `fixtures/expressions.json`, which the Swift and Kotlin ports will reuse.
   - **Fallback text (`fallback-text.ts`).** Renders the visual's initial state as Markdown-ish text for memory, the CLI and clients without a renderer.
3. **Contract.** `ChatUiVisualV1 { version, kind: "ui", id, toolCallId?, title, catalogVersion, tree, dataJson?, state?, fallbackText, layout? }` lives in the message field `uiVisuals`. It is parsed leniently per entry, so one bad visual never hides the others. Key names avoid every key Aiden Remote clients treat as private (`isWireSafeKey`), and the model's data is stored as a JSON string (`dataJson`) so its keys are never wire keys.
4. **Limits.** 2,000 nodes, depth 24, 64 KiB of data, a 256 KiB tree, 4 KiB of state, 8 visuals per response and 60 per chat; `<Each>` repeats at most 500 times.
5. **Live.** While `markup` streams, main compiles drafts every 250 ms and sends `ui_draft` events; `draft_end` retracts them. The presented visual arrives as a `ui` event, and a same-title revision keeps its first id and position.
6. **Renderer.** `AidenUiBlock` (`renderer/components/aiden-ui/`) draws the tree with the shared primitives in `ui.tsx` and `ui-primitives.tsx`. Visuals are placed after their tool row like HTML visuals.
   - Bound inputs and `setState` run locally.
   - `sendPrompt` goes through the shared visual follow-up path, and is added to the composer while a reply runs.
   - `openUrl` accepts only https links and always asks first.
   - `copy` uses the clipboard.
   - Local state is saved 800 ms after the last change (`chats:updateUiVisualState`).
   - Charts use a lazily loaded Chart.js with the live `--chart-1…8` tokens, and every chart has a screen-reader table of its numbers.
7. **CLI.** `render_ui` compiles with the same compiler and prints the fallback text.
8. **Safety.**
   - **The compiler never throws.** Flattened unknown elements count toward the depth cap, and the parser stops nesting past 64 open elements.
   - **Renders are budgeted.** One render draws at most 2,000 loop iterations and 4,000 components in total, so nested `<Each>` cannot multiply.
   - **Follow-ups need confirmation.** A native button's `sendPrompt` waits in the same Aiden-drawn confirmation chip as HTML visuals, because its label is model-written and need not match the text it sends.
   - **Saved state follows the newest copy.** A newer saved state re-seeds an untouched visual. In a visual the user has changed, it fills in only the keys that are missing.
9. **Downgrade.** Older builds rebuild messages from the fields they know, so an older build that rewrites a chat drops `uiVisuals`. A reply that was only a visual then shows as an empty bubble there. HTML visuals only lose their placement.

## Extension points

- Add future payloads to the closed `ChatArtifactV1` union in `renderer/shared/chat-artifacts.ts`; do not weaken an existing parser. Interactive HTML widgets use kind `"html"` and a sandboxed frame, not Markdown HTML.
- Keep the live operation envelope versioned independently from artifact payload versions. Its reserved `reset` operation may be used only when the host can prove that the corresponding presentation effect was rolled back; an ordinary provider retry is not such a rollback.
- Contribute GUI tools through a chat-scoped `PiAgentRuntimeExtension`, not `buildAgentTools` or the process-global extension registry.
- Give each artifact kind a main-owned authority check, bounded transport, durable representation, renderer parser, accessible fallback, and live/reload/deduplication tests.
- Keep large or seekable media out of Pi history. HTML bytes stay in the app-owned store and cross the renderer only as a main-owned `aiden-genui://preview/` URL, never as renderer-concatenated `srcDoc` or a workspace `file://` path.
