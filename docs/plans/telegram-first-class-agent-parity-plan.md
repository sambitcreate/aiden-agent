# Telegram First-Class Agent Parity

Status: Implemented; credentialed Telegram client smoke pending

Date: 2026-08-13

Reference baseline: `@llblab/pi-telegram` `0.27.12` at `/Users/sambitbiswas/projects/opp/pi-telegram`

## 2026-08-13 completion tranche

The remaining work is implemented in dependency order:

1. **Runtime integrity and shared state.** Consume generated actions once, debounce
   albums, handle reaction shortcuts, recover polling-offset failures, reset all
   owner-bound state during re-pairing, and make Telegram model changes use the
   same provider/model selection as the desktop workspace. An in-flight switch
   aborts safely and queues one continuation against the new model.
2. **Rich transport.** Persist arbitrary inbound files in a private Aiden Telegram
   inbox, expose their exact local paths to the accepted turn, add native Rich
   Markdown and Rich Draft delivery with a known-safe HTML fallback, and add
   configurable hidden/mirror/always outbound voice policy through registered TTS
   providers.
3. **Routing and identity.** Add isolated named bot profiles, profile-scoped tokens,
   offsets, owner state, diagnostics, transport ownership leases, and private-chat
   thread targets that route to explicit Aiden workspaces/agents without launching
   hidden processes.
4. **Extension and direct-delivery surface.** Add bounded registries for commands,
   menu/status sections, update handlers, callbacks, inbound/outbound handlers and
   voice providers. Expose target-aware `telegram_help`, `telegram_message`,
   `telegram_attach`, and `telegram_voice` tools; every cross-target send is fenced
   to one live profile owner and one known chat/thread target.
5. **Product completion.** Surface profiles, rendering, voice, routing and
   diagnostics in Settings; document the BotFather prerequisite; then run focused
   and full tests, type-check, lint, production build and a credentialed-client
   smoke gate when credentials are available.

Final review hardening added structurally closed Rich Draft prefixes without a
post-final phantom draft, BotFather `has_topics_enabled` capability detection,
automatic voice interception with text fallback, the full documented reaction
shortcut set, cleanup of stale/disabled topic mappings, OGG/Opus provider
validation, and workspace-readable inbound file copies. Cross-target Telegram
tools are available to attended desktop agents as well as Telegram-originated
turns; unattended non-Telegram schedules do not gain that outbound authority.

## 2026-08-13 implementation checkpoint

Shipped in the worktree:

- Bot command registration; editable main, model, thinking, queue, workspace,
  and settings menus; abort/next/continue/stop; queue mutation; native manual
  compaction; workspace-skill command projection.
- Replies, edits, forwards, media-group coalescing, images, text documents,
  voice transcription, bounded answer drafts, thinking/tool activity modes,
  assistant-authored buttons, and workspace-fenced document delivery.
- Settings controls for thinking, drafts, and activity plus truthful onboarding
  copy. Aiden remains the only runtime/config/credential/permission owner.

The requested parity tranche is complete in source and automated verification.
Only the credentialed client smoke gate remains external: it requires a real bot
token, paired account, BotFather Threaded Mode, and a registered TTS provider for
voice delivery.

## Objective

Turn Aiden's current private-DM Telegram bridge into a first-class Aiden agent surface with product-level parity to the reference `pi-telegram` release. Parity means equivalent operator outcomes under Aiden's embedded-agent architecture; it does not mean importing Pi's CLI/TUI process assumptions or creating hidden Pi processes.

## Non-negotiable boundaries

- Aiden remains the sole agent runtime, configuration owner, credential owner, and lifecycle owner.
- Telegram operations use Aiden's encrypted secret store, app config roots, provider registry, chat store, compaction journals, generation gates, usage accounting, and shutdown barriers.
- The paired Telegram owner is the only remote principal. Thread, message, callback, reaction, attachment, and generated-action ownership are target-fenced.
- Project mode remains explicitly scoped to one configured folder workspace per accepted turn. No inferred recent workspace and no arbitrary path command.
- Remote turns never enable Computer Use, subagents, or MCP implicitly. Any future remote capability must have a separately reviewed authority contract.
- Telegram is not a PTY, hidden Pi launcher, or arbitrary local slash-command tunnel.
- Bot API client behavior follows the vendored reference in `pi-telegram/.agents/skills/telegram-bot/api.md`; client-only rendering behavior remains a live-smoke gate.

## Architecture

The implementation stays Aiden-native and uses cohesive domains under `main/services/telegram/`:

```text
main/index.ts
  -> telegram-service.ts                production composition
    -> telegram-service-core.ts         polling and authorized update orchestration
      -> telegram-controls.ts           commands, callback plans, menus
      -> telegram-session.ts            compaction
      -> telegram-activity.ts           drafts, reasoning and tool projection
      -> telegram-outbound.ts           buttons, files and voice plans
      -> telegram-inbound.ts            text, replies, edits, albums, downloads, voice
      -> telegram-thread-store.ts       private-chat topic-to-workspace routing
      -> telegram-ownership.ts          per-profile process-generation lease
      -> telegram-profile-config.ts     isolated named profile projection
      -> telegram-extension-registry.ts Aiden companion capability hooks
      -> telegram-queue.ts              accepted-turn and control lanes
      -> telegram-bot-api.ts            Bot API transport only
```

The service core composes domain ports; it must not become a second application entrypoint. Aiden adapters live in `telegram-service.ts` and `telegram-turn.ts`, never in Bot API or pure menu modules.

## Frozen parity matrix

| Surface | Reference behavior | Aiden baseline | Delivery phase |
| --- | --- | --- | --- |
| Pairing and commands | `/start`, command registration, owner gate | Partial (`/start`, `/help`) | 1 |
| Control commands | compact, next, continue, abort, stop | Only queue-clearing stop/cancel | 1 |
| Operator menu | status, model, thinking, queue, settings, sections | Plain help/status text | 1 |
| Model controls | scoped/all catalogs, paging, safe active-run switch | Settings-only provider/model | 1 |
| Thinking controls | model-aware levels | Not remote-controlled | 1 |
| Queue controls | inspect, prioritize, delete, dispatch, reactions | Internal FIFO only | 1 |
| Compaction | confirmation, active status, queue fencing | Pi-native compaction exists but no Telegram entry | 1 |
| Prompt templates | safe Telegram command projection | No Telegram projection | 1 |
| Streaming | native typing plus bounded draft previews | Typing plus final-only reply | 2 |
| Activity | configurable thinking/tool delivery | Not delivered | 2 |
| Rich answers | native Rich Markdown with HTML fallback | Markdown-to-HTML chunks | 2 |
| Inbound content | replies, edits, images, documents, albums, forwards | Text/caption only | 2 |
| Outbound content | files, voice, buttons, target-aware direct sends | Text only | 2 |
| Agent tools | attach, message, voice, help | None | 2 |
| Voice | pluggable inbound STT and outbound TTS policy | None | 2 |
| Threaded Mode | one bot, named private-chat threads, target routing | Single private DM | 3 |
| Multi-instance behavior | leader/follower Pi processes | Adapt to Aiden agent/chat targets; no hidden processes | 3 |
| Ownership and recovery | durable lock, fencing, bounded recovery | Single app process, persisted offset | 3 |
| Profiles | isolated named bot profiles | One bot token | 3 |
| Extension platform | commands, sections, status, updates, handlers, voice | No Telegram registry | 3 |
| Diagnostics | redacted ring and `/telegram-status` equivalent | Basic status/last error | 3 |
| Settings/onboarding | full controls and capability prerequisites | Basic setup/provider/workspace | 4 |

## Phase 1 — Operator control parity

- Register Telegram's BotFather command palette after connect/pair and whenever visible commands change.
- Replace plain `/start` help with one editable inline operator menu.
- Add `/compact`, `/next`, `/continue`, `/abort`, `/model`, `/thinking`, `/queue`, and `/settings`; preserve `/help`, `/status`, and `/cancel` compatibility.
- Split `/abort` from `/stop`: abort preserves waiting turns; stop aborts and clears them.
- Add model scope, paging, current selection, thinking-level selection, and busy-run switch behavior against Aiden provider/model settings.
- Add queue list/detail/priority/delete/refresh controls and reaction shortcuts.
- Expose Aiden's safe slash-command/skill-template inventory without forwarding unknown arbitrary commands.
- Bridge Telegram compaction to the existing Pi-native compaction coordinator with confirmation and queue fencing.

Acceptance: deterministic tests exercise every command and callback in idle, active, stale-menu, unauthorized, and workspace-scoped states; Bot API callback data stays within 64 bytes.

## Phase 2 — First-class input, output, and activity

- Normalize replies, edits, forwards, long split text, media groups, images, documents, and voice into immutable accepted turns.
- Download inbound files into the Aiden runtime temp root with strict size, MIME, filename, and workspace-boundary handling.
- Deliver bounded progressive drafts, provider-exposed thinking, tool activity, final Rich Markdown/HTML fallback, and exact-target chat actions.
- Add assistant-authored inline buttons with callback ownership and once-only selection.
- Add explicit Aiden tools for attachment delivery, cross-target messages, voice, and concise Telegram capability help.
- Add configurable inbound STT and outbound TTS adapters using Aiden's existing local/provider voice capabilities where available.
- Preserve usage source `telegram`, exact turn identity, cancellation, session replacement, and no duplicate final delivery.

Acceptance: text/media/voice/button/file flows pass classic and thread-targeted transport tests; secrets, raw private reasoning, unsafe paths, and stale generations never cross the Telegram boundary.

## Phase 3 — Threads, profiles, extension hooks, and recovery

- Detect private-chat Threaded Mode and provision one named thread per Aiden agent target.
- Map threads to Aiden chats/workspaces/providers rather than spawning hidden Pi processes.
- Add All-tab chooser, reroute/restore, stale-thread reconciliation, target ownership, and reaction/callback routing.
- Add named bot profiles with isolated token, offset, diagnostics, targets, and polling state.
- Add a small Aiden Telegram extension registry for commands, sections, status rows, update handlers, inbound handlers, outbound handlers, and voice providers.
- Add durable target/ownership records, process-generation fencing, bounded recovery, redacted diagnostics, and exact shutdown cleanup.

Acceptance: classic mode remains first-class; Threaded Mode/profiles are isolated; restart, stale target, duplicate update, callback, and shutdown tests prove at-most-once routing and no cross-profile leakage.

## Phase 4 — Product completion

- Expand Settings for profiles, rendering, drafts, activity, time injection, voice policy, Threaded Mode state, and diagnostics.
- Update onboarding with BotFather prerequisites and a truthful capability tour.
- Preserve the current token/pairing migration and workspace authority defaults.
- Update user docs, architecture, license/attribution, changelog, plan index, and project memory.
- Add live-smoke runbooks for Telegram macOS/Desktop/mobile clients and credentialed Bot API behavior.

Acceptance: focused tests, `npm run type-check`, scoped lint, full test, build, package verification, Domain-DAG validation, and live Telegram smoke pass. Any client-dependent or credential-dependent gate is reported explicitly rather than inferred from automation.

## Upstream limitations

- Same-thread `/new` remains unavailable unless Aiden adds an explicit remote session-replacement transaction. It must not be approximated by deleting history or launching a hidden process.
- Telegram client rendering for Rich blocks, native drafts, reactions, private-chat threads, and voice must be confirmed in a real paired bot; Bot API type support alone is insufficient evidence.
