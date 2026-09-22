# Bots Mode

Status: Complete

Completed August 17, 2026. Bots now ship as main-owned durable definitions and ordinary Pi-backed chats, with first-class roster/editor/conversation UX, authoritative persona composition, soft archive/restore, exact one-to-one Telegram profile/chat/topic bindings, onboarding coverage, and regression tests. The explicitly deferred collaboration and per-bot authority features remain future work.

## Outcome

Add a first-class **Bots** destination where people can create reusable AI personas and start multiple conversations with each one. Bots remain a thin, main-owned identity and instruction layer over Aiden's existing Pi chat runtime. They do not introduce a second agent engine, message format, tool path, compaction path, or workspace authority model.

## Research summary

Hermes Desktop implements Bot Mode as a default-on plugin over its existing profile/session gateway. A profile is a bot, and its canonical `Bot Chat` remains an ordinary durable session. Bot configuration changes invalidate the stored prompt fingerprint rather than forking the runtime. The useful lessons for Aiden are:

- Keep bot definitions and chat binding backend-owned.
- Use an explicit bot identifier instead of a magic chat title.
- Reuse the established chat/runtime surfaces.
- Make instruction update and archive behavior explicit.
- Avoid bringing Hermes' groups, routines, mentions, cross-bot shell handoffs, remote profiles, or multi-source routing into the initial feature.

## Product contract

- A bot has a stable ID, name, optional description, instructions, a bounded semantic avatar preset, timestamps, and optional archive timestamp.
- A bot inherits the model, provider, workspace, permissions, tools, skills, MCP access, and Pi behavior of each conversation. The bot itself cannot widen authority.
- A bot can have multiple conversations. Each conversation is an ordinary persisted Aiden chat tagged with `botId`.
- A bot can be bound one-to-one to a Telegram chat. Telegram messages routed through that binding use the bot's ordinary Pi-backed conversation and cannot bypass Aiden's existing pairing, ownership, queue, workspace, or tool-approval boundaries.
- Editing a bot updates its instructions for subsequent turns in all of its conversations. The main process resolves the current bot at generation start.
- Archiving a bot hides it from the active roster but preserves its definition and transcripts. Existing conversations remain readable; new messages and new conversations are blocked until it is restored.
- Ordinary workspace chat lists exclude bot conversations. Internal all-chat maintenance continues to see every chat.
- Legacy chats and stores without bot fields continue to load unchanged.
- Existing unbound chats remain on disk unchanged. Named Telegram profiles now use profile-namespaced chat IDs; this intentionally starts an isolated transcript for each named token instead of continuing the previously shared owner-only session, because preserving that alias would keep the cross-profile history collision this feature closes.

## Non-regression invariants

1. Renderer generation parameters never accept a bot ID, instructions, system prompt, tool set, or permission override.
2. `llm-client` resolves bot identity from the authoritative persisted chat after turn admission.
3. Bot instructions are appended to the normal Pi system prompt before the existing runtime contribution snapshot. No Pi session, history, compaction, tool, subagent, approval, or provider code is duplicated.
4. A bot prompt cannot change workspace authority or claim capabilities absent from the normal prompt/tool inventory.
5. Ordinary chat creation and Aiden Assistant's reserved creation/mode paths keep their existing parsers and behavior.
6. Bot archive is recoverable and never deletes transcripts.

## Delivery phases

### Phase 1 — Contracts, durable storage, and IPC

- Add shared bot contracts and strict bounded parsers.
- Add an atomic, device-local bot store with malformed-record recovery and soft archive/restore.
- Extend chat payload/index metadata with optional `botId`.
- Add explicit regular-chat and bot-chat list methods without changing internal all-chat enumeration.
- Add dedicated `bots:*` IPC for list/get/create/update/archive/restore and conversation creation/listing.
- Add focused store, parser, migration, and IPC authority tests.

### Phase 2 — Pi-native runtime composition

- Resolve the persisted bot for bot-bound chats in `llm-client` after the authoritative chat read.
- Reject missing or archived bot identities for new generations.
- Compose a bounded, clearly delimited bot persona section into the established normal workspace system prompt.
- Preserve the existing runtime extension, tool, skill, context-capacity, session, and compaction order.
- Add tests proving ordinary prompts are unchanged and renderer input cannot forge bot identity or instructions.

### Phase 3 — First-class Bots UX

- Add `/bots` and `/bots/$botId` routes inside the persistent workbench.
- Add a Bots sidebar destination without mixing bot chats into workspace recents.
- Build roster, empty state, create/edit, archive/restore, and conversation-list flows using existing UI primitives and semantic tokens.
- Open bot conversations through the existing `ChatPane` and show bot identity in its header.
- Add React Query cache keys/invalidation and accessible loading/error/focus states.
- Update focused sidebar, routing, component, and chat-pane contract tests.

### Phase 4 — Onboarding and verification

Before onboarding, deliver the Telegram binding expansion:

- Extend the existing Telegram thread/profile registry with a typed bot binding after auditing its current ownership and thread model.
- Enforce at most one active Telegram chat per bot and at most one bot per Telegram chat.
- Route inbound messages through the existing Telegram queue/turn admission and the bot's authoritative persisted identity.
- Surface bind/unbind and live connection state in the Bots experience; keep token and owner pairing in Telegram Settings.
- Preserve existing Telegram workspace authority, model/thinking controls, compaction, rich inbound/outbound, and backing-chat isolation.
- Add ownership, collision, archive, routing, restart-recovery, and forged-binding tests.

### Phase 5 — Onboarding and verification

- Add Bots to the final onboarding feature-tour bento.
- Add a cohesive optimized 1024 × 1024 transparent PNG and extend the asset contract test.
- Run focused tests after each phase, then type-check, lint, the full relevant test suite, build, and React Doctor.
- Perform a final fresh-context review and remediate findings.
- Start the development app for interactive acceptance.

## Explicitly deferred

- Bot-to-bot messaging, group rooms, mentions, routines, remote bot registries, separate tool/MCP grants, per-bot workspaces or permissions, avatar uploads, and independent runtime processes.
- Model/provider pinning on the bot definition. Conversations already persist their selected provider/model and retain Aiden's established model controls.
