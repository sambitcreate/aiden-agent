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

## Remaining physical acceptance

No Android device was attached during implementation. Connected Compose instrumentation and manual phone/tablet checks remain open. Compilation/JVM tests are not physical UI evidence.

Complete the manual matrix on both native platforms: desktop- and phone-started Workspace/Bot turns, both chips together, long labels/large text, keyboard and attachments, approvals/stop/scroll-to-latest, sheets and earlier turns, dark/light appearance, screen readers, reduced motion, background/foreground, reconnect/restart, switching Macs/chats, and revocation. iOS testing must use an explicitly selected physical device; simulators are prohibited by `ios/AGENTS.md`.
