# rpiv-advisor integration

Status: Implemented (2026-08-30)

## Objective

Bring the useful behavior of `rpiv-mono/packages/rpiv-advisor` into Aiden's existing Pi runtime without importing its CLI configuration, ambient credentials, or unbounded context behavior. Advisor is an optional, user-selected second-opinion model that an attended foreground chat may consult once per response.

## Upstream findings and Aiden decisions

The upstream extension contributes an `advisor` tool and lets the user choose a reviewer model and effort. Aiden keeps that per-consultation choice at the point of use instead of adding durable Advisor settings, then narrows execution to its own authority and privacy boundaries:

- Advisor is available only when Aiden has at least one authenticated chat-model candidate. No Advisor selection is persisted or reused across requests.
- Ordinary attended desktop chat and attended Assistant are eligible. Telegram, unattended/automation Assistant, Bot, child/subagent, scheduled, and other non-chat usage sources are excluded before the provider catalog is read.
- Each response receives at most one sequential, replay-never consultation. If the latest user request explicitly names a configured provider and model, the executor states the transfer notice visibly and passes both exact IDs. Otherwise an ordinary chat pauses in Aiden's Ask User Question composer so the user chooses a bounded provider/model option or types an unambiguous exact `provider/model` shorthand. A JSON `["provider", "model"]` tuple handles the rare case where either ID contains `/`. Attended Assistant retains exact-selection support but does not silently choose when its surface cannot show this chooser.
- The reviewer resolves through Aiden's current provider/model/auth path at dispatch time. The request receives the resolved API key and provider headers, disables cache retention and retries, has a 90-second bound, and exposes no tools.
- The reviewer sees a bounded projection of surviving conversation, completed executor-tool evidence, a sanitized tool inventory, and capability-aware supported images. Aiden strips hidden thinking, signatures, diagnostics, response IDs, private details, orphan tool protocol, and the in-flight Advisor call. It never attaches Aiden's provider credentials and redacts high-confidence credential-shaped text, but transferred user, tool, and image content can still contain sensitive data.
- Every dispatch is journaled before network effect. Startup marks prepared calls cancelled and dispatched calls unknown; neither is replayed.
- Reviewer usage is recorded separately as source `advisor`, including bounded failed/cancelled accounting when no terminal provider message exists.

## Delivered architecture

### Configuration and admission

- `renderer/shared/advisor.ts` owns the strict ephemeral provider/model/effort parser. It has no configuration or persistence contract.
- `main/services/advisor-runtime-main.ts` derives a bounded candidate catalog from Aiden's authoritative configured-provider list, rejects unauthenticated providers and non-chat models, prioritizes provider defaults, and never exposes credentials.
- `main/services/advisor-runtime.ts` strictly validates candidate IDs (including format/bidi-control rejection), sanitizes and bounds display labels, uses tuple-safe identity keys, and gives the executor a JSON-labeled bounded exact-ID catalog. It shortlists at most four distinct choices, generates collision-proof labels, validates the finished question against the shared contract, prefers a different model from the executor, and adds a no-review choice when only one reviewer exists.
- `main/services/llm-client.ts` binds the internal Advisor choice to the same document-owned questionnaire coordinator as `ask_user_question`. Cancellation, renderer detachment, generation Stop, and chat lifecycle therefore settle the pending choice without dispatching the reviewer.
- The former Model Pad Advisor component, settings store, IPC handlers, preload prefix, and renderer API were removed. Existing device-local settings files are ignored rather than read, migrated, or sent.

### Runtime and privacy

- `main/services/advisor-runtime.ts` owns eligibility, the per-call chooser, the one-call tool, bounded dispatch, and normal tool-result failures.
- `main/services/advisor-runtime-main.ts` contains production-only provider, usage, attempt-journal, and logger wiring so the policy/runtime remains Electron-free under test.
- `main/services/advisor-context.ts` snapshots the live harness state at tool invocation, repairs protocol pairs, sanitizes private fields, builds a stable tool inventory, and compacts to the reviewer's context window.
- `main/services/advisor-attempt-store.ts` owns the content-free no-replay attempt journal.
- `main/services/llm-client.ts` asks for the per-generation extension before freezing static runtime contributions. The closure reads the live candidate state only if the reviewer tool is actually invoked.

### Consultation UX

- Advisor has no Model Pad or settings UI. Selection appears only if an eligible consultation is actually requested and the user's latest prompt did not already identify both provider and model.
- The existing Ask User Question surface fully replaces the composer while selection is pending. Each option displays a bounded human label and exact provider/model identity. The question discloses the separate tool-free provider request, bounded conversation/tool/inventory/supported-image transfer, absent provider credentials, best-effort credential redaction, and residual sensitive-content risk. Explicit selections carry the same notice in the visible pre-call instruction and tool result.
- Skip, custom answer, close, Stop, and document lifecycle are fail-closed: no reviewer provider request or attempt-journal mutation occurs until a valid choice has been resolved and authenticated.
- Per explicit product direction, this capability is not added to onboarding or its feature-tour gallery.

## Acceptance status

- `npm run test:advisor`: green (28 tests).
- `npm run test:model-pad`: green (58 tests).
- `npm run type-check`: green after integration.
- Advisor is registered in `pretest`, so the focused suite runs in normal CI.
- Coverage includes strict ephemeral selection parsing, eager no-replay recovery, privacy projection and credential redaction, tool-pair repair, live-state capture, explicit and questionnaire-driven selection, partial-identity rejection, collision-proof contract-valid options, adversarial candidate bounds, complete transfer notices, skip/cancel no-dispatch behavior, candidate authentication/filtering/default order, custom/Pi-native/Codex auth dispatch, no retry/cache, running/terminal status, usage journaling, exact foreground-owner admission and explicit exclusion, non-chat rejection, generation-hook ordering, document-owned questionnaire wiring, and removal of settings IPC.
- iOS and Android require no contract change: Advisor adds no new mobile transcript/activity payload, mobile setting, or remotely invocable capability.

## Honest limitations

- Candidate options are intentionally bounded to four for the shared Ask User Question contract. The custom answer accepts an unambiguous exact `provider/model` shorthand or JSON ID tuple when the desired configured model is not shortlisted.
- Usage recording and the attempt journal are separate durable writes. A crash after aggregate usage succeeds but before `usageRecorded` is marked can leave an unacknowledged attempt. Startup does not replay either the provider request or usage write, preferring no duplicate billing over speculative reconciliation.
- This delivery has automated UI contract coverage, not a packaged manual provider smoke across every auth implementation.
