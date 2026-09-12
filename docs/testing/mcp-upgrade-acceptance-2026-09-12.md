# Native MCP maintenance — implementation and verification

Implements the scoped recommendations from
[the September 12 upstream audit](integrated-upstream-audit-2026-09-12.md).
Base: Aiden 0.40.0 at `a4c85c6d8623e0a69d2834c9a0f07f9329fe1129`.
The user authorized implementation and GPT-6 Astra medium review after the audit.

## Implemented behavior

- Ordinary and interactive HTTP/SSE connections share one Aiden-owned fetch
  policy. Configured service headers attach only to the exact service origin;
  SDK headers win case-insensitively, and redirects fail closed.
- OAuth metadata, registration, and token requests have a 30-second deadline
  covering headers and body. Owner cancellation and generation checks remain
  authoritative. MCP RPCs retain their SDK deadlines, and idle SSE connections
  remain long-lived. The five-minute browser callback window is unchanged.
- Closing a transport aborts its owned requests. SDK `finishAuth` can start a new
  bounded exchange phase after `Client.connect` closes on authorization redirect,
  retaining discovered metadata and the original owner signal.
- Finite decoded response bodies are capped at 8 MiB before SDK materialization.
  Successful, requested SSE streams have the same per-frame limit, including
  chunked/multiline frames and CR/LF variants. Merely advertising SSE cannot
  exempt OAuth JSON or error bodies from a total limit. Stdio explicitly uses
  the SDK's existing buffer-limit facility with an 8 MiB cap. The child MCP
  lane retains its stricter existing raw/normalized limits.
- MCP results retain bounded text and structured evidence in the existing
  `AgentToolResult<null>` text envelope, with a 32,000-character aggregate cap.
  Structured projection limits depth, nodes, fields, keys, and string volume;
  oversized keys are explicitly omitted rather than renamed. Omission metadata
  cannot overwrite real fields. Errors use the same bounded projection.
- Images, audio, and resource blocks receive explicit omission notices. They
  are never silently discarded, serialized as raw base64, or automatically
  fetched. This maintenance change does not add MCP image rendering or new
  attachment, journal, or mobile wire formats.
- Child workspace-read prompt claims now follow actual assembled read tools,
  even when a V2 grant allows more than the inherited tool intersection.
  Intentionally tool-free analysis remains valid and authority is not rewritten.
- The orchestration plan records durable publication, steering consumption,
  descendant drain, interruption, and parent-only projection requirements before
  future background activation. That feature remains unactivated.

No plugin or Pi version bump, provider inventory expansion, model-catalog fetch,
onboarding change, rollout-stage advance, or release publication is part of this
maintenance patch. Existing package-lock pins are unchanged.

## Automated verification

| Check | Result |
| --- | --- |
| `npm ci` | Completed using the existing lockfile |
| `npm run test:mcp` | 53 passed; registered in pretest and preflight |
| `npm run test:config-recovery` | 55 passed |
| Scoped supervisor, child-runtime, request-capability, generation-context, timeline, and Remote protocol tests | 118 passed |
| `npm run test:preflight` | Passed (MCP plus 65 Artificial Analysis, 61 Model Pad, and 230 preflight tests); run before final focused review regressions |
| `npm run test:compaction` | 22 VCC and 279 compaction/runtime tests passed |
| `npm run type-check` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed again after all review fixes and focused regressions |
| Android Chat, RemoteClient, and BotContract unit suites | 52 passed on the bundled Android Studio JDK/SDK |
| Physical iPhone 13 Pro: Chat, RemoteClient, and BotContract XCTest suites | 198 passed, 3 skipped, 3 failed in unchanged iOS source |

The MCP tests use the actual pinned SDK 1.30.0 for HTTP/SSE discovery and token
exchange, plus fake services/credentials. A loopback redirect test verifies that
the destination is never contacted. Other coverage includes header casing and
precedence, Request objects, owner cancellation, stalled headers/body, SDK
metadata carrying protocol headers, same-path token endpoints, long-lived SSE,
cross-chunk frame limits, large multipart/binary results, and structured-key
collisions. No production service credentials were used.

## Astra review and remediation

GPT-6 Astra at medium effort reviewed the actual patch and confirmed three P2
issues in its first pass: MIME-only SSE classification could bypass OAuth JSON
bounds; same-path OAuth endpoints could bypass deadlines; and bounded structured
keys/sentinel properties could collide. Four regressions reproduced those issues
before correction, then passed after correction.

The parent subsequently identified that SDK metadata requests also carry
`MCP-Protocol-Version`. That header-only timeout exemption was removed: an MCP
request must request SSE, or be a JSON POST carrying the protocol header.
Real SDK protected-resource/authorization-server discovery, stalled metadata
body, and ordinary MCP RPC deadline tests cover that distinction.

Final Astra re-review: approved within the source/test review scope, with no
remaining actionable findings. The reviewer independently reran all 53 MCP
tests successfully. This approval includes the final SDK metadata deadline
correction and supersedes the earlier review. It does not claim packaged or
live-provider acceptance.

## Native client inspection and existing failures

MCP output remains private model/tool text. No new Remote payload, media block,
timeline enum, or child-resource field is introduced. The existing Mac Remote
protocol, iOS Chat/Remote/Bot contracts, and Android equivalents were inspected
and exercised; neither native implementation needed a change.

The physical iPhone run used the existing approved `AidenOnTheGo` scheme and
selected only the three relevant suites. The iOS/Android source and shared
fixtures are unchanged relative to the base commit. Three standalone iOS
fixture/client tests failed:

1. `AidenRemoteClientTests.testBotChatToolsNarrowAccessReconcileFilesAndRevokeWithinExactGrant`:
   capability catalog was nil where the fixture expected a catalog.
2. `AidenRemoteClientTests.testChatSummaryDecoderRejectsInvalidActivityOrderingDuplicatesAndBounds`:
   fixture JSON serialization raised `NSInvalidArgumentException` for `__SwiftValue`.
3. `AidenRemoteClientTests.testLegacyChatListFallbackRejectsNestedPrivateChildAliases`:
   an `invalidResponse` escaped the test.

These tests execute unchanged native code with fixture transports, not the
modified Electron MCP path. Their failures are recorded as existing native
acceptance failures, not hidden or counted as passes. The result bundle is
`/tmp/aiden-upgrade-ios/Logs/Test/Test-AidenOnTheGo-2026.09.12_00-40-57--0400.xcresult`.

## Remaining release acceptance

This is a source/build/test-verified maintenance change, not a signed release.
Credential-backed installed HTTP/SSE sign-in and real-server long-running tool
smokes remain release acceptance work. The byte caps intentionally reject
oversized results; users must narrow such server requests. Raw server responses
must not be spilled to disk or fetched from resource links without a separate
approved artifact policy.
