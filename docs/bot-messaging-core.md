# Bot messaging core

Implementation checkpoint for phase A, 2026-11-03. Both independent reviewers accepted Tasks 1–7 at `79d485a75` in round 5. Desktop transcript rows, CLI hosting, Remote and native clients, and onboarding are implemented for Tasks 8–11; integration checks pass and full phase A review remains pending. This is not a release or device acceptance record.

Desktop and CLI hosts share the ledger, courier, ingress policy and projection. The CLI has no delivery funnel; paired phones read labelled transcript entries through Remote revision 54 and the negotiated `bot:messaging` capability. The CLI's Bot runner records paid response costs with the shared spending ledger in its local profile, and checks configured monthly Bot and routine-run limits. Subscription and local-model requests do not count. It adds no usage-limit waiting, spending editor or temporary-allowance UI.

`message_bot` accepts a private, profile-local delivery and returns immediately. Its tool task never calls a Bot session. An external courier submits only when the destination is idle, using an atomic idle-only send, and waits for the final answer. Busy destinations stay in the ledger, with no queued Bot input in Pi. The courier observes the actual running submission with a cancelable `awaitReply`, then requeues the saved effect when it settles. Busy observation requeues only after a real wait or an observed idle state. Deliveries share one observation per Bot/submission, including another delivery's target turn; natural completion needs no synthetic state-change event. The courier never resumes, stops, dismisses or withdraws a person's work.

The receiving input has the host-owned `aiden.bot-message-input` kind with its delivery id and deadline. The committed input metadata holds its clean display text. Projection validates and reads that metadata, independently of the separate `bot_message` notice, so a crash leaving only a notice cannot relabel a later person message or remove its Retry. Malformed Bot input metadata stays hidden and never exposes its model frame. Request ids use `bot:<sender>:<hop>:<uuid>` and `botreply:<uuid>`; sender ids may contain colons. Prefixes alone cannot supply a deadline or approval ownership. The extension reads every actual run input and its metadata before requests, tools and approvals, then rechecks after waits and before effects. An expired Bot-only run ends its own generation task. A mixed run keeps the person's work and blocks further tools.

Only a final, non-silent answer becomes a reply turn. Silence, failure and expiry create display notices, with durable notification effects. Any sender outside idle or running state gets the saved answer in a display-only row. A spending-limit or model-availability refusal racing the reply submission uses the same immediate fallback. A failed or stopped, settled reply turn also preserves that saved text in one display/status notification, without a replacement model turn or a successful-final-answer notification. An intentionally completed silent reply still respects silence, including recovery between the ancestor's silent settlement and the child's acknowledgement. One nested child is allowed; its continuation satisfies the parent's single origin reply obligation. Early child answers, silence and failures remain durable until the parent's initial turn ends. Ending a parent wakes its parked child. A saved child answer that cannot be relayed, including at the shared deadline, settles atomically as answered with one saved-text display row; it never becomes a child timeout, failed-answer or unapproved-action claim. The parent keeps its own outcome. An unanswered child uses only its own pending approvals for gave-up copy. Restart derives a missing parent hint from a committed terminal child. The ancestor deadline still bounds a live exchange. A person's ordinary hop-0 turn may explicitly request several sends within the existing quotas; the once-per-parent reservation applies to an incoming hop-1 turn. Empty run input lists are denied; `[undefined]` represents a real unlabelled person input. Hop 2, reply, routine, Telegram and intro turns cannot call `message_bot`. Other Bots' text cannot approve actions, change settings or become personal memory. Bot-message turns withhold questions, hand-offs, sign-in, browser, routines, subagents, skill proposals, wake-ups, memory writes and recall. Ordinary approvals and rule-made asks still wait for the person, owned by the actual run inputs. Deadline and deletion denials are marked `expiry`. Only currently pending, owned approval cards can produce `gave_up`; an answered card stays historical and cannot change a later timeout. Approval changes reconcile only the changed Bot, with serialized updates. Active waiting markers may be removed and re-added; waiting-notice effect IDs deduplicate independently, so a re-ask or parallel card does not duplicate effects. Reply approval notices name the Bot that owns the reply turn. After messaging shuts down, unrelated person approval announcements remain available; claimed Bot-message inputs fail closed.

Settings → Bots has **Bots can message each other**. Advanced → Other Bots has **Other Bots can message {name}** and **{name} can message other Bots**. All default on; only `false` is stored. The global off state disables the per-Bot controls. These switches gate new sends, and accepted deliveries keep their original deadline.

Limits are 4,000 message characters, 8,000 forwarded answer characters, three unfinished exchanges per sender, 20 accepted sends in five minutes followed by a persistent ten-minute cooldown, 30 sends per local day for each unordered pair, and a 30-minute exchange window. An admitted child inherits the earlier ancestor deadline. Refused attempts do not consume quota; accepted failures do.

The ledger is `<profile>/bots/bot-messages.json`, written atomically with mode `0600`. One profile-wide serial protects admission, counters, child reservations, receipts and transitions. It is never held across a session, approval or delivery-funnel call. At most 500 full display rows are retained; open work and unacknowledged effects cannot be evicted. Replay receipts and quota bookkeeping are independent of those rows. Receipts contain a SHA-256 identity hash, destination identity and the host-owned durable tool task ID, without another copy of the private message or answer. The tool task memo preserves that identity across replay. A child display fallback also stores a host-owned parentFallbackOutcome with its terminal state, so a crash before the parent's follow-up write still settles the parent. Recovery recognizes an acknowledged relay left by an incomplete fallback and never requeues it indefinitely. A task-graph observer collects the receipt when that task reaches completing or terminal state, independently of the display rows. It inspects before opening a handle to watch a validated live tool task. A task missing from the live graph cannot replay, including after corrupt-session recovery, so its receipt can be collected without consuming the pending `session_reset` notice. The next ordinary open still writes that notice. Observation starts no model work. No elapsed-time expiry is used. Direct adapters that omit the optional host task ID retain only their minimal hashed receipt; production desktop and CLI tool adapters supply the ID. Replay resolves against the original accepted target arguments using locale-independent case folding, so a rename cannot redirect an accepted delivery. Expired quota windows are collected independently; active cooldowns and daily pair counts survive display pruning. No-op transitions do not rewrite the ledger.

Unreadable or malformed bookkeeping fails closed and preserves the file for repair. Deletion fences writers with an in-memory tombstone, then durably records the Bot ID as a JSON string in an independent mode-`0600` marker under `<profile>/bots/.bot-messages.json.pending-purges/`, a mode-`0700` directory. Each marker name is `<sha256-of-bot-id>.<uuid>.json`. Markers are immutable and retained with the profile; a repeated deletion creates a fresh marker so even a damaged marker for the same Bot remains untouched. The hidden directory survives the session host's orphan sweep. This replaces the unshipped shared sidecar format without migration.

The marker write runs under the ledger serial before reading any peer marker or the main ledger. A corrupt main ledger or marker therefore does not block later Bot deletion effects once the new intent is durable. Ordinary messaging reads and validates every published marker, including its filename hash, and fails closed if any is unreadable or malformed. It never overwrites damaged evidence or publishes a partial purge. After repair, both prior and newly recorded purge IDs apply before a later messaging read returns, including after a process restart. Deletion atomically repairs surviving parent obligations and preserves a failure notice for a peer owed a reply, including a terminal delivery with pending effects. Workers cancel observation without resuming or stopping the person's sessions.

Target and reply submissions use deterministic request ids. Each display or notification effect has its own stable id and acknowledgement, saved only after its destination write. Startup reattaches open work, replayable task receipts and pending terminal effects; repeated startup is safe. Deadline timers exist only for live future obligations. Settled exchanges cancel them. Disposal fences every timer arm, joins workers and cancels remaining handles before clearing their maps; a late worker cannot re-arm a deadline. An interrupted submitted reply falls back to saved display text at its deadline and releases capacity without resuming the person's work. Failed publication waits for an external wake or restart; it has no timer retry loop. The delivery funnel carries the root sender's final answer and status notifications as class `bot_message`. A child's saved answer is display-only in its sender's chat, including recovery of an older pending notification; it is never separately forwarded through the funnel. Text-free child status notifications still use the ordinary status path.

Run `npm run test:bot-messaging`, `npm run test:bot-runtime`, `npm run test:bot-rules`, `npm run test:bot-pause`, `npm run test:bot-handoffs`, `npm run test:bots`, `npm run type-check` and `npm run test:ci:registry`. The registered `real-courier.test.ts` uses real durable sessions, real timers and the faux provider for natural busy completion, shared submission waits, quiescence and tool-task receipt settlement. Courier test teardown joins disposal before removing its profile. Session-service tests cover a real durable tool receipt followed by corrupt-session recovery, collection without inference, and the next send's reset notice, plus deletion effects after a damaged peer marker. Ledger tests launch a fresh process to verify fail-closed replay before marker repair and prior/new purges after repair. Fresh checkouts also need `npm run build:subagent-file-mutator` before the existing runtime file-write test. All inference in these tests uses the faux provider; no live inference or provider/catalog fetch is needed.

## Core Tasks 1–7 file inventory

These files implement the core checkpoint. Tasks 8–11 additionally update desktop projection and transcripts, shared Remote contracts and fixtures, iOS and Android clients, the CLI host, onboarding and their focused tests. The Git diff against the phase base is the complete inventory.

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

Full-A review corrections: phone status notifications use the neutral title "Bot message" when the saved title already equals the body, avoiding a repeated sentence. An id-less Bot change notification also invalidates desktop settings, so a phone's global messaging switch change updates open Settings and Advanced controls. Ordinary session-state changes still refresh only that Bot's summary.
