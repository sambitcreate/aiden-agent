# Design mode

Status: active 2026-10-31. Spec v2 (infinite canvas) and P0/P1 plans written. P0 (retire Studio) done on branch `claude/design-mode-deep-dive` (3 commits, not yet pushed); P1 is next. P2–P5 plans are written before each phase.

- Spec: `docs/superpowers/specs/2026-10-31-design-mode-design.md`. Plans: `docs/superpowers/plans/2026-10-31-design-mode-p0-retire-studio.md`, `docs/superpowers/plans/2026-10-31-design-mode-p1-layout.md`.
- It replaces Design Studio (DS-1a, #385). P0 deletes the Studio code. It keeps the canvas, studio assets, the `finishTurn` harness, `generation-stream` and the `ChatOwnerV1` parser, and leaves data on disk.

## Owner decisions (2026-10-31)

- Attached to a workspace or an Aiden private folder (#667 removed no-workspace chats).
- Ships to people: default-on with a kill switch in P5. Until then behind `AIDEN_EXPERIMENTAL_DESIGN_MODE`.
- Desktop only now, Remote-ready later. The Remote projection must not expose `designMode` yet.
- The right side is an infinite canvas "like Create Images / Figma / open-design / Paper" where the agent creates things and the person points and annotates (owner, 2026-10-31). This superseded v1's browser-tabs canvas.

## Design choices

- Designs are workspace files (`design/<slug>.html`); the canvas document (`userData/design-canvases/<chatId>.json`, revision CAS) only records frames and comments.
- Canvas reuses `StudioCanvas` (xyflow). Frames: file, artifact, image, note, group. At most 6 live iframes; the rest show `capturePage` snapshots.
- Files are served by a new `aiden-design:` scheme: per-chat grant token, realpath containment, no network CSP, vendored libs under `__aiden/lib/`, injected bridge script. Iframes are `sandbox="allow-scripts"` only.
- Comments copy open-design: `data-aiden-comment` IDs written into the source, fuzzy re-anchoring (anchored, stale, lost), an `<attached-design-comments>` scoped block. Draw marks are normalised 0..1.
- Agent tools: `canvas_read` (tldraw-style context), `canvas_place_frame`, `canvas_update_frame`, `canvas_remove_frame`, `canvas_focus`, plus `design_mode` (consent card, `aiden_open` pattern, offered only when Inline visuals is `automatic`).
- Widths: chat 420 (360–560); canvas at least 480. Sidebar collapses below 1100 px; below 840 px the window widens to 1280 or shows a banner. Escape never leaves design mode.
- open-design (nexu-io) has no infinite canvas; its value is picking, comment anchoring and agent context. Avoid its CDN React/Babel, `allow-same-origin` and foreignObject screenshots.
- Owner (2026-10-31): ship design mode only. Create Images is being reworked in another thread, so keep edits to `renderer/canvas/*` and `studio/feature-flags.ts` additive and check for its open PRs before touching them.

## P0 notes (2026-10-31)

- Stale `/design` and `/design/$projectId` links use `beforeLoad: redirectRetiredRoute` (in `renderer/main/studio-capability-route.tsx`) and land on `/`. P1 replaces these routes.
- `llm-client` refuses a chat with any `owner` ("belongs to a feature that is no longer available"), keeping the old `resolveGenerationProfile` refusal for hidden `design-project` chats. The rule is `chatRunRefusal(chat)` in `renderer/shared/chat-visibility.ts` (keyed on surface "feature"), tested in `chat-visibility.test.ts`.
- `generation-harness.ts` (`createGenerationHarness`) is gone; `llm-client` builds `new PiAgentRuntimeHarness(...)` directly. The dead `inputClosed` admission flag was removed too. Extensions compose inline as base, then advisor, then codemode.
- ⌘⇧D is unbound after P0, but `dictation.toggle` still declares `defaultBinding: "Command+Shift+D"` with `defaultEnabled: false`. P1's ⌘⇧D must resolve that collision.
- Under Node, TanStack router-core always runs in server mode, so a `beforeLoad` redirect sets `router.state.redirect` without following it; tests follow it with `router.navigate`.
