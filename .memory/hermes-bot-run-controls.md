# Hermes Bot run-control upgrade — September 22, 2026

Baseline c8c09e0d2; branch feature/hermes-bot-run-controls. Read all seven Hermes
hub children, verified upstream gateway/run.py. No upstream code copied. PR #205
managed-home remount files excluded. Plan: docs/plans/hermes-bot-run-control-plan.md.

Telegram patch bounds queue and albums, preserves edit ordering, adds explicit
queue/interrupt commands, cancels pre-dispatch/pre-generation work and preserves
canonical Bot identity through /new compaction. Offset persistence gates dispatch;
queue remains memory-only (restart does not preserve pending drafts). Already
committed user input remains history when Stop prevents generation.

Shared foreground Steer is NOT implemented or advertised: Pi's internal queue
needs main-owned user transcript persistence/projection, exact run/request identity,
revocation, capacity and idempotency before public IPC/Remote admission. Owner is
this runtime task; mobile consumer coordination is with task
01a0c7aa-c3ec-7530-8ecc-96f7788c17f1. Later profile/peer/rooms assessment is in plan.

Two Sol medium reviews identified interrupt ack/priority ordering, stale compaction
confirmation, unbound cross-topic controls, polling retry loss, and crash replay
windows. All findings were fixed with targeted regressions. Telegram 227/227, onboarding
55/55, type-check, scoped lint and diff check pass. Hosted CI, PR publication
and live Telegram acceptance remain pending. Upstream source pinned to
836b5f8253d27fee79b4f833bc43624f06a890b3 (gateway/run.py SHA256
acb8e4ed5b675ce49c12ebd1014aa034f746068a4fde23275c29e6e77b29e69c).

PR #216 Pullfrog follow-up: `/continue` carries its Telegram source message ID
and treats post-admission acknowledgment failure as handled. Explicit `/queue`
and `/continue` suppress the generic busy notice so each command produces one
confirmation. Six regressions cover preparing/running and unknown acknowledgment
outcomes with redelivery. Telegram suite: 233 passed; scoped lint passes. This
fix is carried into stacked PR #220 without changing the native input contract.

Command-edit follow-up: classify the duplicate success acknowledgment and
post-dequeue command re-admission as actionable. Explicit edited-message gates
for /queue, /continue and /interrupt now produce unchanged/not-sent receipts,
never a new admission or interrupt. Five regressions cover pending/dequeued
sources. Telegram238 passed, both Sol medium re-reviews clear; plan documents
exact text and unchanged ordinary-prompt edit behavior.

Slice 2 follow-through (2026-09-24, branch feature/on-the-go-midflight-ops):
shared foreground admission is now implemented and advertised as
`chat-run-input-v1` (contract revision 12). `llmClient.admitChatRunInput` is the
single main-owned boundary: Pi queue preflight probe → durable user-message
append (appendChatMessageWithReconciliation; unknown outcomes escalate to
AidenOperationUnknownOutcomeError) → queueSteer/queueFollowUp. Committed-but-
rejected results keep the persisted message and report `committed: true`.
Remote `POST /streams/{streamId}/inputs` is idempotent per request UUID via the
stream service ledger, binds stream→chat→turn→ownerDocumentId, revalidates
bot chat access through runChatMutation, and returns 404 when unwired.
Desktop `chat:admitRunInput` IPC shares the same boundary and owner check.
iOS/Android gained additive DTOs, `supportsChatRunInput`, and client methods;
native Steer/Queue composer UX remains the On The Go slice C work.

Slice 2 review follow-ups: `POST /streams/{id}/cancel` and
`/approvals/{id}/respond` still run stream/approval chat-access checks before
their idempotency actions, so a replayed request after record eviction returns
not_found instead of the recorded outcome. The inputs route solved this by
executing `runAccess` inside the ledger action; apply the same pattern to the
sibling routes in a follow-up. Also fixed in that pass: a prepare-persist
failure previously poisoned the key with a sticky internal_error even though
the action provably never ran — the ledger now discards the unexecuted entry
(`discardUnexecuted`), and the durable gate has a rejection sink for replay
paths that never invoke the wrapper.

On The Go slice C (2026-09-24, same branch): the busy iOS/Android composer now
offers Steer | Queue through the submit affordance alongside the existing Stop
control when `/server.features` contains `chat-run-input-v1` and the composer
holds text; old servers keep Stop-only. Redirect (stop + send-as-new-turn) sits
behind an explicit confirm on both platforms. `AidenRunInputPresentation`
carries the shared decision table: drafts are consumed only for admitted or
committed results (committed-but-rejected means the message already landed in
the transcript — surfaced as a receipt, then reconcileChat pulls it in), every
uncommitted rejection keeps the draft, and a retry of an identical
(streamId, mode, text) submission reuses the original Idempotency-Key so the
Mac replays its recorded outcome. No control write auto-retries.

On The Go slice D (2026-09-25, same branch): pending `ask_user_question`
prompts reach the paired phone through Remote API v1 (contract revision 13).
`GET /streams/{streamId}/question` + `POST /questions/{promptId}/respond`
(feature `chat-question-prompts-v1`, capability `questions:respond`) reuse the
Mac-owned `AskUserQuestionCoordinator`; the remote stream service keeps
per-prompt records (device/stream/chat/renderer-document binding + expiry) and
projects a non-terminal `question_required` event under the existing
`waiting_for_approval` state so legacy clients degrade safely. Remote
generation excludes `ask_user_question` unless the device negotiated the
grant. iOS (`AidenQuestionCard` in `AidenChatFeature.swift`) and Android
(`AidenQuestionCard.kt` + `models/AidenQuestion.kt` strict codec) share one
decision table: stacked option/multi/custom answers, skip = `cancelled: true`,
unaddressed questions sent as skipped, stable per-submission idempotency key,
and reconcile-instead-of-resurrect after an ambiguous write. The
`waiting_for_approval` status is disambiguated by fetching the approval
snapshot first, then the question snapshot, then reconciling when neither
resolves.

On The Go slice E (2026-09-24, same branch): Quiet Open Chat ships client-side
on both platforms — no Remote contract change. `AidenQuietOpenChat` (iOS
Models/AidenChat.swift, Android notifications/AidenQuietOpenChat.kt) is the
shared decision table: while a conversation is foregrounded, ambient progress
kinds (starting/thinking/tool/responding, queued/reconciling/running) are
suppressed for that chat, blocking kinds (waiting-for-approval, failed) still
publish, and terminal kinds (complete/cancelled) clear the surface quietly.
iOS gates Live Activity update churn in AidenChatViewModel
(publishLiveActivityStatus + per-event ambient guards); start/finish/
markStale/endAll/reconcile/approvalRequired stay ungated, and the flag is set
from AidenChatDetailView appear/disappear plus the active application state.
Android gates publishLiveNotification through the same table; the detail
screen's LifecycleEventObserver drives setChatForegrounded on
RESUME/PAUSE/dispose, foregrounding dismisses the posted shade entry, and
SUPPRESS/DISMISS both clear lingering entries so a resolved approval
notification never goes stale. Push pairing (APNs/FCM via Mac-mediated or
sealed relay, mute-safe titles, LA pushType token) is documented as deferred
E.2 in docs/plans/aiden-on-the-go-plan.md; the shipped decision table is the
hook real notifications will reuse.

On The Go slice F (2026-09-24, same branch): cold-open/streaming polish, no
contract change. iOS load() overlaps restoreStreamIfNeeded (status +
approval/question snapshots) with the chat+catalog fetch via async let —
parity with Android's always-independent resumeActiveStreamIfNeeded. Settled
rows are isolated on both platforms: iOS AidenSettledMessageRows tracks only
`chat` (ForEach skips per-token) and AidenMessageView is Equatable on
message+style (attachment-loader closure ignored); Android collects
liveText/reasoning/tools/activityTimeline inside the live_stream item
instead of screen scope and remembers row callbacks + the reversed list so
settled rows skip recomposition. Unread marks and LA freshness chips remain
deferred behind the E.2 push foundation.

On The Go slice G (2026-09-25, same branch): composer power, Mac stays
authority. Contract revision 14 adds `skills:invoke` (progress vocabulary),
feature `chat-skills-v1`, `GET /chats/{chatId}/skills` (≤500 entries of
bounded display metadata + opaque `sk1_` lease; bot chats narrowed by current
bot skill policy), optional `skill` on `POST /chats/{chatId}/turns` redeemed
through the existing `reserveSkillPreparation`/`prepareSkillInvocation`/
handoff path, and error `skill_unavailable`. Skill instructions/paths never
cross the wire; the lease is workspace+registry-revision bound and revalidated
at admission. iOS/Android negotiate `skills:invoke` on the post-pairing
upgrade when the feature is advertised (latent iOS bug fixed: the client's
`updateDeviceCapabilities` allowlist never gained `questionsRespond`, so the
question upgrade silently threw). Both composers parse the trailing `/query`
or `@query` token: `/` lists catalog skills (hidden during a run since stream
inputs carry no lease), `@` lists roster agents (`chatAgents`) plus workspace
files (`botConversationFiles`/`workspaceFiles`); selections insert plain text
or set the pending lease, sent via `AidenTurnRequestBuilder`. Subagent
interrupt stays deferred: Remote deliberately never advertises child-run
control, so mobile remains inspect-only.

Slice G review fixes (2026-09-25, same branch, 34a538af): the SWE2 review
of 171629fb found three P1s plus P2s, all fixed. (1) Android
`updateDeviceCapabilities` progress allowlist gained `SKILLS_INVOKE` — without
it the negotiated grant was contract-invalid and never persisted (regression
test added). (2) Remote `startTurn` now consumes attachments and reserves
append/skill capacity inside the protected try so failures release the turn
lease and mark the stream error; reservation failures map to `rate_limited`
429 retryable, and the catch releases unconditionally (release() is a no-op
post-handoff). The `!started && !accepted` path also releases. (3) Empty
skill `description` is valid wire data — the host projection emits "" for
description-less skills, so all three strict parsers gained `allowEmpty` for
that field only, and the shared fixture carries a third `triage` entry with
`description: ""` pinning the behavior on every platform. P2s: skill-catalog
registry failures map through `skillInvocationRemoteError`; the remote skill
path admits `workspaceMutationGate` exactly like the desktop handler (abort
releases the turn; `isCurrent` folds `!admission.signal.aborted`); lease-dead
skill methods in `chat-turn-admission.ts` throw
`SkillInvocationError("turn_unavailable")` so they map to 429 instead of 500;
Android composer whitespace now pins the Unicode White_Space property
explicitly (Kotlin `Char.isWhitespace` diverges on NEL/figure-space/
information-separator edge cases) matching iOS `Character.isWhitespace`.
Verification: remote suite 468+1skip, LAN 7/7, peers 17/17, tsc clean, iOS
app+test bundle build green; Android reviewed manually (no local JVM).

PR #251 CI + review loop (2026-09-25, same branch): first PR run failed on
a missing ci-test-registry lane entry (chat-run-input-admission.test.ts →
core-git), an Android mock predating the questions/skills progress grants,
a malformed entryJson helper (trailing comma → JsonDecodingException), an
inverted U+2007 expectation (figure space IS Unicode White_Space on both
platforms; 0x1C-0x1F are the Kotlin-divergent rejects), and the reviewed
product-shell rule rejecting `sparkles` SF Symbols in iOS chat sources —
skill icons use `slash.circle`. Hermes bot then flagged two real defects:
(1) POST /questions/{id}/respond resolved questionChatId before the
idempotency ledger, so a replay after commit hit question_expired instead
of replaying the settled response — respondQuestion now takes the router's
runAccess closure (runChatMutation) inside executeIdempotent, matching the
submitInput idiom, and questionChatId left the router Pick; (2) submitInput
emitted status running on every admitted input, clobbering
waiting_for_approval while a prompt was pending — the running append is now
gated on no pending approval/question. respondApproval on main shares the
pre-ledger lookup shape; flagged as follow-up, out of this branch's diff.
Verification: remote suite 469+1skip, LAN 7/7, peers 17/17, tsc clean,
CI run 36180567552 fully green before these review fixes.

PR #251 round 2 review loop (2026-09-25): Hermes's second pass on 1df84eeb
found two more defects — AidenSettledMessageRows equated on the ViewModel
pointer (===) so settled rows never re-rendered, and the iOS suggestion
list's isDisabled dropped `return` inside `if case` so unavailable skills
were never disabled. After fixing those (ee6da4c1), pullfrog caught that
comparing model.chat in == still reads the same live reference on both
sides — AidenSettledMessageRows now takes chat: AidenChat as a value
snapshot (9997383e). Hermes's pass on c07287f6 (assistant chats now return
{"skills":[]} instead of 409 from the registry) reported no findings; all
17 PR checks green on c07287f6.
