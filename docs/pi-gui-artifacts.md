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
   - `render_artifact({ title, html } | { title, path })` validates UTF-8 HTML (512 KiB), rejects remote scripts, frames and `javascript:` URLs, stages the bytes in `generative-ui-artifacts.json` (`0600`), and emits a `kind: "html"` `ChatArtifactEventV1` with an opaque `mediaId`. Its tool result is text only.
   - `visualize_guide({ modules })` returns design, HTML, chart, and interactivity guidance on demand (`main/services/generative-ui-guide.ts`), which keeps the system prompt short.

   Replay is `"never"` for both tools.
3. **Placement.** Each visual renders right after the activity row of the `render_artifact` call that produced it.
   - The message stores `htmlArtifactPlacements: [{ mediaId, toolCallId }]` beside `htmlArtifacts`, never inside it, because older builds drop the whole artifact list on an unknown key.
   - Placement ids are the timeline's public `call-N` ids. `generative-ui-placements.ts` translates Pi's raw ids.
   - Artifacts with no placement or no matching step trail the response.
   - The live `present` event carries `toolCallId`.
4. **Preview.**
   - The renderer loads a **main-built** preview over `chats:htmlArtifactSrcdoc`. Main wraps the HTML and serves it from `aiden-genui://preview/<64-hex-token>` (`generative-ui-preview-store.ts`), with the guest CSP as a **response header**.
   - The iframe uses `src` (not `srcDoc`) and `sandbox="allow-scripts"` only. Parent `script-src` is not widened, and parent `frame-src` is `'self' aiden-genui:`.
   - Guest CSP sets `connect-src 'none'` and allowlists only the exact host-library URLs.
   - The frame is borderless and as tall as its content (64–1600px). The title, Expand and Export sit in a caption row below it. A focus ring shows while keyboard focus is inside the guest.
5. **Guest bridge.** A host script injected before any model code:
   - reports content height;
   - relays Escape;
   - announces `ready` so the host can send the theme before the document loads;
   - applies live theme messages from the parent, which send allowlisted, sanitized semantic tokens (`renderer/shared/generative-ui-theme.ts`);
   - exposes a frozen `window.aiden` with `sendPrompt`, `theme` and `series`.

   The host accepts only the closed message schema in `generative-ui-bridge.ts`, and only from that frame's window. `sendPrompt` sends a normal visible turn only on a gesture attributed to that visual by `createFrameGestureTracker` (`renderer/shared/generative-ui-gesture.ts`): activation that began while it held focus, a click into it under the pointer with no page input of its own, or a Tab into it. Page activation alone does not count, because it is page-wide; nor does focus alone, because a guest can `focus()` itself. There is a 3 s cooldown. While a run is starting, running, detached, or queued, the prompt is staged into the composer instead. A prompt without a gesture is staged at most once per visual until the user next sends.
6. **Kit.** Main serves `aiden-genui://aiden-ui.css`, a generated class kit that mirrors the shared components (`generative-ui-kit.ts`). When no renderer theme is supplied (export), the light default tokens are emitted.
7. **Streaming drafts.** While `render_artifact` arguments stream (and only when the tool is registered for the turn), main writes the partial HTML into a single-use draft preview whose CSP allows only the bridge's nonce. Partial markup renders progressively, and model scripts wait for the final artifact. The `draft` and `draft_end` events carry only the preview URL; draft HTML never reaches the renderer as a string. The presented artifact replaces the draft in the same row: the `present` event carries a ready preview URL (`src`), and the final frame starts at the draft's last height.
8. **Libraries.** Host Chart.js, Plotly, and KaTeX load from the `aiden-genui:` protocol (exact library names). Export inlines those libraries and the kit into one offline `.html` file and fails if a library is missing. There is no CDN.
9. **Persistence and clients.** Persistence stores metadata, the `mediaId`, and placements on the assistant message. Pending HTML stages share the existing image-recovery composer gate. iOS and Android still show the title plus “Can't view on this device. View in Aiden Agent.”; the Remote contract is unchanged in Phase 1, and turns sent from a paired phone run with inline visuals off.

Limits: 4 HTML artifacts per response, 40 per chat, 8 MiB staged HTML per chat, titles 1–120 characters without controls.

## Extension points

- Add future payloads to the closed `ChatArtifactV1` union in `renderer/shared/chat-artifacts.ts`; do not weaken an existing parser. Interactive HTML widgets use kind `"html"` and a sandboxed frame, not Markdown HTML.
- Keep the live operation envelope versioned independently from artifact payload versions. Its reserved `reset` operation may be used only when the host can prove that the corresponding presentation effect was rolled back; an ordinary provider retry is not such a rollback.
- Contribute GUI tools through a chat-scoped `PiAgentRuntimeExtension`, not `buildAgentTools` or the process-global extension registry.
- Give each artifact kind a main-owned authority check, bounded transport, durable representation, renderer parser, accessible fallback, and live/reload/deduplication tests.
- Keep large or seekable media out of Pi history. HTML bytes stay in the app-owned store and cross the renderer only as a main-owned `aiden-genui://preview/` URL, never as renderer-concatenated `srcDoc` or a workspace `file://` path.
