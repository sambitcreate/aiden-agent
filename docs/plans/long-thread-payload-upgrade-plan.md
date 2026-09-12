# Long-thread payload upgrades

Status: planned; first cut shipped (no-op streaming timeline republish)  
Date: 2026-08-30  
Inspiration: T3 Code PRs `#4006`, `#4622`, `#4705`, `#4788`, `#4791`, `#6675` (context only; Aiden’s architecture does not map 1:1)

## Verdict

Aiden is not T3. T3 is a server-authored thread with an event store, HTTP snapshots, and WebSocket activity frames. Aiden is a **Mac-local Pi workspace** whose source of truth is pretty-printed chat JSON, a Pi JSONL compaction journal, Electron IPC for the desktop renderer, and **HTTP + SSE** (not WebSocket) for iOS/Android.

T3’s headline failure — persist the full accumulated `tool.updated` stdout on every chunk, O(N²) bytes — **does not exist here**. Activity is already a projected one-line timeline. The T3 *class* of work still applies: stop copying unchanged bulk on every streaming tick, stop sending unread fields, bound transfer size, and stop rewriting large snapshots at stream cadence.

This plan ranks upgrades that fit **this** codebase. Do not invent T3 subsystems (orchestration event store, `projectActivityPayload`, `permessage-deflate` on a WebSocket that Aiden does not have).

## How Aiden actually loads, stores, streams, and renders history

| Path | Current behavior | Key files |
| --- | --- | --- |
| Desktop persist | One pretty-printed `chats/<id>.json` rewritten atomically on each **terminal** append (`JSON.stringify(chat, null, 2)`). Streaming does **not** rewrite the chat file per token. | `main/services/chat-store-core.ts` (`writeChat`) |
| Visible transcript | `ChatMessage` holds prose, optional `reasoning`, attachments (inline base64/`text`), `timeline`, `htmlArtifacts` refs, `subagents` refs, and a private `pi` protocol blob. Renderer IPC strips `pi`. | `main/services/types.ts`, `main/services/visible-chat-projection.ts`, `main/services/chat-application-service.ts` (`get` → `chatForRenderer`) |
| Streaming | Pi `text_delta` / `thinking_delta` go over IPC as **deltas**. Assistant persistence (`persistAssistant`) runs once at the end of the turn. | `main/services/llm-client.ts` |
| Tool activity | `GenerationTimelineProjector` already stores only label / target / 120-char detail — never stdout or commands. `tool_execution_update` used to republish the **full** timeline on every tick even when status was already `running`. | `main/services/generation-timeline.ts`, `renderer/shared/generation-timeline.ts` |
| Pi journal | Append-only JSONL via `@earendil-works/pi-agent-core` `JsonlSessionRepo`. Turn commit is transactional; not a per-chunk chat rewrite. Tool results live here for compaction/replay. | `main/services/pi-compaction-session-store.ts` |
| Model request | `generation-context` already clamps tool-result text (32k chars) and a recent-output token budget before the model call. | `main/services/generation-context.ts` |
| Remote wire | HTTP JSON chat snapshots (1 MiB cap, 10k messages, 200k chars/message, **attachment metadata only**). Live turns are SSE events (`text_delta`, `timeline`, …), max 4096 events / 8 MiB per stream. No gzip. | `main/services/aiden-remote-protocol.ts`, `main/services/aiden-remote-chats.ts`, `main/services/aiden-remote-streams.ts` |
| Remote journal | Every SSE event is appended in memory **and** `persist()` clones the full stream snapshot to a pretty-printed DataStore file (coalesced by in-flight write, not by time). | `main/services/aiden-remote-streams.ts`, `main/services/data-store.ts` |
| Mobile cache | iOS/Android apply SSE deltas in memory; they rewrite the local chat cache on turn start and **after terminal reconcile**, not on every token. | `ios/.../AidenChatFeature.swift`, `android/.../AidenChatViewModel.kt` |
| Desktop UI | `MessageList` maps **every** persisted message. No windowing. Streaming reveal keeps a `requestAnimationFrame` loop for the component lifetime. | `renderer/components/message-list.tsx`, `renderer/components/streaming-markdown-reveal.tsx` |

## T3 hypothesis vs Aiden

| T3 change | Fits Aiden? | Notes |
| --- | --- | --- |
| Don’t persist full `tool.updated` stdout; keep a one-line summary until `tool.completed` | **Already the transcript model.** Residual bug: no-op `toolRunning` republishes. First cut below. | T3 `#6675` |
| Project activity payloads on the wire | **Mostly done.** Remote chat GET already drops `pi`, reasoning, attachment bytes, raw tool data. Desktop `chats:get` still ships full attachment bodies. | T3 `#4622` |
| Gzip HTTP snapshots / `permessage-deflate` | **Partial analog.** No WebSocket. HTTP/SSE are uncompressed. gzip for Remote JSON is a product/compat decision (native clients must opt in). | T3 `#4788`, `#4705` |
| Don’t rewrite a full local thread cache on every streaming tick | **Desktop chat file: already terminal-only.** Remote stream journal **does** rewrite the full event array at stream cadence. iOS/Android chat cache does **not**. | T3 `#4006` |
| Keep only the latest context-window / usage row in snapshots | **No T3-style activity history of usage.** Usage is a separate store (`usageStore.record` per assistant `message_end`). Snapshots do not accumulate context-window rows. | T3 `#4791` |
| Transfer/size budget test | **Missing as a regression gate** for long chats / stream journals. First cut adds a projector budget. | — |

## Ranked upgrades (impact vs effort)

Impact is user-visible long-thread cost (bytes, copies, wakeups). Effort is invasiveness and product-surface risk.

### 1. Stop no-op streaming timeline republish — **shipped in this change**

- **Impact:** High for chatty tools (`run_command`, computer use, long MCP). Each `tool_execution_update` was cloning the full step list, sending `chat:timeline` IPC, appending an SSE `timeline` event (counts against the 4096-event / 8 MiB journal), and rewriting the Remote stream snapshot.
- **Effort:** Tiny. Status-only skip; live clients still see pending → running → terminal.
- **Files:** `main/services/generation-timeline.ts`, `main/services/generation-timeline.test.ts`.

### 2. Stop pretty-print rewriting unbounded chat JSON; bound attachment bodies

- **Impact:** Highest for **desktop** long threads with images. Every append serializes the entire history with 2-space indent. Images are inline base64 in the same file and cross IPC on `chats:get`. The performance plan already called this P0.
- **Effort:** Medium–high. Atomic compact JSON is a small format change. Content-addressed attachment files (store refs in chat JSON) is the real win and needs renderer/main/migration tests.
- **Files:** `main/services/chat-store-core.ts`, `main/services/types.ts` (`Attachment.data`), `main/services/attachments.ts`, `main/handlers/chats.ts`.
- **Do not start** until the existing performance-plan Phase 1 durability writer is the same change, not a parallel store.

### 3. Defer Remote stream-journal disk writes until quiet/terminal

- **Impact:** High when a paired phone is streaming. `append()` calls `persist()` after every `text_delta`. `snapshot()` `structuredClone`s all events; `DataStore` pretty-prints up to 16 MiB.
- **Effort:** Medium. `persistDirty` already single-flights; a 250–500 ms quiet window plus mandatory flush on terminal/approval/crash is the T3 `#4006` analog. Needs a test that a killed process still recovers the last flushed prefix, and that reconnect by `Last-Event-ID` still works.
- **Files:** `main/services/aiden-remote-streams.ts`.
- **Product decision:** how many in-flight SSE events may be RAM-only after a Mac crash.

### 4. Coalesce consecutive Remote `timeline` events in the journal

- **Impact:** Medium as defense in depth if a future caller republishes. Today the projector skip should make this rare. Consecutive full-timeline frames still inflate event count toward `MAX_EVENTS_PER_STREAM` (4096), which **shifts out early `text_delta`s**.
- **Effort:** Medium because stored sequences must stay contiguous (`parseSnapshot` requires `n, n+1`). In-place replace of the last `timeline` event with the **same** sequence would drop the update for a reconnecting client whose `Last-Event-ID` is that sequence. Needs an explicit replay rule.
- **Files:** `main/services/aiden-remote-streams.ts`, iOS/Android SSE parsers.

### 5. gzip Remote HTTP JSON (chat GET / list) when `Accept-Encoding` allows it

- **Impact:** Medium for long Remote chats (prose compresses well; already no image bytes). Native URLSession / OkHttp decode gzip transparently if advertised.
- **Effort:** Medium. Must keep uncompressed path for old clients; add `Vary: Accept-Encoding`; never gzip SSE (event framing). Contract/OpenAPI/fixture updates.
- **Files:** `main/services/aiden-remote-router.ts`, `docs/aiden-remote-api-v1.md`, iOS/Android if they currently fail closed on `Content-Encoding`.

### 6. Window the desktop transcript; stop perpetual streaming RAF

- **Impact:** High for 100–500 turn chats (already in the performance plan). `MessageList` mounts every bubble; streaming reveal’s `requestAnimationFrame` never yields after `dueAt: null`.
- **Effort:** Medium for virtualization (focus, copy, artifact iframes, subagent chips). RAF stop is **small and clearly correct** — do it in the performance-plan idle-work slice, not as a payload-format change.
- **Files:** `renderer/components/message-list.tsx`, `renderer/components/streaming-markdown-reveal.tsx`.

### 7. Bound `pi` protocol blobs and tool results in the chat file / journal

- **Impact:** Medium. Terminal persist stores `storedPiAssistantMessage` (full tool-call arguments, e.g. entire `render_artifact` HTML) beside visible prose. The generative-ui store already holds artifact bytes; duplicating them in `pi` inflates chat JSON and future `chats:get`.
- **Effort:** High. Compaction/replay and crash recovery treat the Pi journal as authoritative. Truncating `pi` without a journal strategy would break resume. Fold into compaction / artifact-store work, not a drive-by.
- **Files:** `main/services/pi-message-storage.ts`, `main/services/llm-client.ts`, `main/services/pi-compaction-session-store.ts`.

### 8. Desktop IPC projection for `chats:get` (drop unread bulk)

- **Impact:** Medium once attachments are file-backed. Until then, even a “projection” still needs image bytes for the open chat.
- **Effort:** Medium. Paginate or lazily fetch attachments; keep one-chat-open semantics.
- **Not** a WebSocket projection layer.

### 9. Transfer/size CI budgets

- **Impact:** Process. Prevents the next chatty-tool regression.
- **Effort:** Low to add projector/stream-journal fixtures; high to add a 500-turn chat fixture in CI without huge goldens. Start with synthetic byte caps (this change’s projector test; later: Remote GET fixture + stream journal after N deltas).

## Explicitly out of scope

- WebSocket `permessage-deflate` (Aiden Remote is HTTP/SSE).
- An orchestration event store or `tool.updated` activity rows.
- Shipping historical `context-window.updated` rows (Aiden does not).
- SQLite for chats before measuring atomic compact JSON + attachment files.
- Copying T3’s client cache state machine (`starting`/`running`) onto iOS — mobile already waits for terminal reconcile.

## First cut (this PR)

Skip `GenerationTimelineProjector` publishes when a non-terminal tool status is already in that status. `tool_execution_update` storms no longer clone/send/journal identical timelines. Terminal `toolFinished` still publishes. Regression test: 2 000 extra `toolRunning` calls add zero snapshots and keep the serialized timeline under 4 KiB.

Not in this PR: chat JSON format, Remote gzip, stream-journal debounce, transcript virtualization, `pi` truncation.

## How to tell it’s done

- Plan ranked against **verified** Aiden paths, not assumed T3 ones.
- First cut has tests on persistence/wire-adjacent timeline publish volume.
- Follow-ups point at existing files and call out product decisions (Remote persist lag, gzip, attachment files).
