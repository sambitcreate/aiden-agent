# Pi scope reconciliation — 2026-09-22

Read-only follow-up to PR #215, preserved at `5f9f5e6e28de1eb0f0a1f8ecb323ccc79c954966`. Fresh `origin/main` is still `c8c09e0d2`. The initial read-only audit preserved #215; its subsequent small-window finding is implemented separately on `feature/pi-small-context-budgets`. No dependency upgrade has been made.

## Already covered

- **Pinned runtime compatibility:** package/lock/installed Pi packages consistently resolve to 0.84.4. Imported compaction, retry, Session/JSONL and NodeExecutionEnv runtime exports exist and production call/result shapes match their installed declarations. Aiden intentionally uses its owned harness rather than Pi's incomplete public AgentHarness. Existing registered harness/session/compatibility tests cover those adapters. A new focused run of `agent-compatibility.test.ts` and `pi-upgrade-evaluation.test.ts` passes 42/42.
- **Content-based estimates:** `generation-context.ts` estimates actual projected messages plus prompt/tool schemas, uses usage only for the exact provider/model, projects image capabilities, limits screenshots and handles irreducible current-turn payloads. PR #215 adds equivalent ownership to coordinator checks/fallback anchors and reopened checkpoints while preserving transient retries. The production no-usage preflight test proves content-only pressure is checked before inference.
- **Adaptive model budgets:** preflight/emergency `contextLimits` derives reserves from each selected context window; VCC clamps reserve and retained-tail budgets to that window. Before the follow-up, default LLM compaction always retained Pi reserve 16384 and keep-recent 20000. The separate correction bounds this pair only when it cannot fit the selected window. These are per-model adaptation, not persisted user overrides.
- **Safe interruption/restart:** existing durable operations/effects, checkpoint rollback and no-repeat boundaries remain authoritative. PR #215 serializes startup recovery. Corrupt/unsupported snapshots remain quarantined until explicit repair plus a fresh store; transient recovery-write failures can retry without replaying effects.

## Concrete remaining feature gap: persisted model overrides

There is no `provider/modelId -> { reserveTokens, keepRecentTokens }` persisted configuration. `AppSettings` has only `compactionEngine`; portable projection/config mutation and production entry points expose no model-override contract. This is a real unimplemented feature, not an external blocker or a Pi-version incompatibility.

A complete separate feature must:

1. Define a bounded, versioned host-owned settings document with exact provider/model identities; validate finite safe non-negative integers, malformed/future documents and prototype-like keys; preserve unknown future raw settings without applying them.
2. Define reserve semantics explicitly: Pi's summary-output reserve, next-request response/safety reserve, and retained-tail budget are related but not interchangeable. Absent overrides must preserve today's audited behavior. A too-large reserve/tail must clamp or fail closed consistently, never eliminate the outbound safety floor.
3. Resolve one immutable policy per admitted operation from authoritative model metadata and the settings snapshot. Feed foreground/Bot/Telegram generation, manual desktop/remote compaction, child/nested-child creation, harness preflight, emergency projection, and VCC compilation. Keep existing rollout eligibility/rollback checks authoritative.
4. Persist/reload settings across restart, exact-model switches and provider aliases; never trust a child/request to supply a broader budget. Decide whether configuration is a supported operator-file feature or a product Settings control and document it accordingly. A UI addition requires design/onboarding work under AGENTS.md; a shared remote DTO change requires both native clients.
5. Cover empty/no overrides, exact-match/fallback, numeric boundaries, tiny windows, invalid/future configuration, copy/snapshot isolation, changing settings during an active run, restart, model switch, manual/automatic parity, foreground/child parity, and unchanged rollback/ineligible behavior. Run native tests if shared contracts change, followed by independent reviews and latest-head CI.

Likely owned paths are config-store/portable-config/types, a pure budget policy module, `llm-client`, `generation-context`, `PiAgentRuntimeHarness`, `ContextLifecycleService`, and child policy propagation. Several intersect active peer PRs #219/#220 and #206; a coordinator-only seam would be unused/inconsistent and is explicitly excluded. This gap remains deferred under the previously accepted bounded #215 scope; do not label the configurable feature complete.

## Intentional exclusions and external gates

- **Newer Pi dependency:** npm currently reports 0.87.0 for both packages. No verified pin-compatibility defect requires a bump. Any upgrade must separately re-audit the paired packages, session format, provider adapters, migration/rollback and installed/signed receipts. The historical digest's 0.85.1 is not a target.
- **Automatic daemon continuation:** excluded because matching idle state is insufficient proof to replay an interrupted external action. Aiden's durable uncertainty and explicit continuation policy remain; no missing automatic replay feature is claimed as a bug.
- **#206:** re-read its current body and file list. Partial child notes and hard maxTurns/health-policy follow-up are distinct from compaction token budgets and are not duplicated here.
- **Operator acceptance:** signed/installed and credentialed rollout evidence remains Pending in the existing plan. This audit cannot manufacture or advance those receipts. Greptile's 50-credit trial quota remains an external review-service limitation; both Sol reviews and Pullfrog previously cleared #215.

Completion boundary: #215 completes the verified model-ownership/startup-recovery repair slice, not configurable per-model budgets or a dependency/rollout upgrade. The current compatibility audit found no pin/API mismatch. The independent budget review subsequently found fixed semantic budgets exceeding small custom windows; see `upgrade-pi-small-context-budgets.md` for the separate bounded correction.
