# Inline generative UI (Phase 1, desktop)

Spec: `docs/superpowers/specs/2026-10-08-inline-generative-ui-design.md`. Plan: `docs/superpowers/plans/2026-10-08-inline-generative-ui-phase-1.md`. Branch `feature/inline-generative-ui`.

## Decisions that are easy to undo by accident

- **Placement lives beside, not inside, the artifact.** `ChatMessage.htmlArtifactPlacements: [{mediaId, toolCallId}]`. `parseChatHtmlArtifacts` is all-or-nothing with exact keys, so adding a key to `ChatHtmlArtifactV1` makes older builds drop every artifact on the message. The placement parser is deliberately lenient.
- **Public call ids.** Timeline steps publish `call-N` ids (`GenerationTimelineProjector.toolStarted`), not Pi's raw provider ids. Anything that matches a visual or draft to a row must translate through `timeline.publicToolCallId`. `generative-ui-placements.ts` and the draft session already do. Unit tests with identical ids on both sides will not catch a regression here.
- **HTML never reaches the renderer as a string.** Previews and drafts are `aiden-genui://preview/<token>` URLs from `generative-ui-preview-store.ts` (Electron-free and testable; the protocol delegates to it). Drafts are single-use streaming responses whose CSP is nonce-only (`generativeUiDraftCsp`), so model scripts never run before the final artifact.
- **Bridge contract.** The schema is closed (`renderer/shared/generative-ui-bridge.ts`): escape, ready, resize, prompt. The host accepts a message only when `event.source === iframe.contentWindow`, and rejects it when `contentWindow` is null. `window.aiden` is frozen and non-configurable, so model code must not declare `const aiden`.
- **sendPrompt admission** (`decideGuestPrompt`): the frame must hold focus; only the first prompt after focus enters the frame (window blur with `activeElement === iframe`) auto-sends; there is a 3 s cooldown on `performance.now`. Everything else is staged with `stageComposerText` and is never auto-sent.
- **Height** is measured from the root's bounding rect, not `scrollHeight`, which never drops below the viewport. Inline documents drop `min-height: 100%` and use `body { display: flow-root }`. `font-size` is set on `body` only, so `rem` stays 16px (Design Studio and exports depend on it).
- **Theme.** Guests receive only allowlisted variables (`GENERATIVE_UI_THEME_VARIABLES`), validated by `sanitizeGenerativeUiThemeVars`. Radius tokens are Tailwind `@theme inline` constants (not present at runtime), so the kit uses fallbacks. Without a renderer theme (export), `GENERATIVE_UI_DEFAULT_THEME_VARS` is emitted. The light `--chart-*` values are deepened bot-avatar hues; dark mode uses the hues as-is.
- **Handoff.** Visuals render inside `AssistantResponse` rows, so the iframe remounts once at stream→settled handoff. A module-level preview/height cache avoids a refetch and a height jump, but guest state set during a running turn resets. This is an accepted trade-off, open for a later restructure.
- **Availability.** Visuals are available in every attended desktop chat. `path` needs a workspace with file access. `AppearanceConfig.inlineVisuals` is sent per turn as `GenerationParams.inlineVisuals`.
- **Remote/mobile.** Unchanged in Phase 1 (contract revision 26). Placements and drafts are desktop-only until Phase 3 (`chat-visuals-v1`).

## Tests

- `npm run test:generative-ui`: units, the vendor-script test, and Chromium containment (bridge, draft, shrink, rem).
- happy-dom component tests: `renderer/components/html-artifact-frame.test.tsx`, `message-list-visuals.test.tsx`. Compare DOM nodes as booleans; printing a happy-dom node in an assert diff hangs.
- e2e: `settings-unification.spec.ts` "inline visuals preference…".
