# Native stream recovery — 2026-09-22

Baseline: origin/main `c8c09e0d2` (freshly fetched; starting coordinator checkout was stale). Branch `feature/mobile-stream-recovery`. PR #119 was inspected: it owns unrelated Phase 6 test assumptions/Live Activity acceptance and was not modified.

## Verified source and decisions

Read the Notion Hermex→Aiden iOS study `3e280314a1c481e7ad47cbd668968a42` (edited 2026-09-21); it has no linked child pages relevant to this slice. Verified upstream `uzairansaruzi/hermex` HEAD `aa7830b28a071769c2d26bc08949e38e09f4b388` and inspected commits `a6aaf599c` (#314), `057c67a37` (#323), `0f0c686d5` (#325), `0264674a6` (#585), plus late-event/replay/no-op/optimistic fixes `ce91156`, `ebb376b`, `cf0e59c`, `4fa0b31`. Conceptual adaptation only; no upstream source copied. Aiden keeps REST + SSE and its own sequence/identity contracts.

Aiden already retries transport/status failures and ignores incomplete SSE frames. There is no Hermex-style full-buffer replay reconstruction on its normal path, so no extra replay buffering was introduced.

## Implementation

- Both native clients persist the accepted stream identity, but keep advancing sequence cursors with their process-local partial text/reasoning/tool buffers. A cold view reconstructs from sequence zero, including legacy cache records with a nonzero cursor. Warm reconnect stays at the last applied sequence. This removes one disk write per event; no journal/cursor schema migration is needed.
- iOS repeated load does not replace the existing stream consumer with its stale disk cursor. Send generations fence cache/network reloads and title reads; reloads during pending POST are skipped so optimistic messages survive. Title refresh restarts after send settles with task-owned cleanup.
- Android ends event consumption at terminal even when authoritative transcript reconciliation fails. Both clients retain active ownership and disable Send until replay/reconciliation completes. Android explicitly publishes that ownership for Compose recomposition; iOS observes it. Successful terminal cleanup clears ephemeral buffers.
- Recovery warnings clear on healthy stream/status or transcript reads without clearing a different composer/control error. Stale Android load failures are fenced like successful results. Conditional stream-file deletion preserves a newer record; absence of a file does not keep a successfully reconciled iOS owner alive.
- No wire shape, provider configuration, durable feature, visual styling, or onboarding change. Existing feature tour remains accurate. Bot controls and workspace browsing belong to other program peers.

## Validation

- New Android transport regression uses production ViewModel/client and MockWebServer: old cached cursor 27 → cold request zero → warm request one, full prefix restored, late frame after done ignored while transcript fetch fails, retained identity unchanged, no turn POST replay, Send blocked through settlement.
- Three existing failed-send cases now force reload while POST is held and verify optimistic survival. Original main ViewModel fails all four enhanced regressions (three lost optimistic messages, cold replay timeout); fixed focused suite passes.
- Full Android JVM suite: 177 passed, zero failed/skipped. `lintDebug` and `compileDebugAndroidTestKotlin` also pass.
- Six XCTest additions in the existing registered AidenChatTests.swift exercise cold/warm replay and unchanged persistence, terminal send gating and cleanup, optimistic reload survival, and Stop against a live recovered stream.
- Xcode 27 beta generic iOS build-for-testing passes with signing disabled; this compiles XCTest, does not execute it. `npm run test:ios-release` passes (31 Node tests, 20 Ruby tests / 42 assertions).
- Physical XCTest blocked: coordinator's immediately prior device run reported `com.apple.dt.deviceprep Code=-3: Unlock Sambit’s iPhone to Continue` for iPhone 13 Pro `00008110-00063CD91E98801E`. No repeated blocked run, simulator, or unlock bypass attempted. Device acceptance remains pending.
- Separate GPT-5.6 Sol medium blast-radius and adversarial reviews were performed after implementation. Fixed findings: accidentally broadened Stop guard (restored), stale error publication, title retry loss, warning ownership, and Send during terminal replay. Both final reviews report no remaining actionable findings.

Local logs: `/tmp/aiden-mobile-recovery-baseline.log`, `/tmp/aiden-mobile-recovery-android.log`, `/tmp/aiden-mobile-recovery-build.log`, `/tmp/aiden-mobile-recovery-ios-release.log`. Hosted checks/review status must be checked independently after publication; no merge/release/deploy authorized.

## PR #217 held-I/O follow-up

The initial head `0ad94f43` passed every hosted check, but Pullfrog correctly found three ownership windows. All are fixed before resolving review:

1. iOS load reserves observable recovery admission before any cache/draft/status await, restores local draft text immediately, then runs the status recovery probe alongside transcript/catalog reads. Send cannot replace a cached stream while its status is pending.
2. iOS cache writes may yield; `acceptRemoteChat` captures and rechecks transcript generation/current context after persistence before `onChatUpdated`, and returns whether acceptance remained owned. An authoritative reconciliation invalidates earlier reads before its own cache-write await. The cache actor serializes synchronous atomic writes, but this alone does not order queued callers; the subsequent mailbox-fence follow-up below supplies that authority.
3. Native transcript generations advance at terminal reconciliation entry, retry, and settlement, rejecting old HTTP reads that return after the final transcript was installed. These guards gate only transcript acceptance/error publication, so drafts/catalog/progress still initialize during fast terminal recovery.

Deterministic barriers cover a held status probe with visible saved draft and disabled Send, an iOS cache write crossing a held turn POST with no stale parent callback, and an old transcript GET held through terminal settlement in both clients. The iOS fixture explicitly prevents terminal frames until the intended stale GET is held. Its test also asserts saved draft/catalog/progress setup. Android's new held-load test fails against `0ad94f43` (old empty transcript overwrites final), then all 177 JVM tests plus lint/instrumentation compilation pass with the fix. Generic iOS XCTest compilation passes again. Both independent Sol medium reviewers re-reviewed the follow-up clear.

A supported read-only `devicectl device info lockState` confirms the physical iPhone still reports `passcodeRequired: true` (already unlocked since boot). Physical XCTest remains unexecuted. Greptile review is externally unavailable because the account reached its 50-credit trial limit. New-head hosted CI/review follow-through remains required.

## PR #217 accepted cache-write ordering follow-up

Pullfrog correctly identified that Swift actor isolation does not guarantee FIFO mailbox scheduling. Every production detailed-transcript writer now reserves a cache-wide monotonic token synchronously at snapshot acceptance before its first cache/retained-data await. The cache actor checks a per-installation/per-chat high-water mark before disk mutation, advancing it even on disk failure; remove and purge invalidate older reservations. A cache-owned clock avoids collisions across recreated ViewModels. Workspace persistence skips companion list/summary writes when its detailed write is rejected.

The terminal-settlement XCTest now deliberately delivers an already-reserved stale snapshot after real stream settlement, then opens a new cache actor to verify final data from disk. A focused cache regression covers deletion, recreated same-chat writes, delayed stale delivery, installation isolation, purge, and a new post-purge writer. Generic iOS build-for-testing and iOS release checks pass; Android's 177 JVM tests, lint and instrumentation compilation remain green. Physical XCTest is still unexecuted due to the coordinated device lock limitation. Both independent Sol medium reviewers reviewed the final narrowed diff with no introduced actionable findings.

Scope: tokens order accepted persistence operations, not server response versions. Review also surfaced pre-existing cross-owner delayed HTTP response/list cache ownership races. Those were reported to the program coordinator separately; this patch preserves existing rename/create/Bot navigation behavior and does not claim to fix those broader races. Latest-head hosted CI is required after push.

## PR217 caller rejection follow-up

New Pullfrog threads PRRT_kwDOTctvDc6kuUVB/4071577964 and PRRT_kwDOTctvDc6kuUVG/4071577973 require propagating normal false cache-write results to every caller. Local implementation now gates detail mutation/publication, workspace mutation callbacks, Bot presentation, and accepted-turn companion state. A superseded accepted server receipt is rebased on the winning cached snapshot with a new token reserved before reading it; no second GET or POST is required, and only a newly accepted write may save the stream/start its consumer. Deletion with no current chat stays authoritative. Bot navigation uses a newer admitted snapshot or clears the current removed-chat path. Workspace callbacks use admitted snapshots, with explicit per-chat presentation ownership so unrelated rows or stale list absence do not cancel successful create/rename operations.

Eight new caller-focused XCTest methods use an asynchronous cache-write test barrier to exercise deletion, newer-write supersession, receipt recovery while subsequent GET fails, workspace create/rename with newer or removed rows, unrelated/empty list updates, and shared Bot presentation admission. These are in the existing registered XCTest file. Both independent Sol medium reviewers completed final scoped re-review with no remaining actionable findings.

After the user restored full access, generic iOS build-for-testing passed, including all new XCTest compilation. Android JVM tests, lint and instrumentation compilation passed. iOS policy checks passed (31 Node, 20 Ruby/42 assertions). Physical XCTest remains unexecuted pending the coordinated unlocked-device slot. Logs: /tmp/aiden-mobile-recovery-rejection-build.log, /tmp/aiden-mobile-recovery-rejection-android.log, /tmp/aiden-mobile-recovery-rejection-ios-release.log. The earlier sandbox blocked cache writes, Git staging and task messaging; those environment restrictions were resolved by the user before publication. No permission bypass was attempted.

Broader response/list follow-up remains owned in .memory/mobile-response-ownership.md. Latest-head hosted CI and review follow-through remain required after publication.

## PR217 stream companion and parent removal follow-up

Pullfrog4072568286 identified deletion after a successful detailed write but before the separate stream write. The accepted chat token now also gates the stream companion, using lock-backed per-chat removal and installation purge floors that do not invalidate server receipts merely because a newer transcript was written. The cache checks after the deterministic stream-write barrier and before synchronous disk I/O. Send rechecks the same authority after draft/activity awaits and immediately before consumer startup; a raced Activity start is cancelled for that exact stream only. No prompt POST is replayed.

Pullfrog4072568298 identified missing parent/sidebar removal propagation. A no-winner rejected workspace write now calls onChatRemoved only when its context and same-chat presentation generation remain current. The child row and parent callback are tested, including a newer local owner that must remain untouched.

Three added XCTest methods cover successful detail write followed by held stream write/deletion, stream authority under newer writes/removal/purge/instance isolation, and parent removal supersession. Existing removal coverage now asserts the parent callback. Generic iOS build-for-testing passes; Android177 JVM/lint/instrumentation compilation and iOS policy31Node+20Ruby42 assertions pass. Both independent Sol medium final reviews clear. Physical XCTest still unexecuted pending the coordinated unlocked device. Logs: /tmp/aiden-mobile-companion-build.log, /tmp/aiden-mobile-companion-android.log, /tmp/aiden-mobile-companion-policy.log. New-head CI/review follow-through still required.

## PR217 deletion lifetime and offline list follow-up

Pullfrog4072962275 correctly identified the last check/startup gap. Cache deletion and detail consumer admission now share the main actor: remove/purge synchronously invalidate weakly registered detail lifetimes and cancel their stream, reconciliation, title and progress work before awaiting private actor disk cleanup. Lifetimes register at model creation, so a held turn POST or cold restoration cannot revive the removed detail. Publication and Stop continuations honor that lifetime. Pending deletion scopes block cache admission/reads until every overlapping cleanup finishes. Existing successful fresh-token re-admission remains supported; cross-owner stale HTTP response provenance remains assigned separately.

Pullfrog4072962283 is addressed at cache removal: all matching workspace list envelopes are rewritten without the removed identity, and delayed list saves filter removed IDs. Tombstones clear only after a successful fresh detailed write; a failed write cannot silently permit stale offline rows. This avoids replaying a stale child-model list over a newer owner.

Four new XCTest methods cover removal after the final retention check/before startup, held POST completion, an admitted consumer with held events, and failed detail re-admission followed by stale list save and disk reopen. Workspace mutation rejection coverage now seeds and reopens the list cache. Both independent GPT-5.6 Sol medium reviewers are clear after fixing Stop's post-await guard and failed-write tombstone retention. Generic iOS build-for-testing passes (XCTest compiled, not executed), Android177 JVM/lint/instrumentation compilation passes, and iOS policy31Node+20Ruby42 assertions pass. Logs: /tmp/aiden-mobile-lifetime-build-confirm.log (TEST BUILD SUCCEEDED), /tmp/aiden-mobile-lifetime-build.log, /tmp/aiden-mobile-lifetime-android.log, /tmp/aiden-mobile-lifetime-policy.log. Physical acceptance remains pending the coordinated unlocked-device slot. Latest-head hosted CI/review still required.
