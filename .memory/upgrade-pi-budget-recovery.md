# Pi budget ownership and startup recovery — 2026-09-22

Base: origin/main `c8c09e0d2`; branch `feature/pi-budget-recovery`.

## Audit and bounded decision

Read the September 10 and 16 Notion Feature Digests as dated research. Current Aiden locks both `@earendil-works/pi-agent-core` and `pi-ai` to `0.84.4`. Current upstream Pi at `95fbc04997eaee961eb673fa7923e9220609ebd5`, `packages/agent/package.json`, reports `0.87.0`; the digest's `0.85.1` is not an upgrade target. Preserve pins, journal format, rollout receipts and audited default compaction settings. A paired dependency upgrade requires the existing migration, parity and installed-package gates, outside this bounded patch.

Upstream `earendil-works/pi/packages/coding-agent/src/core/settings-manager.ts` resolves exact `provider/modelId` reserve/retained-tail overrides before ordinary settings/defaults, validating non-negative safe integers. Aiden already has model-context-window-aware VCC clamping and generation preflight budgets, but has no persisted per-model override configuration. Defer that feature: a coordinator-only override would not configure production callers or reconcile preflight/emergency budgets. No coding-agent dependency or unused configuration seam is added.

Codex PR #45820 (merged `f2b5b81f39fba7d1172e4a5e65a427f029a39479`) continues work only with atomic idle/previous-turn and environment/permission checks. Codex #45807 (merged `4d2807023aae3ee317d39a9868fb187618699df2`) records interrupted snapshot state. Aiden already owns durable interrupted operations and no-repeat effect boundaries. Preserve its explicit continuation policy; do not import automatic daemon continuation or replay external effects. #206 partial subagent notes was inspected and remains untouched.

## Changes

- Compaction pressure and prior-turn repair use content estimates when the assistant or fallback usage anchor belongs to another provider/model. Reopened checkpoints cannot suppress pressure measurement merely because the foreign assistant predates the checkpoint. Same-model thresholds, no-anchor compatibility, retained-tail selection and summaries remain upstream-owned.
- Keep transient provider retry and its reset rules independent of usage ownership; response aliases must not suppress retries.
- Effect-store initialization is single-flight. Concurrent callers cannot run a second restart sweep after the first caller admits a new operation. Failed initialization remains closed and retryable. Existing dispatched never-replay effects remain unknown, safe effects remain interrupted, and prepared effects cancel without dispatch.

## Verification and review

Fourteen new regressions failed against unchanged main and passed with fixes (89/89 focused). They cover model/provider identity, small/large content, zero-usage foreign anchors, checkpoint reopening, overlapping initialization, and failed initialization retry. Independent Sol medium blast-radius review found the response-alias retry regression in the first patch; fixed with a fifteenth regression. Independent adversarial review found no new replay route; its no-anchor concern is existing audited behavior, protected by the production test `preflight without valid usage semantically compacts before provider I/O`.

Both independent reviewers re-reviewed the retry fix and reported no remaining actionable findings.

No shared DTO, transcript/activity shape or UI changes. Inspected native compaction consumers in iOS `AidenChat.swift` and Android `AidenChat.kt`; both continue consuming unchanged `compact_context` activity. No onboarding feature is advertised. Existing test scripts register both modified test files. Native UI suites are not required for this host-only runtime patch.

Final local/hosted verification and review status are recorded in the PR; do not infer merge, release, or installed acceptance from this note.
