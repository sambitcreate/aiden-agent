# rpiv-advisor integration

Status: Implemented (2026-08-30)

## Objective

Bring the useful behavior of `rpiv-mono/packages/rpiv-advisor` into Aiden's existing Pi runtime without importing its CLI configuration, ambient credentials, or unbounded context behavior. Advisor is an optional, user-selected second-opinion model that an attended foreground chat may consult once per response.

## Upstream findings and Aiden decisions

The upstream extension contributes an `advisor` tool, lets the user choose a reviewer model and effort, and supports executor-specific disable rules. Aiden preserves those semantics in a versioned local selection, then narrows execution to its own authority and privacy boundaries:

- Advisor is off by default and contributes no prompt or tool while off.
- Only attended desktop chat, including attended Assistant, is eligible. Telegram, unattended/automation Assistant, Bot, child/subagent, scheduled, and other non-chat usage sources are excluded before settings are read.
- Each response receives at most one zero-parameter, sequential, replay-never consultation.
- The reviewer resolves through Aiden's current provider/model/auth path at dispatch time. The request receives the resolved API key and provider headers, disables cache retention and retries, has a 90-second bound, and exposes no tools.
- The reviewer sees a bounded projection of surviving conversation, completed executor-tool evidence, a sanitized tool inventory, and capability-aware supported images. Aiden strips hidden thinking, signatures, diagnostics, response IDs, private details, orphan tool protocol, and the in-flight Advisor call. It never attaches Aiden's provider credentials and redacts high-confidence credential-shaped text, but transferred user, tool, and image content can still contain sensitive data.
- Every dispatch is journaled before network effect. Startup marks prepared calls cancelled and dispatched calls unknown; neither is replayed.
- Reviewer usage is recorded separately as source `advisor`, including bounded failed/cancelled accounting when no terminal provider message exists.

## Delivered architecture

### Configuration and admission

- `renderer/shared/advisor.ts` owns the strict versioned schema, disclosure version, parser, and executor block rules.
- `main/services/advisor-settings-store.ts` persists only the selection in a private `0600` bounded store and fails closed on corrupt or future-schema data.
- `main/handlers/advisor.ts` exposes strict `advisor:get` and `advisor:set` IPC. Both require the active main-frame document; mutation revalidates that ownership after provider/auth resolution and immediately before persistence. Renderer-facing mutation failures are closed.
- Main admission rejects non-chat models using the same shared eligibility policy as the renderer. Provider/model/effort/auth must resolve before a selection is published.

### Runtime and privacy

- `main/services/advisor-runtime.ts` owns eligibility, executor block rules, the one-call tool, bounded dispatch, and normal tool-result failures.
- `main/services/advisor-runtime-main.ts` contains production-only provider, usage, store, and logger wiring so the policy/runtime remains Electron-free under test.
- `main/services/advisor-context.ts` snapshots the live harness state at tool invocation, repairs protocol pairs, sanitizes private fields, builds a stable tool inventory, and compacts to the reviewer's context window.
- `main/services/advisor-attempt-store.ts` owns the content-free no-replay attempt journal.
- `main/services/llm-client.ts` asks for the per-generation extension before freezing static runtime contributions. The closure reads the live candidate state only if the reviewer tool is actually invoked.

### Settings UX

- Model settings now renders `AdvisorSettings` above the existing Model Pad.
- The control uses Aiden's Field, Select, Switch, Callout, Badge, and Button primitives and semantic tokens. It supports explicit off/on, provider, chat-model, and metadata-backed reasoning selection, plus explicit save/validation.
- The disclosure names the surviving user/tool/inventory/image transfer, hidden-reasoning omission, absence of attached provider credentials, best-effort high-confidence text redaction, residual sensitive-content risk, tool-free reviewer, one-call bound, and separate provider request.
- Saves preserve persisted executor disable rules. The current UI does not edit those advanced rules.
- Per explicit product direction, this capability is not added to onboarding or its feature-tour gallery.

## Acceptance status

- `npm run test:advisor`: green (30 tests).
- `npm run test:model-pad`: green (58 tests).
- `npm run type-check`: green after integration.
- Advisor is registered in `pretest`, so the focused suite runs in normal CI.
- Coverage includes strict schema parsing and rule preservation, eager no-replay recovery, privacy projection and credential redaction, tool-pair repair, live-state capture, custom/Pi-native/Codex auth dispatch, no retry/cache, running/terminal status, usage journaling, stale renderer ownership at the serialized write boundary, exact foreground-owner admission and explicit exclusion, non-chat rejection, optional-settings fail-closed behavior, generation-hook ordering, unavailable-selection rendering, provider filtering, effort eligibility, UI disclosure, and IPC registration/ownership.
- iOS and Android require no contract change: Advisor adds no new mobile transcript/activity payload, mobile setting, or remotely invocable capability.

## Honest limitations

- The schema and runtime honor executor-specific disable rules, but the first Aiden-native UI intentionally preserves rather than edits them.
- Usage recording and the attempt journal are separate durable writes. A crash after aggregate usage succeeds but before `usageRecorded` is marked can leave an unacknowledged attempt. Startup does not replay either the provider request or usage write, preferring no duplicate billing over speculative reconciliation.
- This delivery has automated UI contract coverage, not a packaged manual provider smoke across every auth implementation.
