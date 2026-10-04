# iOS streaming performance (EXT-9..21)

Branch `perf/ios-streaming`. iOS-only; no Remote protocol, fixture, or persisted-format change. Behavioral coverage lives in `ios/AidenOnTheGoTests/AidenStreamingPerformanceTests.swift` plus focused additions in `AidenChatTests` and `AidenRemoteClientTests`.

- EXT-9: `AidenLatestValueThrottle` (LiveActivities/) coalesces Live Activity content to the newest value at most once per second. Status, approval, stale, finish, and end paths are urgent and bypass or cancel the pending write.
- EXT-10: `AidenMarkdownContentCache` (Features/Remote/) splits Markdown only at safe blank-line block boundaries and caches parsed settled chunks in a bounded LRU (512 entries / 400k UTF-8 bytes). Only the open tail is reparsed. Splitting is disabled for link/footnote definitions and blank-line-spanning HTML. Oracle: for every prefix of the fixtures, the chunked result equals `MarkdownContent(prefix)`. `AidenLiveResponseView` evaluates its projections once per render.
- EXT-12/17: the chat open takes a single progress snapshot that observation reuses. Reconciliation backoff uses equal jitter (cap 30 s). Android has the same backoff shape in `AidenChat.kt`, left to the Android workstream.
- EXT-19: `AidenSSELineDecoder` (in AidenSSEParser.swift) checks cancellation and validates UTF-8 once per line. LF/CRLF handling, blank-line delimiters, EOF discard, and the frame limit are unchanged. Do not use `bytes.lines`, because it drops blank lines.
- EXT-13: `activeClient()` returns the cached client before reading the Keychain. The key covers instance, device, credential scope, and activation generation.
- EXT-14/16: interactive calls use a 5-minute resource budget. SSE streams use a separate session (1 h resource, 30 s idle = two missed 15 s heartbeats). Clients `finishTasksAndInvalidate` the sessions they own in `deinit`; injected test sessions are never invalidated.
- EXT-11: `AidenSceneRefreshGate` refetches only on `.active` after `.background`. ContentView and the chat detail ignore transient `.inactive` bounces. The chat load is keyed by an epoch, so a newer load cancels an older one. No conditional fetch, because that needs a protocol change.
- EXT-18: ThinkingOrb is capped at 30 fps. The orb and the shimmers hold still under the `aidenLowPowerMode` environment, which `AidenAppearanceRoot` injects.
- Deferred EXT-15: `AidenChatCache.admittedChats` is the in-memory winner for failed disk writes and list merges. Bounding it needs a design for committed-only eviction plus disk fallback. Summary writes happen once per `saveChat` (on load or send, not per token), so a debounce would gain little.
- Skipped EXT-21: the settled-rows child's `ForEach` flattens into the parent `LazyVStack` (custom views and `EquatableView` are transparent to list flattening), so rows stay lazy. Not profiled in Instruments.
- EXT-20: no broad file split. Only the new types were extracted into their own files.
