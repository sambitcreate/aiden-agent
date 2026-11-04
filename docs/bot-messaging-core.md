# Bot messaging core

Implementation checkpoint for phase A Tasks 1–7, 2026-11-03. The core review gate is pending. Desktop transcript rows, CLI hosting, Remote and native clients, onboarding and full phase acceptance remain Tasks 8–11. This is not a release or device acceptance record.

`message_bot` accepts a private, profile-local delivery and returns immediately. Its tool task never calls a Bot session. An external courier submits only when the destination is idle, using an atomic idle-only send, and waits for the final answer. Busy destinations stay in the ledger, with no queued Bot input in Pi. The courier observes the actual running submission with a cancelable `awaitReply`, then requeues the saved effect when it settles. Deliveries share one observation per Bot/submission, including another delivery's target turn; natural completion needs no synthetic state-change event. The courier never resumes, stops, dismisses or withdraws a person's work.

The receiving input has the host-owned `aiden.bot-message-input` kind with its delivery id and deadline. A separate `bot_message` notice holds the clean display text. Request ids use `bot:<sender>:<hop>:<uuid>` and `botreply:<uuid>`; sender ids may contain colons. Prefixes alone cannot supply a deadline or approval ownership. The extension reads every actual run input and its metadata before requests, tools and approvals, then rechecks after waits and before effects. An expired Bot-only run ends its own generation task. A mixed run keeps the person's work and blocks further tools.

Only a final, non-silent answer becomes a reply turn. Silence, failure and expiry create display notices, with durable notification effects. A paused or interrupted sender gets the saved answer in a display-only row. One nested child is allowed; its continuation satisfies the parent's single origin reply obligation. Early child answers, silence and failures remain durable until the parent's initial turn ends. The ancestor deadline can still expire that exchange. A person's ordinary hop-0 turn may explicitly request several sends within the existing quotas; the once-per-parent reservation applies to an incoming hop-1 turn. Empty run input lists are denied; `[undefined]` represents a real unlabelled person input. Hop 2, reply, routine, Telegram and intro turns cannot call `message_bot`. Other Bots' text cannot approve actions, change settings or become personal memory. Bot-message turns withhold questions, hand-offs, sign-in, browser, routines, subagents, skill proposals, wake-ups, memory writes and recall. Ordinary approvals and rule-made asks still wait for the person, owned by the actual run inputs. Deadline and deletion denials are marked `expiry`. Only currently pending, owned approval cards can produce `gave_up`; an answered card stays historical and cannot change a later timeout. Approval changes reconcile only the changed Bot, with serialized updates. Reply approval notices name the Bot that owns the reply turn.

Settings → Bots has **Bots can message each other**. Advanced → Other Bots has **Other Bots can message {name}** and **{name} can message other Bots**. All default on; only `false` is stored. The global off state disables the per-Bot controls. These switches gate new sends, and accepted deliveries keep their original deadline.

Limits are 4,000 message characters, 8,000 forwarded answer characters, three unfinished exchanges per sender, 20 accepted sends in five minutes followed by a persistent ten-minute cooldown, 30 sends per local day for each unordered pair, and a 30-minute exchange window. An admitted child inherits the earlier ancestor deadline. Refused attempts do not consume quota; accepted failures do.

The ledger is `<profile>/bots/bot-messages.json`, written atomically with mode `0600`. One profile-wide serial protects admission, counters, child reservations, receipts and transitions. It is never held across a session, approval or delivery-funnel call. At most 500 full display rows are retained; open work and unacknowledged effects cannot be evicted. Replay receipts and quota bookkeeping are independent of those rows. Receipts contain a SHA-256 identity hash, destination identity and the host-owned durable tool task ID, without another copy of the private message or answer. The tool task memo preserves that identity across replay. A read-only task-graph observer collects the receipt when that task reaches completing or terminal state, independently of the display rows. No elapsed-time expiry is used. Direct adapters that omit the optional host task ID retain only their minimal hashed receipt; production desktop and CLI tool adapters supply the ID. Replay resolves against the original accepted target arguments, case-insensitively, so a rename cannot redirect an accepted delivery. Expired quota windows are collected independently; active cooldowns and daily pair counts survive display pruning. No-op transitions do not rewrite the ledger.

Unreadable or malformed bookkeeping fails closed and preserves the file for repair. Deletion first records the Bot ID in the mode-0600 `bot-messages.json.pending-purges.json` sidecar and an in-memory tombstone, then removes private envelopes and receipts under the ledger serial. A corrupt main ledger does not block Bot deletion; its saved purge IDs apply before the first later read after repair. The sidecar must remain available with the profile. Deletion atomically repairs surviving parent obligations and preserves a failure notice for a peer owed a reply, including a terminal delivery with pending effects. Workers cancel observation without resuming or stopping the person's sessions.

Target and reply submissions use deterministic request ids. Each display or notification effect has its own stable id and acknowledgement, saved only after its destination write. Startup reattaches open work, replayable task receipts and pending terminal effects; repeated startup is safe. Deadline timers exist only for live future obligations. Settled exchanges cancel them. An interrupted submitted reply falls back to saved display text at its deadline and releases capacity without resuming the person's work. Failed publication waits for an external wake or restart; it has no timer retry loop. The delivery funnel receives only the root sender's final answer as class `bot_message`, never a child's independent origin notification.

Run `npm run test:bot-messaging`, `npm run test:bot-runtime`, `npm run test:bot-rules`, `npm run test:bot-pause`, `npm run test:bot-handoffs`, `npm run test:bots`, `npm run type-check` and `npm run test:ci:registry`. The registered `real-courier.test.ts` uses real durable sessions, real timers and the faux provider for natural busy completion, shared submission waits, quiescence and tool-task receipt settlement. Fresh checkouts also need `npm run build:subagent-file-mutator` before the existing runtime file-write test. All inference in these tests uses the faux provider; no live inference or provider/catalog fetch is needed.

## Changed files

The checkpoint touches the following files. Adjacent tests exercise the changed behavior; the plan status also includes the parent's existing in-progress status edits.

- `.memory/bot-messaging-planning.md`
- `.papercuts/2026-11-03-bot-messaging-implementation.md`
- `PRODUCT.md`
- `README.md`
- `docs/bot-messaging-core.md`
- `docs/plans/README.md`
- `docs/plans/bot-messaging-plan.md`
- `docs/settings-design-system.md`
- `docs/superpowers/plans/2026-11-03-bot-messaging-a-message-bot.md`
- `main/handlers/bot-params.test.ts`
- `main/handlers/bot-params.ts`
- `main/handlers/bots.ts`
- `main/services/bot-delivery/funnel.test.ts`
- `main/services/bot-delivery/log.ts`
- `main/services/bot-memory/recall.test.ts`
- `main/services/bot-memory/review.test.ts`
- `main/services/bot-memory/review.ts`
- `main/services/bot-memory/tool.test.ts`
- `main/services/bot-memory/tool.ts`
- `main/services/bot-messages/candidate.ts`
- `main/services/bot-messages/courier.test.ts`
- `main/services/bot-messages/courier.ts`
- `main/services/bot-messages/framing.test.ts`
- `main/services/bot-messages/framing.ts`
- `main/services/bot-messages/ledger.test.ts`
- `main/services/bot-messages/ledger.ts`
- `main/services/bot-messages/messages-main.ts`
- `main/services/bot-messages/tool.test.ts`
- `main/services/bot-messages/tool.ts`
- `main/services/bot-runtime/bot-activity-detail.test.ts`
- `main/services/bot-runtime/bot-activity-detail.ts`
- `main/services/bot-runtime/bot-approvals-main.ts`
- `main/services/bot-runtime/bot-approvals.ts`
- `main/services/bot-runtime/bot-computer-candidates.test.ts`
- `main/services/bot-runtime/bot-computer-candidates.ts`
- `main/services/bot-runtime/bot-delete.test.ts`
- `main/services/bot-runtime/bot-extension.test.ts`
- `main/services/bot-runtime/bot-extension.ts`
- `main/services/bot-runtime/bot-input-entry.ts`
- `main/services/bot-runtime/bot-session-main.ts`
- `main/services/bot-runtime/bot-session-service.test.ts`
- `main/services/bot-runtime/bot-session-service.ts`
- `main/services/bot-runtime/bot-tool-assembly.test.ts`
- `main/services/bot-runtime/bot-tool-assembly.ts`
- `main/services/bot-runtime/bot-tool-policy.test.ts`
- `main/services/bot-runtime/bot-tool-policy.ts`
- `main/services/bot-runtime/bot-tool-sources-main.ts`
- `main/services/bot-runtime/tool-adapter.ts`
- `main/services/bot-store-core.test.ts`
- `main/services/bot-store-core.ts`
- `main/services/config-store-core.test.ts`
- `main/services/config-store-core.ts`
- `main/services/portable-config-core.test.ts`
- `main/services/portable-config-core.ts`
- `main/services/types.ts`
- `package.json`
- `renderer/components/settings/bots-settings.test.tsx`
- `renderer/components/settings/bots-settings.tsx`
- `renderer/lib/types.ts`
- `renderer/main/bots/bot-advanced.tsx`
- `renderer/main/bots/bot-identity.ts`
- `renderer/main/bots/bot-messaging-fields.test.tsx`
- `renderer/main/bots/bot-messaging-fields.tsx`
- `renderer/shared/bot-activity.test.ts`
- `renderer/shared/bot-activity.ts`
- `renderer/shared/bot-messages.test.ts`
- `renderer/shared/bot-messages.ts`
- `renderer/shared/bots.ts`
- `scripts/ci-test-registry.json`
