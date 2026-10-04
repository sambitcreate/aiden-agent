# Desktop multi-host control: shipped architecture — 2026-10-04

Plan: `docs/plans/completed/desktop-multi-host-control-plan.md` (with its PR 1–8 task plans beside it). PR 1 (#310) is on main. PRs 2–9 are a stack: #313 → #314 (+ #315 merged into #318) → #318, #311 → #316 → #317 → #319 → #336 → #337 (`feat/multi-host-pr9-acceptance`). Per-PR notes: `.memory/multi-host-pr8-remote-new-chat.md`.

## Shape

- Symmetric peers. Every desktop is host and client. Pairing a desktop grants full chat authority (`host:events`, `runs:observe`, `runs:control`, chat/workspace/Bot grants); mobile grants are unchanged.
- Host side (main):
  - `HostRunRegistry` journals every generation, whatever started it (PR 1).
  - `AidenRemoteHostFeedService` serves `GET /host/events`: chunked 256 KiB snapshot, upserts/removes, `run.state`, `stale`; `epoch:seq` cursor, resumable with `Last-Event-ID`.
  - `AidenRemoteHostRunService` serves run streams and run controls; approvals are first-responder-wins.
  - Both stream through `openCursorSse` (`main/services/aiden-remote-sse.ts`), a wake-then-read pump over the source journal.
  - Pairing requests: `aiden-remote-pairing-requests.ts` (match code, sealed envelope, "Accept connection requests").
- Client side (main):
  - `PeerHostRegistry` stores hosts and credentials.
  - `PeerHostManager` (`peer-host-manager.ts`) supervises each enabled host: connecting → connected → backoff → blocked (`identity_changed`, auth, protocol) → disabled. It keeps one feed per host, capped at `PEER_FEED_MAX_CHATS` (2,000) newest chats, and reference-counted run streams.
  - `wake()` coalesces sleep, unlock and network changes within `PEER_WAKE_COALESCE_MS`. `reconnect(hostId, {repaired})` clears a block after re-pairing.
  - Closed operations are in `peer-operation.ts`. Credentials never reach the renderer.
- Renderer:
  - `renderer/lib/hosts/`: `peer-host-feed-state.ts` (per-host feed store plus a per-frame batcher), `remote-host-adapter.ts`, `remote-chat-session.ts` (frame-batched token renders), `chat-session-control.ts`, `remote-new-chat.ts`.
  - Sidebar projection: `sidebar-remote-groups.ts`.
  - Routes: `/host/$hostId/chat/$chatId` and `/host/$hostId/new`. A remote route never reaches a local API.

## Invariants

- A resumed SSE stream must flush its headers at open (`response.flushHeaders()` in `openCursorSse`). Otherwise a resume with nothing to replay never fires the client's `onOpen`, and the host stays "syncing" and stale until the next change or the 15 s heartbeat. The acceptance test reproduces this because its feed heartbeat is one hour.
- The renderer applies feed messages once per animation frame. More than 512 queued for one host collapse into one resync.
- A host's wire cost does not depend on how many other hosts are paired. A wake costs 2 requests per host (`GET /server` plus a feed resume) and no new snapshot.

## Tests

- **Acceptance:** `main/services/peer-multi-host-acceptance.test.ts`, one real-TLS pass. It covers:
  - pairing by setup code
  - the sidebar
  - opening a chat
  - approve, deny and stop
  - send
  - a new chat and a Bot chat
  - drop and resume
  - key rotation, block and re-pair

  It runs in about 1 s.
- **Fixtures:**
  - `peer-pairing-test-host.ts` is a real HTTPS host. Its `services` option takes `chats`, `bots`, `hostFeed` and `hostRuns`; it also has `dropConnections()`, `rotateLeaf()` and `impersonate()`.
  - `peer-remote-chat-test-host.ts` provides `rendererIpc()` and the fake-host harness.
- **Budgets at 1, 5 and 10 hosts.** The numbers are in the plan's Efficiency budgets table.
  - `peer-host-manager.test.ts`: snapshot frames and wake fan-out
  - `peer-host-feed-state.test.ts`: frame batching
  - `sidebar-remote-groups.test.ts`: row reads within 12·n·log₂n
  - `peer-remote-chat-view.test.ts`: tokens rendered per frame

## Outstanding

- The packaged Mac↔Mac run over LAN and Tailscale.
- Idle CPU, wakeups and memory measurements.
- Linux↔Mac acceptance, which waits for the Linux branch.
