# Bot continuity: watches, Open work, routine models and messaging

Status: In progress, 2026-11-04; the seven original owner decisions and Composio amendments D8/D9 are confirmed. The watch hand-off and iMCP Mail implementation, Open work, routine-specific models and named-pair Bot messaging are implemented across desktop, iOS and Android. Their requested GPT-6.1 Sol high review/fix loops are clear, including crash recovery, exact-request retries, model/source isolation, delegated spending, retained financial obligations, Bot replacement and delayed notification recovery. Phase P's final independent core review passed 50/50 focused cases and all three prior failure reproductions; public and native reviews are also clear.

Composio is one tool with one service allowance, with conservative legacy-grant migration. Its reviewed foreground check runs through the existing saved connection without changing access settings. The owner-authorized live metadata check now completes and declares a per-operation account selector and one ACTIVE Calendar account. Bounded compatibility fixes are clear after Sol high review. The pure exact-account Calendar reader is implemented and independently reviewed, and private host integration plus a separate explicit Calendar read check are in progress. Exact account routing and real Calendar response acceptance remain pending, so Calendar watches stay unavailable. The signed diagnostic snapshots remain separate from the later private feature formats.

Integrated local checks pass: 315 runtime, 300 proactive, 51 Open work, 120 routine-model, 281 Telegram, 33 spending and 31 usage-limit cases; all four desktop feature journeys pass in a Cua Space. Android passes 1,261 JVM tests, instrumentation compilation and lint. iOS's reviewed adjacent run passed 395 with four skips; the additional description-conflict peer run passed 42 with one existing Simulator skip. The first three iOS journal nil-pending observations remain unexplained and documented. Packaged, physical-device and authenticated connector acceptance remain final release gates. This plan stays active until those remaining gates and Calendar work are resolved.

## Outcome

A person sets up an email or calendar watch, sees what their Bot is responsible for, chooses an appropriate model for a routine, and lets approved specialist Bots exchange work. The owning desktop runs and stores everything. Results, unfinished work and requests for help remain understandable after sleep, restart, permission changes and disconnected phones.

Deliver the features in this order: connector watches, Open work, routine models, then Bot messaging. Each feature includes desktop, iOS and Android management before it is advertised as complete. Small foundations for reliable watch delivery, late-run context and local timing diagnostics accompany the relevant feature.

This is an Aiden implementation informed by Rakazo's behavior and tests. It does not import Rakazo's server, database, agent runtime or UI.

## Owner decisions

| ID | Decision | State |
| --- | --- | --- |
| D1 | Include connector watches, Open work, per-routine model/thinking, then Bot-to-Bot messaging. | Confirmed 2026-11-03 |
| D2 | The person approves named Bot pairs; every recipient retains its own rules and access. | Confirmed 2026-11-03 |
| D3 | An unavailable explicitly selected routine model stops with Needs you. A fallback may run only when the person configured it. | Confirmed 2026-11-03 |
| D4 | Prove email and calendar workflows first, through verified connector tools. | Confirmed 2026-11-03 |
| D5 | Full setup and management on desktop, iOS and Android. Existing host-owned connector sign-in hand-offs remain. | Confirmed 2026-11-03 |
| D6 | Track explicit accepted tasks automatically; the person can edit, dismiss or undo. No per-item approval card is required. | Confirmed 2026-11-03 |
| D7 | Poll accepted connector watches while Aiden runs and the computer is awake, including after leaving the Bots screen. This explicitly replaces the October D2 desktop-Bots-open restriction. | Confirmed 2026-11-03 |
| D8 | Permit a restricted Composio adapter that constructs one verified read operation at a time and binds an exact account. Arbitrary batch/proxy/shell dispatch remains excluded. | Confirmed 2026-11-03 after live tool-inventory inspection |
| D9 | Present Composio as one agent-facing tool with one connection-level allowance; the person manages its enabled apps/tools in Composio. Retain Aiden's action rules and each watch's exact account/read-operation binding. | Confirmed 2026-11-03 follow-up |

The owner's 2026-11-03 D7 answer amends the lifecycle part of [Bot autonomy D2](../superpowers/specs/2026-10-27-bot-autonomy-design.md): the Bots screen no longer has to stay open. Its other requirements remain binding: visible, person-created connector watches, no model call per poll, no more often than every 15 minutes, an awake owning desktop, and a spike proving deterministic read tools. The same running-and-awake lifecycle applies on Linux without starting a second scheduler or adding a keep-awake service. A Mac-app connector remains macOS-only. The older dated decision is preserved with a dated amendment in its source spec and plan.

## Scope and boundaries

- One owning desktop/profile per Bot, on supported macOS and Linux hosts. Native phones control that host; they do not poll connectors, run models, hold provider credentials or deliver peer work themselves.
- Full/Custom access, Ask first, locked rules, spending limits, pause, Stop, quiet hours and the existing delivery funnel remain authoritative. Pair approval does not approve a particular consequential action.
- No cross-host Bot messaging in v1. A pair contains active Bots owned by the same local profile. There is no shared Bot memory, shared computer identity, group conversation or Bot fleet administration.
- No new public webhook relay, approval-model mode, background catalog calls, automatic connector installation/sign-in or inference during migration. No new analytics event is needed; timings are bounded local diagnostics.
- D9's Composio allowance covers its service, including changes the person makes to enabled tools there. Keep its meta-tools internal. Do not turn a previously partial Custom grant into a broader service grant without the person's one Composio allowance. Credential/endpoint changes still invalidate the binding, and unsupported watch schemas/accounts remain unavailable.
- API vault, teaching, import/export/duplicate, new channels and voice calls are follow-on work. They are not release dependencies for these four features.
- The serve-only CLI retains its existing supported surfaces. Keep shared services portable and test bundle compatibility. Do not announce the new features from a CLI host until their host wiring and existing permission guarantees are implemented there; CLI feature parity is a separate follow-on.

## Current implementation and integration points

Baseline reviewed: Aiden `286969201f5a51af0609c041e499a7a084d78d54`; local Rakazo `70b1fef42fb517f36bccede5b222e1df0df5cf33`. Recheck the touched surfaces against main before implementation.

| Surface | Current home | Planned use |
| --- | --- | --- |
| Watch triggers and strict parsing | `renderer/shared/bot-routine-trigger.ts` | Add a typed connector watch beside URL/script; keep their existing intervals and behavior separate. |
| Watch storage/checking/dispatch | `main/services/bot-routine-events/{store,watch,watch-sources,dispatcher,runner,sources-main}.ts` | Reuse scheduler, bounded state, failure pause, event receipts and delivery. |
| Bot authority and connector joins | `main/services/bot-runtime-authority.ts`, `bot-capability-bindings.ts`, `bot-runtime/bot-tool-policy.ts` | Admit exact current connector/model authority; propagate revocation to in-flight work. |
| Durable session and tool assembly | `main/services/bot-runtime/{bot-session-service,bot-extension,bot-tool-candidates,bot-models}.ts` | Add host-owned ingress provenance and submission-scoped execution choices. |
| Routines and recovery | `main/services/{scheduled-bot-routines,bot-routine-proposals,schedule-store-core,bot-routine-recovery}.ts` | Persist choices on claimed fires; preserve stable request IDs and safe retries. |
| Existing records with different purposes | `main/services/bot-commitments/`, `bot-routine-notes.ts`, `bot-memory/`, `bot-issues/` | Keep dated promises, run notes, durable facts and problems distinct from Open work. |
| Bot UI | `renderer/main/bots/`, `renderer/components/bots/` | Extend Profile, routines, proposals and transcript rows using existing shared components. |
| Remote/native contracts | `protocol/aiden-remote/v1/`, `main/services/aiden-remote-bot*`, native Bot models/controllers | Negotiate every new shape and implement complete feature management on both phones. |

`BOT_WAKE_SOURCES` is prompt guidance, not authorization. Current ingress distinguishes routines through `routine:` request IDs. A peer request must never acquire attended tools merely because it has a new request-ID prefix. Also inspect memory review/compaction, follow-up discovery, learning and transcript projection: peer content must remain identifiable after compaction and restart.

Do not activate the separate, partially integrated durable-jobs ledger merely to add these features. Pi Durable remains the execution owner. Add only bounded feature records and explicit hand-off receipts needed around it; never copy its transcript or effect journal.

## Phase W0 — prove connector workflows and close delivery gaps

Deliverable: an executable, offline connector-watch spike plus a short evidence record listing exact supported connection/tool/schema combinations, comparison semantics and limitations. Live account acceptance follows only through an explicitly configured connector.

1. Inspect actual tools from Aiden's existing connectors. The catalog currently offers email/calendar through Composio and Mac services through iMCP; catalog aliases alone do not prove usable tools. Verify one mail workflow and one calendar workflow, including account selection, result shape, pagination, errors and metadata stability. Keep vendor translation in narrow adapters.
2. Establish an eligible-tool policy: exact granted connection/account/tool, understood input and output schemas, affirmative read metadata from a trusted integration, and explicit unattended watch approval. Exclude generic batch, shell, arbitrary HTTP and dynamically selected tool dispatchers. D8 permits only a host-owned Composio translation that fixes one verified read operation per call and binds its exact account; it does not expose the generic dispatcher to watch configuration or the model. An untrusted server's read-only annotation alone is insufficient.
3. Define host-owned templates for the first mail/calendar watches. A template exposes typed person-editable fields and opaque connection options to every client; the host constructs the invocation. Do not send raw tool arguments, secrets, internal fingerprints or arbitrary executable configuration to a phone.
4. Support relative time through a small host-defined template vocabulary. For example, calendar look-ahead uses the host's current time and the selected timezone. A static query containing yesterday's literal timestamps is not a calendar watch.
5. Close the existing watch hand-off gap before relying on it for mail: the current checker saves the new hash before calling the dispatcher. Persist an immutable pending transition and its new baseline in the same store mutation. Reconcile that transition after a crash until the dispatcher durably owns it or records an intentional suppression. Acknowledgement must not erase a newer transition. Preserve existing bounded coalescing and daily-limit behavior; do not promise an event archive.

Acceptance: a process death after saving a changed baseline but before dispatch still leads to one logical admitted event after restart; death after dispatch ownership but before acknowledgement does not admit a duplicate. Source edits, pause, deletion and revoked authority fence stale callbacks. No model, VM, sign-in or connector request is started by migration or ordinary settings reads.

## Phase W1 — email and calendar watches on all three clients

### Behavior

- A person chooses a Bot, connected account, supported watch template, filter, interval (15/30/60 minutes), timezone where relevant, and the instruction to run when the condition changes. A chat proposal uses the same complete approval summary.
- The approval shows the account, data read, frequency, filter and resulting Bot action. Creating the watch authorizes its bounded reads, subject to current Bot grants. It never grants missing connector access implicitly.
- The initial successful mail check establishes a baseline. Subsequent comparisons use stable item IDs and selected meaningful fields; ignore fetch times and ordering. Store only the bounded data required for comparison and a useful diff. Define deterministic behavior for deletions, edits and bounded pagination; incomplete responses are failures, not mass deletions.
- Calendar watches detect entry into the selected upcoming-event window, including an unchanged event becoming due as time passes. At creation, eligible events in the current window can produce one event; persist event/occurrence identity so overlapping windows, restarts and timezone changes do not repeat it. Cancellation and rescheduling are independently covered.
- Admit and revalidate the exact Bot connection before every poll; connection/account/schema drift stops with a fitting issue. Cancel an in-flight read on revocation, pause, deletion or loss of eligible lifecycle state. Do not reconnect or open sign-in in the background to repair a watch.
- Unchanged results make no model request and produce no notification. Distinguish empty, unchanged, failed, paused and intentionally coalesced/suppressed checks. Reuse the existing three-failure pause and issue recovery, with an account/sign-in problem surfaced promptly.
- Poll while Aiden's owning process is running and the computer is awake. Navigating away from Bots, closing a window while Aiden remains running, or disconnecting a phone does not stop an accepted watch. Quitting Aiden, host sleep, a paused Bot/watch or revoked access stops checks. Startup and wake re-arm due work with bounded catch-up and no accumulated poll burst; never keep the host awake or run a separate daemon for this feature. A phone may configure and pause the watch without keeping any client screen open.

### UI and native management

Extend the Bot's existing event-routine area rather than adding a dashboard. Each watch row shows its source, interval, last check and state. Provide create/edit, pause/resume, test check, delete and issue navigation on desktop, iOS and Android. Test check previews the read/diff without implicitly running the Bot; an explicit Run now remains separate.

Host-produced template descriptors let both phones build the same bounded controls without copying provider orchestration. Missing connection setup uses the existing Finish on your computer flow. An unsupported connector explains why it cannot be watched; it never falls back to a script.

Acceptance: two stable polls cause zero model calls; a relevant new mail item causes one admitted event; incidental reordering/fetch metadata causes none; calendar window entry, recurrence, cancellation, DST and rescheduling match independent clock fixtures. Verify read-only refusal, bounds, timeout, pagination failure, current access and recovery. Navigate away from Bots and disconnect the phone: checks continue. Pause, sleep or quit stops them; restart/wake performs bounded reconciliation without a burst. Native users can perform every supported management operation and recover from stale saves or disconnected responses.

## Phase O — visible Open work

Under confirmed D6, Bots track explicit accepted tasks automatically. The person can edit, dismiss or undo entries without approving every item first.

### Record and lifecycle

- Introduce a bounded per-Bot Open-work service with private persistence, revisioned mutations and deletion fencing. A record carries an ID, Bot ownership, title, short note, state, source submission, timestamps, and links to an issue, routine fire, delegated request or result when relevant. Links use host-owned identities, never fabricated paths or model-written receipts.
- Product states: Open, Waiting, Done and Dismissed. Running is derived from a live execution link rather than a saved claim that can survive a crash incorrectly. Completion records its supporting result or explicitly says it was marked done by the person/Bot.
- D6 behavior: a tool records responsibilities traceable to an explicit person request or an accepted routine, without a per-item approval card. No extra background extraction/model scan creates work. A future idea or peer FYI does not automatically become a new owner-authorized task. A delegated task inherits its original root and permission provenance.
- The person can add, edit, mark done, reopen and dismiss, with durable Undo for reversible changes. Stale revisions refuse a write and return current state; retries reuse the original mutation identity. Cap active items and retained history, with a clear refusal instead of silently dropping unfinished work. Start with proposed bounds of 64 active items and 128 retained terminal items per Bot.
- Open work never schedules itself. Stop interrupts the linked execution and leaves honest unfinished state; dismissing an item does not silently cancel a running effect. The UI offers an explicit stop-and-dismiss action when both are intended. Existing dated follow-ups can link to an item without creating another scheduler or another promise.
- Feed a bounded escaped summary into the Bot's context, and keep full records available through its tools. Content is task data and cannot grant authority. Peer/routine content remains excluded from person-only memory and learning paths.

### UI

Add Profile → Open work using the same page shell and grouped rows as Memory/Learning, plus a compact count/link in the existing Bot panel where it is useful. Keep detailed work out of the global sidebar. Each item opens its source/result and shows a specific waiting reason when known. Desktop and both native clients provide the same mutations and Undo; Inbox continues to project actual needs-attention state rather than receiving a duplicate task list.

Acceptance: unfinished work and evidence survive restart; repeated tool execution does not duplicate an item; forged/cross-Bot links are refused; concurrent phone/desktop edits do not overwrite each other; undo does not overwrite a later edit; a deleted Bot cannot be resurrected; Stop and lost delivery do not mark a task complete. UI tests assert accessible controls and user-visible state changes.

## Phase M — model and thinking per routine

- Default is Inherit Bot model. The person can choose an exact provider/model and supported thinking level for a particular routine, including event/watch routines. Bots may propose the selection; only the person's accepted save/card establishes it.
- Selecting a model cannot broaden a Custom Bot's authority through a string field. The host offers only models admissible under its existing ceiling. If Custom currently admits only its primary model, an additional routine choice requires an explicit, narrowly scoped model grant shown in that same owner review; it changes neither the Bot's default model nor unrelated grants. Resolve this binding extension in the model phase's design review before implementation.
- Persist the resolved choice and thinking level on the claimed fire/submission, not solely on a mutable routine or conversation setting. Carry it through queueing, retries, recovery, usage attribution, context limits and image/tool capability checks. A model edit affects future fires; it does not retarget admitted work.
- Scope the provider runtime and choice to the executing submission. Do not temporarily configure a shared conversation at admission and restore it later: another queued send can interleave. The next person turn inherits the Bot's current default. If Pi Durable cannot express this safely through its public APIs, first prove a supported execution-time binding; do not emulate it by racing shared configuration writes.
- Under D3, the default response to an unavailable explicit choice is Needs you. No default-model substitution. Support an optional owner-selected fallback only as a separately visible exact choice under the same grants, with its use recorded. Fallback never bypasses revoked authority, spending limits or the existing usage-limit waiting policy.
- Show chosen and actual model/thinking in the run detail on desktop and phones. All three clients can set, clear and edit routine choices. Reuse model controls and label behavior rather than adding a second provider catalog.

The Sol high design review accepted a pin-specific public `RegistryReader` composition with conditions. Stamp new generations from final staged `LiveDoc.run.inputs` after the delegated transaction callback returns; do not rely on the non-public `TaskOptions.submissionIds` extra field. Bind tool/compaction children and abort handlers, including production summary helpers, to their source. Introduce exact private routine grants separately from the default-model ceiling, durable record-once provider spending, and durable watch connector restrictions. Fallback is limited to eligible typed failures before any provider/tool/deferred effects; prepared work keeps its persisted actual selection.

Include late-run context here: record the scheduled occurrence, actual start and timezone for claimed scheduled work; supply those facts to the Bot and show the delay when material. Preserve the original values on resume. Use latest relevant missed occurrence for recurring catch-up, with deterministic DST/sleep tests.

Acceptance: interleaved different-model routines and person turns retain their own choices before and after restart; edits do not mutate claimed fires; invalid thinking/model/image combinations fail clearly; missing credentials raise one fitting issue; default failure, configured fallback and budget refusal are distinct. Current Bot defaults, provider credentials and other Bots remain isolated.

## Phase P — approved Bot pairs and reliable delegation

### Pair authority and provenance

- A person approves a named pair on the owning host. The UI names both Bots and explains that each will act under its own rules; approval enables requests in both directions. A host-controlled reply to an accepted request needs no second pair approval. Pair creation, inspection and revocation work on desktop, iOS and Android with current ownership/access checks for both Bots.
- Reject self-pairs, deleted/archived Bots, cross-profile and cross-host targets. Never expose an unrestricted directory of other owners' Bots. The model can discover only currently approved peers and their owner-authored routing descriptions.
- Introduce explicit host-owned ingress provenance instead of treating a new prefix as a person turn. Preserve original source, sender, root request, parent request and pair generation through every queue/recovery hop and compaction. Remote clients and tools cannot mint or upgrade these facts.
- Peer turns receive the existing unattended restrictions: no self wake-up, routine creation, person-only memory writes, subagent spawning, sign-in/hand-off or skill-proposal privileges. Existing rules and every nested codemode call still run. If a person steers a mixed-source run, use the most restrictive source rules until work is separated; do not erase external/peer provenance.
- A watch/routine can request approved peer help under its already accepted task. Pair approval authorizes communication, not an email, payment, credential request or other protected action. The recipient independently admits its own current grants and rules; peer text never counts as fresh owner approval.

### Delivery, result and cancellation contract

- `message_bot` sends a bounded request or a correlated interim question/status/FYI. A host-owned request ID is stable across tool replay. Persist source intent, recipient delivery and a recoverable hand-off before reporting success; recipient `send` deduplication supplies the execution receipt. There is no claim that an external side effect is universally exactly once.
- Persist the final outcome obligation when the request is accepted. Completion, failure or cancellation returns one terminal result to the requester. A host-controlled final return retains a reserved path after the request depth limit, but cannot start another unbounded request chain. A model labeling arbitrary text as a result cannot obtain that exception.
- Start with proposed bounds: three request hops, eight requests per root, eight unfinished inbound requests per Bot, and 24-hour pending-request expiry. Exclude the one reserved terminal return from request depth/count; retain its dedupe receipt. Bound message bytes and aggregate context. Validate the limits against the acceptance workflow before enabling them.
- Recheck pair generation and both Bots' current state before admission. Revocation cancels undelivered requests and forbids new actions under stale permission; retain already admitted outcome evidence and display any uncertainty. Paused or interrupted recipients retain bounded waiting work without automatic Resume. Expiry returns a visible failure.
- Stop on the initiating task prevents further requests and signals its active linked work; it does not undo effects or report cancellation before the recipient acknowledges. Stopping or dismissing an unrelated task does not cancel the Bot's whole queue. Record partially completed or uncertain work honestly.
- Attribute each provider request once. Enforce the recipient Bot's limits and the originating task/routine budget across delegated requests so delegation cannot evade a cap. Prove the overlapping budget scopes and resumable accounting before enabling routine-originated delegation. Only the person can allow more.
- Link both sides to Open work. The initiating conversation owns the final person-facing result; intermediate messages do not create a notification storm. Use existing quiet hours, caps, issue/delivery stores and Inbox projection.

### UI

Use quiet Messaged / Message from transcript rows with accessible names and a view of the exchange. Provide source, status, result and Stop for the linked request on desktop and both phones. Configure pairs in the Bot's existing access/advanced area with shared grouped rows and current Bot identities. Changing a name does not rebind a pair. No group-chat screen is introduced.

Acceptance: A asks B, B returns a substantive result, and A presents one final update. Crash at every persistence/admission/return boundary yields one logical request and terminal result. Verify refusal at depth/fan-out bounds while final return still succeeds; current policy on both sides; pair revocation and deletion; pending expiry; Stop acknowledgement; routine-origin restrictions; spending limits; and zero secrets or unrelated history in routing metadata.

## Remote, clients and portability

Each feature defines a negotiated host capability for its new DTOs/routes/entries and announces it only when all required endpoints are wired. Choose capability names and the next Remote revision against main when each contract lands; do not reserve revision numbers now. Audit the protocol's feature-token limit before adding tokens; prefer the established negotiable Bot capability mechanism where appropriate.

Use bounded host-produced configuration DTOs with opaque option IDs, expected revisions and stable idempotency keys. All mutation responses identify the resource and accepted revision. Unknown network outcomes stay pending/uncertain until an authoritative read settles them; they are never resent under a new identity. Apply current paired-device grants and native privacy filters. Old clients receive only their existing negotiated shapes, including on event streams, and no unknown routine fields.

Full feature management means both native clients can create/edit/pause/test/delete watches, manage Open work with Undo, choose routine models/thinking/fallback, and approve/revoke pairs and inspect/stop linked work. Provider sign-in and host permissions continue through existing host-owned flows. Validate native offline, reconnect, stale-response, live-update and accessibility behavior in each feature slice.

Keep new services free of Electron imports. Shared-core behavior changes must pass the CLI durable-host and bundle parity suites even while the new optional feature ports remain unwired there. No TUI, print mode or RPC mode is added.

## Delivery order and PR boundaries

| Milestone | Reviewable changes | Release gate |
| --- | --- | --- |
| W0 | Verified connector templates and deterministic fixtures; separately, persistent watch-transition hand-off. | Real supported mail/calendar schemas and crash tests. |
| W1 | Connector-watch service/authority/contract, then desktop + iOS + Android management in a coherent feature stack. | All three clients manage watches; lifecycle and account acceptance pass. |
| O | Open-work store/tools/contract, then all-client management and durable Undo. | Automatic explicit-task tracking, provenance and concurrency/restart tests. |
| M | Submission-scoped runtime binding, routine configuration/contract and all-client controls. | Pi API proof, queue/restart isolation and budget correctness. |
| P | Typed ingress + pair authority; then delivery/results/budget integration; then all-client management/projection. | Existing unattended restrictions and cancellation/recovery invariants hold end to end. |
| Acceptance | Integrated journey, docs/onboarding, packaged and physical-device evidence. | No advertised slice relies on missing client controls or a fake runtime. |

Split PRs along real ownership boundaries without mixing unrelated feature changes. Backend pieces remain unadvertised until their client stack is complete; migrations and startup reads do no work. Run narrow local suites before hosted CI/review. Merge main into shared PR branches, recheck script-chain unions and Remote revisions, and require CI green on each exact head.

## Verification and release evidence

- Extend behavioral suites first: `test:bot-proactive`, `test:mcp`, `test:scheduled`, `test:bot-runtime`, `test:bot-health`, `test:bot-rules`, `test:usage-limits`, `test:spending`, relevant renderer suites and `test:aiden-remote`. Register every new test file in the appropriate root script and CI routing. Preserve all existing scripts.
- Use independent clock/provider fixtures, real temporary stores, register-and-invoke handlers, rendered controls and real Pi Durable submission/restart tests. Do not grow source-grep contracts or use mock-call equality as the only oracle.
- Add SIGKILL/reopen coverage at watch-transition, work-item, claimed-model and peer-delivery/result boundaries. Assert observed behavior and receipts rather than private helper names.
- Run focused Swift and Kotlin model/controller/network tests with each shared contract change; run applicable broader native suites before finishing its stack. New strict DTOs, stale revisions, uncertain writes and old-host capability fallbacks are required cases.
- Follow the Electron E2E skill. On macOS, window-opening Linux-compatible tests run through `npm run test:e2e:space -- ...`; run changed macOS branches on the host when required. Physical iOS/Android pairing, sleep/reconnect and packaged host behavior are separately recorded; a compile is not device acceptance. Automated launches set `AIDEN_ANALYTICS=0`.
- Record local durations for accepted-to-start, first visible result, completion and overdue work using stable host timestamps/monotonic elapsed time where appropriate. Keep identifiers and content out of analytics; do not introduce a remote telemetry dependency.
- Final journey: configure mail/calendar from a phone; meaningful change produces an Open-work item; its routine uses the selected model; an approved peer supplies a result; the initiating Bot delivers one final update. Repeat across restart, sleeping host, pair/connector revocation, spending limit and phone disconnect, with no duplicate action or false completion.

## UI, onboarding and documentation

Use [GUI.md](../../GUI.md), the graphical-ui skill, [design guide](../design-guide.md), [settings design system](../settings-design-system.md), [desktop inspiration](../chatgpt-desktop-ui-inspiration.md) and [element specimen](../chatgpt-ui-element-specimen.html). Reuse shared squircle actions, grouped surfaces, inset separators, semantic fills and existing motion. Preserve neutral focus-visible treatment on non-text controls and background/caret focus on text controls. No decorative selection/status borders, new token scales or brain artwork.

Before shipping each slice, update `README.md`, `PRODUCT.md`, `docs/bot-routines.md`, relevant Bot access/rules/spending guides, `docs/linux.md` where platform support changes, `docs/aiden-remote-api-v1.md`, OpenAPI/fixtures, `ios/` guides and the relevant Android guides/metadata. Review `packages/cli/README.md` and `docs/cli-durable-bots.md` for honest supported-surface claims. Keep catalog/network restrictions intact. Update this plan and its inventory row together; archive the completed plan only after required acceptance is recorded.

Update concise onboarding where watches, ongoing responsibilities or pair permissions affect first setup. Review the feature-tour gallery for shipped value: each advertised new capability needs its own code-drawn, token-based illustration and art test, with reduced-motion behavior. Never advertise a planned or unwired capability.

Release claims must follow implemented and accepted behavior. Calendar remains gated while its installed account-routing contract is unverified; later phases must not be advertised before their runtime and all-client controls are wired. Keep the existing wake-source follow-up and project memory current.

## Research and related work

- [Rakazo → Aiden Bots research](https://app.notion.com/p/40d80314a1c481f98205e5552d8bc87b).
- Rakazo references at the reviewed commit: [Bot messages](https://github.com/elie222/rakazo/blob/70b1fef42fb517f36bccede5b222e1df0df5cf33/packages/adapters/src/bot-messages.ts), [tracked watch fields](https://github.com/elie222/rakazo/blob/70b1fef42fb517f36bccede5b222e1df0df5cf33/packages/adapters/src/routine-watch.ts), [Open work](https://github.com/elie222/rakazo/blob/70b1fef42fb517f36bccede5b222e1df0df5cf33/packages/adapters/src/scratchpad-context.ts), [run timing and catch-up](https://github.com/elie222/rakazo/blob/70b1fef42fb517f36bccede5b222e1df0df5cf33/docs/run-execution.md).
- [MCP annotation trust](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations): hints from an untrusted server do not establish tool safety.
- [Bot wake sources](bot-wake-sources-plan.md), [Bot autonomy design](../superpowers/specs/2026-10-27-bot-autonomy-design.md), [usage/spending](usage-limits-and-spending-plan.md), [durable jobs](durable-jobs-leases-plan.md), [CLI durable Bots](../cli-durable-bots.md).

## Implementation checklist

Progress (2026-11-03): W0 is complete for source research and offline acceptance. Reliable watch hand-offs, source/configuration fencing, live receipt retry and issue lifecycle passed GPT-6.1 Sol high review after fixes. The connector spike separately passed the same model/reasoning review after fixing Swift/JavaScript Unicode comparison differences. The registered proactive suite passes 120 tests, including two real SIGKILL hand-offs and 18 connector fixtures. Root type-check and narrow ESLint pass. See [connector evidence](../research/bot-connector-watch-spike.md): iMCP Calendar remains a prototype because stable account/recurrence/cancellation guarantees are unavailable. The installed Composio tool inventory was inspected read-only and exposes generic orchestrators rather than direct mail/calendar readers. The owner approved a narrowly restricted fixed-read adapter (D8) and one Composio tool/service allowance (D9). No connector content was fetched and no settings were changed.

- [x] D6/D7 answered and all owner decisions reconciled (2026-11-03).
- [x] W0 source evidence, offline connector acceptance and persistent hand-off tests; both high-review scopes clear. Live account/provider admission gates remain with W1.
- [ ] W1 watches complete on desktop, iOS and Android.
- [x] Open work implemented on desktop, iOS and Android; core and client Sol high reviews clear after fixes, with packaged/physical checks retained in final acceptance.
- [x] Routine models/thinking/fallback implemented on all clients; runtime proof and core/client Sol high reviews clear, with packaged/physical checks retained in final acceptance.
- [ ] Approved Bot pairs, peer delivery/results and budgets complete on all clients.
- [ ] Docs, onboarding/gallery and focused suites complete in each feature PR.
- [ ] Integrated packaged/native acceptance recorded; remaining limitations explicit.
- [ ] Plan inventory status updated and completed plan archived when appropriate.
