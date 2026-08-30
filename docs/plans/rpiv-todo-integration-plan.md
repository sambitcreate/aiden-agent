# Aiden-native rpiv-todo integration

Status: Partial. The attended-desktop implementation and automated gates ship; packaged visual and accessibility acceptance remain open.

Reference: `@juicesharp/rpiv-todo` 2.8.0 in `rpiv-mono/packages/rpiv-todo` (MIT). Aiden adapts the durable-snapshot idea and task semantics to its existing Pi runtime, private journal, IPC, and React renderer. It does not load the upstream extension, terminal overlay, config files, localization bridge, shortcut, or `/todos` command.

## Product outcome

For an ordinary renderer-owned desktop chat, the model can maintain a durable task graph with one current task. A floating elevated chip above the composer shows the current step without changing transcript or footer geometry; hover or keyboard focus opens the complete task list in a portal overlay. The chip stays visible while any task is pending or in progress and removes its visual chrome once all visible tasks are completed or deleted. The state survives generation boundaries, reload, and Pi compaction because every successful or rejected tool call returns the complete post-call snapshot in the private Pi journal. Empty and completed task lists stay out of the way. There is no setup, network access, onboarding tile, or renderer access to private descriptions, owners, or metadata.

The extension is deliberately excluded from Assistant mode, Bots, Telegram/mobile, scheduled or child work, non-renderer-owned generations, and requests that explicitly exclude the `todo` tool. Those surfaces need separate product and authority decisions rather than silently inheriting a desktop capability.

## Delivered architecture

1. `main/services/rpiv-todo/contract.ts` defines the closed version-1 snapshot and parameter contract, terminal/control-character sanitization, descriptor-safe plain-JSON checks, hard byte/count/depth limits, dependency DAG validation, and the one-`in_progress` invariant.
2. `main/services/rpiv-todo/reducer.ts` owns create, update, list, get, tombstone delete, and clear. Validation failures are successful in-band tool results with an unchanged complete snapshot, so the journal remains replayable. Completed tasks cannot reopen; deleted tasks remain tombstones until clear; dependency references are preserved.
3. `main/services/rpiv-todo/replay.ts` scans the current Pi branch for the newest todo tool result. A malformed newest result fails closed and disables todo for the chat; it never regresses to an older valid state. Compaction entries do not become a second state authority.
4. `main/services/rpiv-todo/extension.ts` contributes a generation-local native Pi tool and guidance. Replay policy is `safe`: mutation exists only in the generation closure until the full result is durably journaled, so a crash retry cannot duplicate durable state. Renderer publication waits for a durable `toolResult` `message_end` runtime event.
5. `main/services/llm-client.ts` opens the private chat session before freezing runtime contributions, replays todo state, requires an explicitly classified chat usage source, publishes the initial projection, and sends later projections only after journal durability. Verified corrupt replay immediately publishes the content-free unavailable projection.
6. `main/handlers/chats.ts` exposes an owner-fenced `chats:todoSnapshot` read. It rechecks the exact renderer document after asynchronous work. Corrupt todo journals return a content-free unavailable state; other storage errors remain errors.
7. `renderer/shared/todo.ts` is the only renderer projection. Its strict versioned allowlist contains `id`, `subject`, `status`, `activeForm`, and `blockedBy`. Tool arguments/results, descriptions, ownership, metadata, and journal structure remain private.
8. `renderer/lib/ipc.ts` validates both snapshot reads and stream notifications, and fences notifications by generation stream and chat id. A local live-snapshot revision fence prevents a slow initial read from replacing newer generation state. `renderer/components/todo-panel.tsx` renders a zero-layout-height elevated chip anchored above the footer and a portal-backed, headerless hover/focus task list with semantic Aiden tokens, per-task screen-reader status, bounded polite progress/unavailable announcements, and reduced-motion behavior. `ScrollArea` raises its centered scroll-to-bottom control only while this overlay is visible, so the two controls never share a hit target. Fully completed plans retain only the live-region completion announcement.
9. `main/services/generation-timeline.ts` exposes only the content-free activity label “Update task list.”

## Intentional differences from upstream

- Aiden uses its existing encrypted/local application data and private Pi journal; it never reads `~/.config/rpiv-todo`.
- One active task is a hard reducer invariant, not prompt-only guidance.
- Snapshot parsing rejects accessors, proxies, sparse arrays, cycles, excessive depth/nodes/bytes, unknown schema versions, dangling dependencies, and corrupt newest results.
- Validation errors keep the tool result structurally successful and replayable instead of relying on thrown extension errors.
- The task surface uses Aiden's document-scoped IPC and React surface instead of a terminal widget. A Radix hover card supplies mouse and keyboard-focus disclosure without resizing the transcript; the portal list is visually bounded.
- Copy/fork operations copy visible chat history but start with an empty private todo journal. This prevents hidden operational state from crossing chat authority boundaries.
- `/todos`, a global collapse shortcut, editable renderer tasks, localization packs, and onboarding are not imported. The contextual chip is the primary user-visible value while work remains.

## Acceptance and coverage

`npm run test:todo` is registered in `pretest` and covers:

- strict contract parsing, sanitization, size limits, graph invariants, transitions, tombstones, and unchanged in-band error snapshots;
- branch replay, compaction survival, no-snapshot initialization, and fail-closed newest-result corruption;
- admission fencing, per-generation state isolation, cancellation, replay policy, and real harness coverage proving publication follows successful durable append and never follows append failure;
- closed renderer projection and unavailable-state parsing;
- slow-initial-read versus live-snapshot ordering and immediate corrupt-replay unavailability;
- floating chip progress/current state, portal detail/dependency rendering, completed/empty self-hiding, unavailable warning, per-task screen-reader status, and bounded polite announcements;
- IPC inventory plus stream/chat scoping and malformed notification rejection;
- the content-free generation timeline label.

Before release, perform one packaged macOS visual pass with a long list, keyboard disclosure, VoiceOver labels, light/dark themes, reduced motion, reload, compaction, cancellation, and deliberate corrupt-journal recovery. Confirm excluded surfaces receive no todo schema. No native-client update is required while the feature remains explicitly desktop-only and sends no shared remote contract.

## Remaining risks and follow-ons

- Version 1 has no migration path. A future schema must add an explicit parser/replay migration rather than weakening validation.
- A corrupt newest snapshot intentionally makes the panel unavailable until the private journal is repaired or the chat is deleted; a future repair action needs an explicit destructive-data design.
- The durable observer may republish the unchanged snapshot after other tool results. This is bounded and correct, but a future typed event could avoid redundant IPC.
- The floating surface is read-only. Direct manipulation, command-palette access, completed-plan history, and mobile/Bot/Assistant adoption are separate product proposals with their own authority and test gates.
