# Aiden On The Go — parent-only subagent projection evidence

Verified: 2026-08-25 19:15:02 -0400

The Phase 0 Swift contract tests now lock the parent-only mobile boundary for subagent-backed turns. Visible parent message text survives decode and re-encoding byte/scalar-exact across Unicode, composed text, emoji, paths, URLs, UUIDs, encoded-looking values, and benign credential-shaped prose. Additive stored `subagents` data—including run IDs, items, counts, lifecycle, and controls—decodes compatibly but is omitted when the public parent message is re-encoded; the parent timeline and outcome remain intact.

The shared-fixture privacy scan is path-aware. Only the documented `chat.messages[].text` and `botChatCreate.response.messages[].text` values are exempt from appearance-based path/private-key checks. Structural forbidden keys—including `privateHistory`—and the same appearances in metadata or nested transcript lookalikes remain forbidden.

Physical-device verification used the connected `Sambit’s iPhone` destination (`00008110-00063CD91E98801E`), with no simulator:

```text
xcodebuild -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -destination 'platform=iOS,id=00008110-00063CD91E98801E' \
  -only-testing:AidenOnTheGoTests/AidenRemotePhase0Tests test

PASS — 26 tests passed, 2 environment-gated tests skipped, 0 failures.
```

Result bundle: `/Users/sambitbiswas/Library/Developer/Xcode/DerivedData/AidenOnTheGo-ghdezvtubcjqxggpfnicxhtlmkwy/Logs/Test/Test-AidenOnTheGo-2026.08.25_19-14-51--0400.xcresult`

The skipped live pairing-bootstrap and Keychain probes still require their explicit ephemeral environment setup. This focused development run is not release-signing evidence.
