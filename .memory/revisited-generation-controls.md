# Revisited generation controls — 2026-09-21

Returning to a chat with a route-detached generation now uses the retained stream projection to expose the existing composer Stop and queue/steer controls. Stop targets that exact stream through the same-document `chat:cancel` authority check; the main handler acknowledges whether cancellation was admitted. Queued messages remain document-local and cannot append until the existing main-process idle and authoritative transcript reconciliation gates settle.

The pane's detached Stop state has no local terminal callback. Clear it when the shell removes the detached lifecycle marker after authoritative settlement, otherwise steering leaves the queue disabled behind a stale “Stopping…” state. Keep reconciliation-only markers (no active projection) read-only. The ordinary local stream path is unchanged.

Focused renderer/IPC tests, chat/composer suite, and held-response Electron regressions cover revisit → queue/steer → next turn and revisit → Stop → new turn. E2E held-response sidebar titles reflect the original prompt, not the deterministic completion text. Local native helper scripts discard inherited SDK variables; on this host a direct Xcode 26.5 SDK helper build was used for E2E because the CommandLineTools macOS 27 SDK fails linking.
