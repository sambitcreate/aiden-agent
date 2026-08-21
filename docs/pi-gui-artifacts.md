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

## Extension points

- Add future payloads to the closed `ChatArtifactV1` union in `renderer/shared/chat-artifacts.ts`; do not weaken an existing parser.
- Keep the live operation envelope versioned independently from artifact payload versions. Its reserved `reset` operation may be used only when the host can prove that the corresponding presentation effect was rolled back; an ordinary provider retry is not such a rollback.
- Contribute GUI tools through a chat-scoped `PiAgentRuntimeExtension`, not `buildAgentTools` or the process-global extension registry.
- Give each artifact kind a main-owned authority check, bounded transport, durable representation, renderer parser, accessible fallback, and live/reload/deduplication tests.
- Keep large or seekable media out of Pi history. If a future kind outgrows the bounded inline attachment envelope, use an opaque app-owned media ID and narrow protocol rather than exposing a filesystem path.
