# Mobile task progress and agent visibility

Date: 2026-09-14
Branch: `feature/mobile-task-progress-subagents`
Status: Implementation and automated validation complete; physical UI acceptance remains open. The plan remains active until the outstanding acceptance checks pass.

## Delivered behavior

Eligible Workspace and Bot conversations share task progress and agent inspection on desktop, iOS/iPadOS, and Android. Mobile task counts come from the durable todo journal, independently of parent tool activity. Bot task tracking requires the effective `tasks` capability; delegation retains its existing `subagents` policy and Bot nesting prohibition.

Revision 11 negotiates `tasks:read` and `agents:read` separately from server support. Existing pairings upgrade through `/device/capabilities` only after feature advertisement. Older pairing request shapes remain usable. Reads and the dedicated chat-scoped event channel revalidate current device grants and retained chat/Bot access. Progress never grants access to another device's turn stream or cancellation endpoint.

Every progress subscription receives fresh authoritative snapshots. Snapshot epochs/revisions and observation tickets fence late reads and reconnects. Live todos publish only after durability. Foreground agent rows use allowlisted display fields and public per-Mac/chat identities; raw child instructions, results, and private run identifiers are omitted. Other retained agent-bearing turns are discoverable after reopening the chat. Transport loss preserves last-known state and never reports success.

Native surfaces include task progress, grouped Working/Needs attention/Finished agent lists, bounded details, and earlier-session selection. They reuse existing conversation/composer paths. Agent mutation controls, skill autocomplete, and changes to existing Files/Git screens are outside this increment.

## Automated validation

- `npm run test:todo`: 92 passing.
- `npm run test:bots`: 440 passing.
- `npm run test:subagents`: all constituent suites passed.
- `npm run test:onboarding`: 51 passing; existing subagent tour artwork is reused.
- `npm run test:aiden-remote`: peer-host tests 17 passing; Remote tests 402 passing with one expected skip; LAN transport tests 7 passing.
- `npm run type-check`, `npm run lint`, and `npm run build`: passed.
- React Doctor changed-file scan: 88/100, no errors; two array-lookup warnings in bounded protocol vocabulary/fixture validation were reviewed and do not warrant changing the small-list checks.
- Focused progress tests cover durability, stale reads, restart recovery, safe projection, separate Mac identities, retained turns, invalid-state recovery, grant-filtered SSE, revocation/disconnect, and socket backpressure.

- Final focused shared protocol/progress/pairing/router/state run: 112 passing after the last review fixes.
- Android: `:app:testDebugUnitTest` passed all 153 tests; `:app:assembleDebug` and `:app:assembleDebugAndroidTest` succeeded using Android Studio's JBR and the local Android SDK. The instrumentation APK compiles; it was not executed without a device.
- iOS: full `AidenOnTheGoTests` run on the explicitly selected physical iPhone 13 Pro (`00008110-00063CD91E98801E`, iOS 27.0) passed: 354 passed, 6 skipped, 0 failed. Command: `xcodebuild test -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'platform=iOS,id=00008110-00063CD91E98801E' -derivedDataPath /tmp/aiden-mobile-progress-ios -resultBundlePath /tmp/aiden-mobile-progress-ios-tests-final.xcresult -only-testing:AidenOnTheGoTests`. Result bundle verified with `xcresulttool get test-results summary`; no simulator was used.

## Independent review

Three GPT-5.6 Luna/max agents implemented/reviewed the shared protocol, iOS, and Android slices. A separate source-and-test review checked the backend and both native consumers. Corrections include idle-read revision fences, parent/progress event separation, foreground lifecycle, post-negotiation context checks, historical-selection races, access-loss clearing (including partial grants), and passing only supported progress grants to the event service. Final review reported no remaining verified P0/P1 findings in these paths.

The first full physical iPhone run exposed stale test assumptions. Follow-up test-only corrections account for the new server feature list, scoped Bot catalog storage, the client's public error wrapper, JSON serialization of reversed collections, a valid avatar revision to reach the intended diagnostic check, and Unicode whitespace in iOS 27 date formatting.

## PR #123 review follow-up

Pullfrog's review was addressed with generation-fenced observer cleanup on iOS, atomic persistence of negotiated grants and freshly confirmed server support, surrogate-safe agent text projection, and exclusion of the current Android turn from earlier-session options. Regression tests exercise observer exit/restart, late cancellation, reloading two paired Macs before/after a failed capability refresh, failed persistence rollback, Unicode boundaries, and duplicate turn presentation. The existing iOS source allowlist and fixture-load signature check were updated to match the reviewed progress source and API, resolving the initial CI failures.

Follow-up validation: full `npm test` passed; `npm run test:ios-release`, lint, and type-check passed; focused progress tests passed (16 tests). Full physical iPhone 13 Pro XCTest passed with 357 passed, 6 skipped, and 0 failures (`/tmp/aiden-pullfrog-ios-final.xcresult`). Android JVM tests and instrumentation APK build passed; the locale/timezone-safe presentation regression compiles. Android connected instrumentation remains unrun without a device.

## Hardening review round

A second review round (8 headless SWE-1.7 plus 4 SWE-2 reviewers, two per phase) produced no P0 findings. Fixed P1/P2 findings: progress event payloads now bind `chatId` to the chat-scoped `streamId` on the server, iOS, and Android; Android requires the contract `terminal` bit and narrows persisted device grants when the server withdraws them; Android rejects capability responses that drop non-progress grants; historical roster fetches are epoch/revision-fenced before replacing selection; iOS and Android terminal agent icons no longer imply success or active work; unavailable projections keep reachable affordances so their reason and retained history remain inspectable; iOS earlier-turn labels no longer leak opaque IDs; stale-state tracking is per-surface; iOS validates `turnId` query grammar; OpenAPI encodes the active-state agent restrictions, required `features`, version bounds, `chatId` patterns, and additive `deviceName` support; private child-projection detection covers transcript/session vocabularies.

Reviewed and dismissed: the `after` cursor's lack of a durable replay journal is documented contract behavior (every connection hydrates fresh snapshots); Bot progress reads intentionally preserve retained durable state for desktop parity — the `botTaskTrackingAllowed` production gate and `authorizeRetainedBotChat` read authorization remain authoritative; Android `previousTurns` ordering already accepts equal timestamps like the server and iOS.

Added regression coverage: Bot progress-read authorization at the router, private-field mutation on progress roots, progress `chatId`/`streamId` binding on all three implementations, Android grant narrowing and non-progress grant preservation, missing `terminal` fail-closed, equal-timestamp and wrong-order `previousTurns`, progress fencing and roster-key boundary tests, empty `accepts` rejection, and `turnId` grammar rejection.

A final confirmation round on the fix diff (two independent reviewers) found and fixed: roster `turnId`/`previousTurns` now echo the protocol-issued `turn_<uuid>` for remote-created turns via a durable `turnIndex` in the stream snapshot that survives stream pruning, restart, and issuing-device revocation (other generations keep a stable minted identity); the production per-read authorizer was extracted into `createChatProgressAuthorizer` with direct tests for revocation, negotiated grants, Assistant-workspace and Bot boundaries, and generation fencing; milestone kinds are deduped before projection (the journal only skips consecutive duplicates) and closed `projectionNotices` are mapped to contract `notices`; iOS no longer renders raw `error`/`warnings` strings (Android parity — decoded for tolerance, never displayed); `ChatAgentRoster.turnId` gained the public-identifier pattern.

Reviewed and dismissed: the claimed revocation-fence gap is not exploitable — every snapshot read is re-authorized after the private read and before returning, and SSE writes run in the same microtask as the authorized read, so a revoked device can never receive post-revocation data; the final `acquireDeviceAuthorization` call in the authorizer is a deliberate post-read revocation recheck, not a redundant call.

Validation after this round: `npm run test:aiden-remote` 417 passing with 1 expected skip (including new `turnIdFor` prune/restart, minted-fallback round-trip, milestone-dedupe/notices, and authorizer suites); type-check clean; Android `:app:testDebugUnitTest` all tests green; iOS `AidenOnTheGoTests` passed on the physical iPhone 13 Pro (360 tests, 0 failures) and a clean device build succeeded.

## Remaining physical acceptance

No Android device was attached during implementation. Connected Compose instrumentation and manual phone/tablet checks remain open. Compilation/JVM tests are not physical UI evidence.

Complete the manual matrix on both native platforms: desktop- and phone-started Workspace/Bot turns, both chips together, long labels/large text, keyboard and attachments, approvals/stop/scroll-to-latest, sheets and earlier turns, dark/light appearance, screen readers, reduced motion, background/foreground, reconnect/restart, switching Macs/chats, and revocation. iOS testing must use an explicitly selected physical device; simulators are prohibited by `ios/AGENTS.md`.
