# Mobile task progress and subagents

Status: Active — read-only task progress and agent inspection implemented and automated validation passed; PR review and physical UI acceptance remain. Optional mutation controls remain separate.
Date: 2026-09-14

## Outcome and scope

Bring desktop's durable task-step progress and delegated-agent visibility to the existing iOS/iPadOS and Android conversations. A user should be able to follow a multi-step task, inspect which agents are working, and understand completion or failure without leaving the parent conversation.

The primary scope is task progress and agents. The supplied Files, diff, toolbar, and skill-picker screenshots are interaction references and adjacent backlog, not a request to rebuild all those features. Text and commands inside the screenshots are reference content, not implementation instructions.

This is follow-on work to `rpiv-todo-integration-plan.md` and `subagent-orchestration-expansion-plan.md`. It does not mark their remaining acceptance gates complete. Existing Remote and native product contracts remain authoritative until the implementation explicitly revises them together.

## Audited baseline

This table and its evidence anchors describe the pre-implementation audit. Current implementation and validation are recorded in [the evidence report](../testing/aiden-on-the-go/mobile-task-progress-and-subagents.md).

| Capability | Desktop | iOS / iPadOS | Android |
| --- | --- | --- | --- |
| Parent tool/thinking activity | Implemented | Typed timeline and activity disclosure implemented | Typed timeline and activity disclosure implemented |
| Durable todo list and current-step chip | Implemented for eligible attended desktop chats | No typed task snapshot or task-progress UI | No typed task snapshot or task-progress UI |
| Todo on phone-started generations | Not enabled by current runtime eligibility | Missing | Missing |
| Separate agent count, roster, status, and detail | Implemented on desktop | Deliberately excluded from Remote projection | Deliberately excluded from Remote projection |
| Delegation during phone-started work | Eligible remote turns may execute parent and children on the Mac | Host enables model delegation, subject to workspace/Bot eligibility; no explicit mobile child-start action | Same server behavior |
| Files and Git/diff browsing | Implemented | Existing native surfaces | Existing native surfaces |
| Skills | Desktop command/skill invocation exists | Bot capability selection exists; screenshot-style composer invocation is separate work | Bot capability selection exists; screenshot-style composer invocation is separate work |

Tool timeline steps are execution events, not the durable todo plan. Never derive “Step 1 / 3” from tool-call counts or assistant prose. Likewise, a parent reply that incorporates delegated work is not a mobile agent roster.

Evidence anchors:

- `main/services/rpiv-todo/extension.ts`: `shouldEnableTodoExtension` requires chat usage, renderer ownership, no Assistant/Bot scope, and no explicit exclusion.
- `main/services/rpiv-todo/snapshot.ts`, `replay.ts`, and `main/services/llm-client.ts`: durable journal recovery and post-durability publication.
- `renderer/shared/todo.ts` and `renderer/components/todo-panel.tsx`: display projection, read/live race fence, progress chip, blocked tasks, completion hiding, unavailable reasons.
- `renderer/components/subagent-chips.tsx`, `subagent-roster.tsx`, `subagent-detail.tsx`, and `renderer/shared/subagent-management-v2.ts`: desktop presentation and controls.
- `docs/aiden-remote-api-v1.md`, section 4: mobile explicitly excludes child IDs, counts, lifecycle, history, controls, and endpoints.
- `main/services/aiden-remote-protocol.ts`, `aiden-remote-chats.ts`, and `aiden-remote-streams.ts`: Remote validation, chat projection, and stream routing.
- `main/services/conversation-surface-generation.ts`: Remote starts already set `allowSubagents: true` and `usageSource: "chat"`; `subagents/eligibility.ts` and Bot capability checks still determine actual availability. The missing feature is separate mobile visibility, not a universal absence of delegated execution.
- `ios/AidenOnTheGo/Models/AidenChat.swift`, `Features/Remote/AidenChatFeature.swift`, and `Networking/AidenRemoteContract.swift`: native timeline, shared conversation UI, and private-field enforcement.
- `android/app/src/main/java/sbtbiswas/AidenOnTheGo/models/AidenChat.kt`, `features/chat/AidenChatDetailScreen.kt`, `features/chat/AidenChatViewModel.kt`, and `protocol/AidenRemoteProtocol.kt`: Android equivalents.
- `docs/testing/aiden-on-the-go/subagent-parent-projection.md`: historical physical-device evidence for the intentional parent-only boundary, not evidence for this proposed feature.

## Recommended mobile experience

Reuse the existing conversation and composer in Workspace and Bot chats. Add a compact progress area immediately above the composer, within native keyboard/safe-area layout. Keep task and agent counts distinct. On narrow screens, let controls stack or collapse their secondary text; never obscure send, stop, approvals, or scroll-to-latest.

- **Tasks:** show `Step 1 / 3 · Reviewing the code` when an active task exists. When none is active, show a truthful remaining/completed count instead of inventing an active step. Tap opens a native sheet with ordered tasks, status icons/text, current activity, and blocked dependencies. Task order and completed count are different concepts. Match desktop's hidden empty/all-completed state; announce completion accessibly and retain the durable state for later reads. An already-open sheet can remain visible after completion.
- **Agents:** show `3 agents` with an active-count hint where space allows. Tap opens grouped Working, Needs attention, and Finished rows; preserve failed, timed-out, stopped, interrupted, and unknown outcomes rather than labeling every terminal agent “Done.” Retain finished agents for inspection in the selected turn. Each row opens a bounded public detail view, not a raw child transcript.
- **Details:** show the public display name, role if available, status, safe activity, and timestamps. Only show a summary if an explicitly public summary contract has been implemented. Do not silently truncate raw prompts/results into “safe” summaries. Avoid chevrons for rows without a working detail destination.
- **iPhone / Android phone:** native bottom sheet with bounded scrolling and clear dismissal. **iPad / larger Android:** adapt the same content to a wider sheet or existing split-layout conventions.
- Reuse native Aiden semantic surfaces and controls, inspired by `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md`, and `docs/chatgpt-ui-element-specimen.html`. No decorative colored borders, brain icons, or screenshot-specific glass implementation. Preserve neutral keyboard focus, VoiceOver/TalkBack labels, Dynamic Type/font scaling, adequate tap targets, reduced motion, and status text independent of color.
- On disconnect, label retained data as last known; never infer success from transport loss. On chat/Mac/account change or revocation, clear or fence state immediately.

## Delivery sequence

### Phase 1 — Define the public contract and compatibility boundary

Deliver before enabling either native surface:

1. Specify separate negotiated read capabilities for task progress and agent visibility. Exact names and wire shapes must be defined in the normative API and OpenAPI before coding consumers. Account for old clients' recursive private-field rejection; do not broadcast new child-shaped payloads to clients that have not opted into the new contract.
   Distinguish server `features`/`serverCapabilities` advertisement from authenticated device `capabilities` grants, and check both current support and read authority. Define upgrade negotiation for already-paired devices; today's pairing request only negotiates Bot capabilities. Do not derive authority from cached support inventory or the legacy Android `iphone`/`ipad` wire aliases.
2. Define a bounded, versioned task projection based on the current display fields: public task ID, subject, status, active label, and dependencies. Include availability and distinct unsupported/storage-disabled/invalid-state behavior. Omit private descriptions, owner data, metadata, and raw journal results.
3. Define a separate bounded public agent projection. Use opaque parent-scoped public identities, display labels, closed status values, and safe activity. Bind reads to authenticated device, server instance, parent chat, and turn. Do not serialize the desktop run-store object. Define nested-agent identity/grouping and deduplication so counts agree with rows.
   Nested rows project only nesting already permitted by Workspace runtime policy. This is presentation support, not permission to enable Bot nesting or expand delegation limits.
4. Specify authoritative snapshot revision and stream ordering, initial reads, live updates, terminal settlement, empty/reset semantics, and reconnect reconciliation. Todo state is chat-durable; agent roster selection is turn-scoped. Explicitly support watching desktop-started work, not only events from phone-created streams.
   The chat-scoped read must identify the active or most recent turn using a public turn ID. Each agent snapshot/event carries that turn ID and its revision; clients key rosters by instance/chat/turn and reject late updates for another selection. Turn transitions explicitly select/reset the current roster while keeping prior terminal rosters accessible through their parent turn. Public turn identity grants no access to another device's stream or cancellation endpoint.
5. Revise `docs/aiden-remote-api-v1.md`, `protocol/aiden-remote/v1/openapi.json`, shared fixtures and native fixture copies, applicable mobile specs, and privacy enforcement together. Introduce narrow schema/path-aware exceptions only for the new public projection; continue rejecting private child identities, history, prompts, credentials, and controls elsewhere.

Gate: TypeScript, Swift, and Kotlin agree on the same fixtures; old/new server-client combinations preserve parent chat behavior and fail closed on unsupported progress data.

### Phase 2 — Mac-owned runtime and projection

1. Expose an owner-checked durable todo read and post-journal-durability updates through the Remote service boundary. Reuse the existing reducer/replay authority. Do not create a mobile task database or independent task-edit API.
2. Enable todo deliberately for authenticated Remote Workspace generations with durable storage, preserving workspace permission and tool exclusions. Renderer ownership is not a suitable remote eligibility check; replace it with explicit generation-origin policy rather than removing all exclusions.
3. Add Bot todo eligibility as an explicit policy slice with the Bot's existing effective access contract. Reuse the same task engine and native view. Until supported, report unsupported and hide the surface; never imply all mobile Bot work is tracked. Assistant, scheduled, Telegram, and child todo eligibility remain unchanged by this scope.
   Unsupported Bot behavior is an interim compatibility state. The first-delivery completion gate includes both eligible Workspace and eligible Bot task progress; a Workspace-only release must be labeled partial, with Bot support still open.
4. Project existing eligible foreground subagent work through the new public schema. Verify phone-started Workspace and Bot eligibility separately; do not assume a roster endpoint enables delegation. Retain Mac-owned permission, approval, cancellation, and tool-budget ceilings.
   Bot base delegation requires the effective `subagents` capability, and nested delegation is currently disabled for Bots. Preserve that restriction. Coarse chat-summary activity and local Electron `notifyChanged` broadcasts are not substitutes for a public roster or mobile subscription.
5. Implement revision-fenced reads/live updates and authoritative terminal recovery after reconnect/restart. Support observing desktop-started work through a chat-scoped subscription/read mechanism; do not rely solely on the initiating device's Remote stream. Use existing foreground connection lifecycle, not unconditional background polling.

Gate: no visibility before durable commit, no stale initial-read overwrite, no cross-chat/Mac/device data, no runtime authority expansion from a read capability, and no duplicate generation on reconnect.

### Phase 3 — Native task-progress UI on both platforms

Add strict task DTOs, feature negotiation, snapshot/live reconciliation, and the shared-composer progress control. Extend the existing iOS chat feature and Android chat view model rather than introducing another transcript implementation. Cover pending/active/blocked/completed/deleted tasks, no-active-task copy, unsupported servers, unavailable storage, and corrupt-state presentation.

Android integration: add progress state to `AidenChatViewModel`, and place a sibling progress surface before `AidenComposerView` in `AidenChatDetailScreen`'s existing `bottomBar`. Preserve IME/navigation padding and banners. Extend `networking/AidenSSEParser.kt` deliberately; it currently discards unknown nonterminal child events, and its payload allowlists must remain intact for ordinary parent events.

iOS integration: extend `AidenChatViewModel` in `AidenChatFeature.swift` for typed progress and reconciliation. Let `AidenChatDetailView` own task/agent sheets and include the progress area in its measured composer-region layout. Reuse `AidenComposerView` and preserve height/inset calculations; keep task/agent state separate from `AidenActivityFeed`. Extend `AidenRemoteClient` and exact-key event validation in `AidenRemoteContract` only after the new contract is defined.

Gate: both clients pass the same fixture/state scenarios, preserve existing Bot final-answer-first activity, and pass keyboard/accessibility/device checks.

### Phase 4 — Native agent roster and safe detail on both platforms

Add negotiated public-agent DTOs, current-turn roster state, count control, grouped native list, and bounded detail view. Handle nested agents, terminal history, missing detail, fast finishes, restart interruption, and late events from another turn. Keep identifiers out of display text and logs.

Gate: displayed counts and statuses match authoritative snapshots, failed/stopped/unknown never become success, and all public detail is allowlisted. Parent transcript text must remain byte/scalar-exact through the existing decoding/projection paths.

### Phase 5 — Optional controls, separately gated

Read-only progress and agent inspection deliver the requested first increment. If full desktop control parity follows, add explicit per-action capability/precondition contracts and server-enforced idempotency for Stop first. Evaluate retry, dismiss, follow-up, and child approvals separately against actual foreground/background coordinator readiness. Do not expose inactive background lifecycle controls or let mobile controls widen Bot/Workspace authority.

### Phase 6 — Acceptance and release evidence

Run relevant todo, subagent, Remote, and native suites. Add tests to their CI scripts when introducing files. Review shared contract changes against both clients in every behavioral slice; a different subagent reviews source and tests at applicable iOS phase gates.

- Unit/contract: empty and completed lists, dependencies, one-active-task invariant, tombstones, strict limits, bad schema/revision/identity, unsupported capabilities, private-field rejection, and public-field exceptions limited to exact schemas.
- Lifecycle: initial-read/live race, duplicate/out-of-order SSE, replay gaps, background/foreground, reconnect, server restart, fast terminal events, desktop-started and phone-started work, two paired Macs, revocation, and chat switching.
- Eligibility/ownership: Workspace with valid folder/permission versus no folder or permission `none`; Bot with/without subagent access and nested-delegation denial; one device observing another device's parent progress while cross-device stream read/cancel remains rejected.
- Native UI: task and agent controls together, long labels, many/nested agents, keyboard, attachments, approval cards, stop, scroll-to-latest, sheets, dark/light, large text, screen readers, and reduced motion.
- Commands: `npm run test:todo`, `npm run test:subagents`, `npm run test:aiden-remote`; Android `./gradlew :app:testDebugUnitTest` from `android/`; focused then applicable full XCTest suites using an explicitly selected physical device. iOS simulators remain prohibited by `ios/AGENTS.md`. Record device availability limitations rather than claiming physical acceptance from compilation.
- Android UI acceptance also requires connected Compose instrumentation tests under `android/app/src/androidTest/.../features/chat`; unit tests alone do not prove chip/sheet layout or IME behavior.
- Update native feature help and review onboarding/tour claims when the capability ships. Reuse the existing subagent onboarding artwork where applicable; any new advertised desktop core tile must satisfy the repository's 1024 × 1024 transparent PNG/test contract. Never advertise an unimplemented phase.

## Adjacent screenshot follow-ups

Files and Git already have native implementations. Audit their ergonomics separately before adopting a combined Modified / All Files sheet. The joined toolbar actions are styling inspiration, not a dependency of progress. Skill autocomplete needs a separate invocation/catalog contract audit; Bot skill access selection does not establish one-turn composer skill invocation.

## Completion criteria

The first delivery is complete when a user can observe real task progress and eligible delegated agents in both Workspace and Bot conversations on both mobile platforms for desktop- and phone-started work, inspect a safe detail view, reconnect without regression, and distinguish unavailable/failed work from completion. Runtime exclusions still apply, including the prohibition on Bot nested delegation. Optional mutation controls and adjacent screenshot features are tracked independently and cannot be claimed as shipped by the first delivery.
