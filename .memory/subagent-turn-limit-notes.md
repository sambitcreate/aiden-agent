# Subagent turn-limit partial notes — 2026-09-21

Production 0.42.0 recorded a scout stopping at the deliberate 24-turn ceiling after 45 tool calls; the result was failed with only the limit warning. The per-run store remains private and its identifiers/contents are not copied into this note.

When the turn ceiling is reached, the runner now includes only the last four completed assistant text notes from tool-use turns, bounded by the existing 8,000-character summary projection. Status remains `failed`, cancellation and usage accounting are unchanged, and the warning explicitly says the notes are incomplete and unverified. Unfinished text deltas, tool results, output/protocol-budget failures, and provider failures still do not become a report. The parent already quotes subagent results as untrusted evidence. The activity projector preserves the `report_truncated` notice even for a shortened failed-run note.

This changes no wire schema, public run authority, turn budget, or native projection. iOS and Android remote clients exclude private subagent run details; their ordinary chat transcript continues to carry only the parent assistant's own visible summary.

PR review added an event-boundary regression for five oversized completed notes: the oldest is evicted, the final note remains, the 8,000-character summary is flagged as truncated, and the child remains failed. The test does not expose unfinished text or raw tool results.
Pullfrog review then found that count-based eviction of short notes lacked truncation provenance. The runner now marks `summaryTruncated` whenever a completed note is evicted, independently of the 8,000-character cut; a short-tail regression covers this path and the existing projector test covers its `report_truncated` notice.

Validation: supervisor and event-projector focused tests, type-check and lint pass; iOS unsigned generic-device build-for-testing and 31 release-policy tests pass; Android `:app:testDebugUnitTest` passes using Android Studio's bundled JBR. The full `test:subagents` native pretest is blocked locally by Command Line Tools macOS 27 SDK/Xcode 26.6 linker incompatibility. Suppressing npm lifecycle scripts lets the TypeScript suite start but leaves its run-store native helper absent, so that attempt also is not a valid full-suite pass. Physical-device XCTest, hosted CI, merge, and release are not claimed.
