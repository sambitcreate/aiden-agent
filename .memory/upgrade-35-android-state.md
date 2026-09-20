# Android failed-send draft durability — 2026-09-19

## Proven production path

`AidenChatDetailScreen` sends through `AidenChatViewModel.send()`. That action clears both the visible draft and its persisted file before awaiting `AidenRemoteClient.startTurn`. A server rejection merges the submitted text with any newer edits in memory, but previously bypassed persistence. Restart then lost the recovered text. The failure branch now calls the existing `updateDraft` entry point, which saves through the current session generation. No wire shape, retry, attachment persistence, UI layout, onboarding, or plan status changed.

## Evidence

Three additions to existing `AidenChatTest` exercise the production ViewModel, real HTTP client, a latch-controlled MockWebServer 503, actual disk stores, and a fresh-store restart read. Tests assert error recovery and optimistic-message rollback before checking durable text. Original-text and newer-edits cases fail on baseline; the installation-removal/purge case passes on both baseline and fix and prevents stale draft resurrection. Existing Gradle discovery includes this test class; no new file or package.json registration is needed.

## Research decisions

- Selected failed-send draft durability after following the Compose send callback and updateDraft persistence path.
- Rejected speculative concurrent InstallationStore mutation: current callers mutate synchronously on Main; a synthetic multiwriter race is not current production evidence.
- Deferred atomic draft replacement: interrupted direct writes are plausible, but the reproduced failed-send loss is stronger evidence and a more focused change.
- Conceptual references only; no code copied. Pinned OpenCode `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, `packages/app/src/context/prompt.tsx`, keeps prompt state in session-scoped persistence. Waku `src/app/drafts.rs` separates capture/restore from generation-controlled durable saves. Prime Agent `packages/coding-agent/src/modes/interactive/interactive-mode.ts` explicitly retains rejected submissions without losing newer input. OMP `packages/coding-agent/src/modes/interactive-mode.ts` consumes a session draft on startup; Pi `packages/coding-agent/src/core/session-manager.ts` distinguishes buffered from persisted session entries. Hermes `cli.py` intentionally uses an in-memory prompt stash (different product choice); Aiden Plugins catalog provides extensions, not an Android composer persistence policy. Aiden already persists typed drafts, so this fix preserves its established choice.

## Validation and limits

Baseline: 3 focused tests, 2 expected durable-read failures. Fixed: all 165 Android JVM tests, lintDebug, and compileDebugAndroidTestKotlin passed. Final exact-tree rerun recorded in lane ledger. No physical-device test, emulator, iOS test, server/desktop behavior change, or full npm suite. Pending independent Luna, Pullfrog, and hosted CI review at publication. No merge or release authorized.
