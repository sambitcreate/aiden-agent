# 2026-09-19 — Tool approval cancellation admission

`ToolApprovalCoordinator.cancelStream` now closes approval admission for the stream before draining pending requests. Asynchronous child preparation with its own still-live signal cannot publish a new prompt after generation cancellation. Detachment remains distinct; later detachment cannot downgrade cancellation. `releaseStream` removes bounded stream state after the generation settles. Individual signal aborts still cancel only their own prompt. Shutdown permanently closes coordinator admission before draining callbacks and clearing stream state.

Evidence: six regressions failed against baseline 5cc831a1. Tests cover delayed fresh-signal requests, cancellation before the first prompt, cross-stream isolation, cancellation/detachment ordering, release cleanup, post-shutdown requests, and reentrant withdrawal. Tests live in the already registered `main/services/tool-approval.test.ts`. Existing owner-document and one-shot decision guards remain intact. No public approval payload/outcome changes, native-client behavior changes, UI changes, or onboarding changes.

Read-only reference concepts: OMP checks signal cancellation after permission waits; Pi removes pending UI requests and abort listeners; Prime Agent closes UI admission before pending-request cleanup. Reference heads and file SHA-256 digests are recorded in the campaign's lane 31 JSON. No upstream code copied.

Validation status and full PR head are recorded in `/Users/sambitbiswas/projects/aiden-macos/.papercuts/upgrade-campaign-20260919/31-tool-approval.json`. No public merge or release is authorized by this lane.

Local validation: 70/70 focused checks, full `npm run type-check`, `npm run lint`, and `git diff --check` passed. Full npm test remains owned by campaign integration.
