# iOS SSE disconnect framing — upgrade campaign 2026-09-19

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb` (`origin/main`). Branch: `feature/upgrade-ios`.

## Finding and decision

`AidenRemoteClient.eventStream` decoded the unfinished last line and called `AidenSSEParser.finish()` when the response ended. `finish()` dispatched a pending frame even without its blank-line terminator. A disconnect after a complete JSON line could therefore apply a text delta or terminal event and advance the durable cursor before the complete transport frame had arrived; truncated JSON or UTF-8 could incorrectly surface as invalid content instead of a recoverable disconnect.

Only blank-line-terminated frames should reach subscribers. Drop the unfinished line/frame at EOF and let the existing read-only status/replay loop recover from the last delivered sequence. Do not resend turn creation or change shared wire contracts, state reconciliation, onboarding, or UI.

## Source learning

- OpenCode v2 at `7a6ce05d0939826aa6c8e1c481489a713b2d633f`: `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts` retains unfinished frame bytes and dispatches complete chunks; `packages/app/src/context/global-sdk.tsx` separates connection recovery from semantic event handling. MIT reference, no source copied.
- Waku at `6d433e875d57091906ec0770d8bb9ffc9aa29b83`: `src/driver/opencode.rs` scopes session events and separates accepted prompts from event transport lifetime. GPL-3.0 source studied only; no source adapted or copied.
- WHATWG SSE interpretation: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation requires discarding pending data at EOF without a final empty line.

## Scope and verification

- PR #119 was inspected and addresses stale test assumptions/Live Activity tests, not stream framing. New assertions use a distinct location in the existing registered remote-client XCTest file.
- Android's `AidenSSEParser.finish()`/`parseStream()` has the same EOF flush. Reported to campaign coordinator for the Android owner; this PR remains iOS-only.
- Final generic iOS `build-for-testing` passed with Xcode 27 beta (`27A5194q`) and signing disabled (compile evidence only), including both added XCTest methods. Command: `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild build-for-testing -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination generic/platform=iOS -derivedDataPath /tmp/aiden-upgrade-ios-derived CODE_SIGNING_ALLOWED=NO`.
- `npm run test:ios-release`: passed (31 Node tests plus 20 Ruby tests / 42 assertions).
- The temporary macOS Swift framing probe uses the production parser/decoder/models and the verbatim transport byte loop extracted from `AidenRemoteClient.swift`. Baseline fails with `EOF emitted incomplete frame`; fixed source passes 14 LF/CRLF truncation/replay/complete-terminal cases. This is a transport framing experiment, not an iOS XCTest or URLSession/device acceptance result.
- Added two XCTest methods in the existing registered `AidenRemoteClientTests.swift`: a 12-case interrupted-tail/replay matrix and a 2-case complete-terminal preservation matrix. Both LF and CRLF are covered, including truncated UTF-8, partial headers/JSON, and terminal frames.
- Physical XCTest was attempted against the available paired iPhone 16 Pro Max using Xcode 27 beta (`DEVELOPER_DIR` per command). The first attempt timed out in device preparation; a bounded retry reported missing compatible DeviceSupport symbols and was stopped while preparation remained stuck. No XCTest executed on hardware; no simulator was used. This remains an acceptance gate.
- JavaScript type-check/lint are not applicable to this Swift-only product/test change. Generic iOS app/test compilation is the native type check. New tests are in the existing Xcode-registered file, so no test-script registration change is required.
- `git diff --check`: passed. Existing `.papercuts/troubleshooting.md` history preserved with append-only entries.

This corrects existing transport behavior and adds no durable capability, setup step, or design change. Existing plan status and onboarding remain applicable.
