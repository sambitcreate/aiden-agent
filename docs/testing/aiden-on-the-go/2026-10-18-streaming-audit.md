# Native streaming audit — 2026-10-18

Branch: `fix/ios-streaming-rendering`. Baseline: `a74edb0f6` (origin/main).

## Reference and scope

The user confirmed `anomalyco/opencode`. Inspected its complete, non-truncated `dev` tree at `63c1a27af5a391d9caa55b82694f496911e1859b` (2026-10-18): no Swift sources/native iOS package, only generated desktop iOS icon assets. The applicable comparison is its shared app renderer, not a separate native client. No upstream code copied and no dependencies added.

Pinned reference files under `https://github.com/anomalyco/opencode/blob/63c1a27af5a391d9caa55b82694f496911e1859b/`:
- `packages/ui/src/hooks/create-auto-scroll.tsx`: explicit user-scrolled latch; recognizes its own deferred scroll events; ResizeObserver follows after layout/before paint; immediate follow avoids catch-up animations; forced jump alone resets the latch. Aiden's existing native controller/observer supplies the analogous behavior.
- `packages/session-ui/src/components/markdown-stream.ts`: full/live/code blocks, incomplete-tail healing, open-code incremental append, whole-document handling for reference definitions, stable block completion.
- `packages/session-ui/src/components/markdown.tsx`: retains a live block's DOM through completion to preserve selection; worker-backed projection and stable owners. Aiden already caches sealed Markdown chunks and shares layout between live/settled content; no new parser dependency needed for these fixes.
- `packages/session-ui/src/components/markdown-worker-queue.ts`: latest pending highlight request wins per key, disposal cancels stale queued work.
- `specs/v2/event-stream-architecture.md`: bounded per-connection delivery, overflow closes a slow subscriber instead of silently corrupting it. Aiden's existing sequence/gap reconciliation remains authoritative.

The initial community comparison was superseded by the user's explicit repository clarification.

Aiden's owned Workspace streams already buffer text at 50 ms, flush before structural/terminal events, render sealed Markdown chunks, preserve warm replay cursors, and rebuild cold streams from zero. Bot durable sessions use their own cumulative-partial feed. Both native apps already reconcile authoritative transcripts after runs finish. No protocol, model catalog, permission, onboarding, or provider changes.

## Verified gaps and changes

- The newer iOS Bot session transcript used a distance-only Bool for follow. Content growth could mark the reader away before scrolling, and immediate scrollTo could precede layout. Reused `AidenTranscriptFollowController` and `AidenChatScrollObserver`, with initial/size-change anchors, deferred generation-fenced snaps, explicit Send reset, and the existing Jump to latest control. The shared latch handles pan/momentum, keyboard/VoiceOver scrolling and layout growth. Partial Bot Markdown now opts into the existing streaming reveal treatment (Reduce Motion/Low Power remain handled by that renderer).
- Both native `AidenForeignRunProjection`s ignored accepted `timeline` events. Cross-device runs therefore lost chronological activity, visualizing labels, and generated-image progress while text and basic tool names arrived. Retain the timeline, publish it through the existing activity/placeholder UI, arm completed-image arrival reveals, and clear it on gap snapshots, owned-stream takeover and successful settlement. iOS initial attachment flushes retained text when a timeline is present.
- Existing visual limitations remain explicit: Workspace inline visual snapshots are captured by the Mac only after reply commit; iOS already performs bounded late-snapshot reads. The durable Bot session wire transcript has no inline visual DTO. Adding live rich visual payloads would require a separate shared protocol/runtime feature; these fixes do not claim to provide it.

## Coverage

Added production SSE-to-view-model coverage for a foreign timeline flushing buffered text, chronological rendering eligibility, image progress and arrival reveal; both native projection suites cover timeline replay ordering and gap reset. Replaced the obsolete Bot distance test with the shared follow controller's behavior across large growth, manual scroll-away, and explicit jump/send.

Validation: iPhone 17 Pro simulator, iOS 26.2, UDID `FD028BE8-9229-4FDF-B2C4-804059CF5D11`, Xcode 27.0: full AidenOnTheGoTests target 1,069 tests, six skipped, zero failures (1,063 passed). Android full JVM suite: 947 passed; lintDebug and compileDebugAndroidTestKotlin passed. `npm run test:ios-release` passed. Final focused build/test after positioning the jump button above the measured footer passed (5 tests). No physical-device, VoiceOver, paired-Mac end-to-end, or visual acceptance claimed.
