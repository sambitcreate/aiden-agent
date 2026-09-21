# Revisited generation controls — 2026-09-21

Returning to a chat with a route-detached generation now uses the retained stream projection to expose the existing composer Stop and queue/steer controls. Stop targets that exact stream through the same-document `chat:cancel` authority check; the main handler acknowledges whether cancellation was admitted. Queued messages remain document-local and cannot append until the existing main-process idle and authoritative transcript reconciliation gates settle.

The pane's detached Stop state has no local terminal callback. Clear it when the shell removes the detached lifecycle marker after authoritative settlement, otherwise steering leaves the queue disabled behind a stale “Stopping…” state. Keep reconciliation-only markers (no active projection) read-only. The ordinary local stream path is unchanged.

Pullfrog follow-up: terminal cache publication can precede detached-owner cleanup. Once the cached final assistant message is present, the pane masks the retained projection for Stop/queue/steer and stays read-only until reconciliation clears the draining marker. The terminal-sync held-settlement test and pane control contract cover that handoff.

Focused renderer/IPC tests, chat/composer suite, and held-response Electron regressions cover revisit → queue/steer → next turn and revisit → Stop → new turn. E2E held-response sidebar titles reflect the original prompt, not the deterministic completion text. Local native helper scripts discard inherited SDK variables; on this host a direct Xcode 26.5 SDK helper build was used for E2E because the CommandLineTools macOS 27 SDK fails linking.

Review: OpenCode Workers created an isolated checkout at the exact feature commit, but its launcher rejected `--dir` under the configured OpenCode v2 CLI. A direct read-only DeepSeek V4 Flash run in that same worktree reviewed the full diff and surrounding lifecycle/queue contracts, reported no actionable findings, and left the worktree unchanged. The requested “4.1 Flash” name was not listed by OpenCode; V4 Flash was used as the available model.
