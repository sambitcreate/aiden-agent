# Sidebar Chat Activity Plan

Status: Complete — shipped implementation 2026-08-16
Date: 2026-08-16
Related: `docs/chatgpt-desktop-ui-inspiration.md`, `docs/plans/performance-stability-efficiency-plan.md`

## Outcome

Every visible chat row shows a compact Working ring while its foreground or scheduled model generation owns that chat. The signal survives renderer reloads and chat/workspace navigation without polling or persisting transient state.

## Decisions

1. Main-process generation ownership is authoritative. A revisioned stream-to-chat registry publishes complete activity snapshots on visible state changes, so concurrent scheduled work is never silently omitted.
2. The renderer subscribes before requesting an initial snapshot and applies only monotonic revisions, closing notification/read races and allowing a later event to self-heal a missed earlier event.
3. Foreground `agentBusy` is overlaid for immediate append/start feedback before main accepts the generation.
4. The sidebar uses a static open-ring glyph with `aria-busy` and a Working label. It has no polling, infinite CSS animation, filter, shadow, or continuously promoted layer.
5. The ring shares the trailing row area with keyboard shortcut hints and uses Aiden's semantic accent token.

## Reference verdict

GooeyPi uses an indefinitely rotating Lucide loader for each running session. t3code's newer sidebar intentionally removed perpetual shimmer because background work should remain legible without repainting every display frame. Aiden adopts t3code's efficiency decision while retaining the compact ring silhouette from the supplied reference image.

## Verification contract

- Registry tests cover idempotence, overlapping streams, stream reuse, lifecycle wiring, and initial snapshots.
- Renderer tests cover payload validation, duplicate ids, stale revisions, settled state, accessibility, shortcut coexistence, and the absence of animation classes.
- IPC inventory, TypeScript, build, full project tests, React Doctor, two fresh adversarial reviews, and pull-request CI are required before merge readiness.
