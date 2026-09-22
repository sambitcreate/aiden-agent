# Android SSE EOF handling — upgrade lane 16

At baseline `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`, `AidenSSEParser.finish()` decoded a frame at EOF without a terminating blank line. Both parent and chat-progress streams could emit that incomplete event, allowing replay/state to advance.

`finish()` now clears pending fields and returns null. Only an empty line passed to `consume()` dispatches an event. The API and HTTP lifecycle stay unchanged. iOS has the same baseline deficiency; campaign lane 13 owns its independent correction. Lane 14 owns Android HTTP cancellation/body consumption; it confirmed these fixture edits do not overlap PR #152.

Source lesson: OpenCode v2 `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts` at `7a6ce05d0939826aa6c8e1c481489a713b2d633f` processes only complete blank-line-delimited chunks. Studied read-only at `/Users/sambitbiswas/projects/opp/opencode-v2-aiden-study`; MIT license inspected, no code copied. WHATWG HTML section 9.2.6 explicitly discards pending event data at EOF: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation.

Validation: five new parser regressions failed before the fix. After the fix, 43 focused Android unit tests passed (19 progress/parser, 24 RemoteClient), as did `:app:lintDebug`. Coverage includes LF/CRLF/CR, missing delimiter, parser reset, partial headers/JSON, replay cursor preservation, progress snapshots, and an unterminated terminal event through MockWebServer. Four existing fixtures in three tests now explicitly end with a blank line. Tests extend existing Gradle-discovered test classes; no registration needed.

Command: `JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ANDROID_HOME='/Users/sambitbiswas/Library/Android/sdk' ./gradlew :app:testDebugUnitTest --tests sbtbiswas.AidenOnTheGo.AidenChatProgressTest --tests sbtbiswas.AidenOnTheGo.AidenRemoteClientTest :app:lintDebug --max-workers=2 --console=plain` (from android).

No UI, shared protocol, onboarding, or plan-status change. No emulator/device run; no TypeScript changes. Hosted CI and central Luna/Pullfrog review are tracked in the campaign status JSON and PR; local checks are not hosted success. No merge or release authorized.
