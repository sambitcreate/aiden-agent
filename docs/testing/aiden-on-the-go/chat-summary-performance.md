# Aiden On The Go — chat-summary performance evidence

Date: 2026-09-01
Status: Automated implementation gates complete; physical-device acceptance remains open.

## Scope

Phase 2 adds the advertised `chat-summaries-v1` capability and the additive
`GET /api/aiden/v1/chat-summaries` route. The server projects bounded pages from
the main-owned metadata index and activity registry. It does not open transcript,
attachment, timeline, reasoning, or message files. Full chat detail remains on
`GET /api/aiden/v1/chats/{id}`.

Native clients prefer summaries only when the paired Mac advertises the feature.
They fall back to the legacy full-chat list only when the feature is absent; an
error from an advertised summary endpoint is surfaced instead of silently
downgrading.

## Deterministic fixtures

All data is synthetic and contains no private chat content.

| Fixture | Chats | Messages/chat | Purpose |
| --- | ---: | ---: | --- |
| Small | 50 | 10 | Normal installation |
| Medium | 250 | 50 | Heavy user |
| Large | 1,000 | 100 | Stress case |
| Pathological | 2,000 | Mixed, including maximum-size messages | Bounds and failure behavior |

TypeScript, Swift, and Kotlin tests construct this matrix. The canonical wire
fixture in `protocol/aiden-remote/v1/fixtures/contract.json` is also decoded by
all three implementations.

## Server benchmark

The focused Node test measures one bounded page (maximum 200 rows). Full-history
bytes are calculated from the exact deterministic wire projection so the
pathological fixture does not need to allocate more than a terabyte of synthetic
text. Heap deltas are retained-heap observations from one run and are diagnostic,
not stable acceptance thresholds.

| Fixture | Full `/chats` bytes | Summary-page bytes | Projection | JSON decode | Retained heap delta | Transcript opens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 91,361 | 12,565 | 2.964 ms | 0.049 ms | 4,864,488 B | 0 |
| Medium | 4,446,761 | 50,394 | 9.947 ms | 0.191 ms | 3,282,680 B | 0 |
| Large | 112,137,011 | 50,394 | 13.166 ms | 0.138 ms | 4,675,584 B | 0 |
| Pathological | 1,332,707,874,676 | 50,394 | 13.898 ms | 0.130 ms | 7,078,200 B | 0 |

Command:

```sh
npm run test:aiden-remote-chat-summaries
```

## Native decode benchmarks

Android's JVM benchmark uses Kotlin serialization, warms each path twice, then
records the best of three runs for the medium fixture. Thread allocation values
are recorded when supported by the runtime. Its installation cache uses atomic,
content-addressed 200-summary chunks, performs disk work on `Dispatchers.IO`,
reuses verified prefixes during pagination, and keeps manifest-last failure
recovery bounded. The Swift cache is actor-isolated, atomic, and bounded to
10,000 items/80 MiB; both clients publish pagination state only after the cache
commit succeeds.

| Android path | Elapsed | Allocated |
| --- | ---: | ---: |
| Full chat list | 14,616,250 ns | 32,383,248 B |
| First summary page | 344,250 ns | 481,608 B |
| All summary pages | 940,000 ns | 1,204,080 B |
| Cached summary hydration | 1,413,459 ns | 1,441,696 B |

The Swift XCTest harness covers the same four paths with `JSONDecoder`,
`XCTClockMetric`, and `XCTMemoryMetric`. It compiles in generic-device
`build-for-testing`, but no iOS runtime metrics are recorded here: deployment to
the connected device stopped before test execution because the local profile
does not contain the `group.sbtbiswas.AidenOnTheGo` App Group entitlement.
No simulator was used.

Commands:

```sh
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:compileDebugAndroidTestKotlin --stacktrace

cd ..
xcodebuild build-for-testing \
  -project ios/AidenOnTheGo.xcodeproj \
  -scheme AidenOnTheGo \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO
```

After installing a provisioning profile with the App Group entitlement, run the
focused iOS benchmark on a connected device:

```sh
xcodebuild test \
  -project ios/AidenOnTheGo.xcodeproj \
  -scheme AidenOnTheGo \
  -destination 'platform=iOS,id=<DEVICE_UDID>' \
  -only-testing:AidenOnTheGoTests/AidenChatSummaryPerformanceTests
```

## Physical-device acceptance checklist

Record device model, OS version, build SHA, and at least three observations for
each item. Do not capture prompts, titles, paths, attachments, or credentials.

- Measure cold home-load duration and peak memory on a representative iPhone or
  iPad and Android device.
- Confirm scrolling and local search remain responsive on the large fixture.
- Traverse every summary page and confirm there are no duplicates or omissions.
- Open a summary and confirm only that selected chat fetches full detail.
- Exercise create, rename, delete, move, and live activity reconciliation.
- Pair new mobile builds with an older Mac and confirm legacy fallback.
- Pair older mobile builds with the new Mac and confirm `/chats` remains usable.
- Retry malformed, forged, expired, and stale cursors and confirm bounded errors.

Physical-device profiling is the remaining release-acceptance gate; the missing
iOS entitlement and the absence of an attached Android device are environment
constraints rather than automated test passes.
