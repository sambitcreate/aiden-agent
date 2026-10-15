# Streaming and transcript render performance (2026-10)

Branch `perf/streaming-render` (optimization audit, section 3.4). Not merged yet.

## What changed
- **LLM deltas (MAIN-30):** `main/services/generation-delta-coalescer.ts` merges `chat:delta` /
  `chat:reasoning-delta` per stream for 16 ms (or 16K chars) for local renderer owners only.
  Any other notification on the stream flushes first, so order is preserved. Remote
  (`kind: "remote"`) and headless (`id: 0`) owners bypass it: no wire, journal, or native-client
  change. The run journal still records each delta.
- **Terminal (MAIN-31):** `terminal.ts` batches pty output for 8 ms (or 64K) into one
  `terminal:data` with one sequence number. `snapshot()` and exit flush first. The scrollback
  buffer trims at 2x the cap, and `terminal-history.ts` caps lazily (on read/persist).
  Browser URL detection only scans when `://` appears near the new data.
- **Renderer:** memoized `SettledMessageRow` (UI-10); ScrollArea observer deps are booleans
  (UI-13); `StreamingRevealParser` reparses only the text after the last top-level closed blank
  line (UI-11); open code fences carry `openCode` and render via `CodeBlock plain` until closed
  (UI-12); Split/Workspace context values are memoized (UI-21).
- **Main misc:** bulk PCM decode (MAIN-34), one frozen runtime-event envelope shared with the
  observer queue (MAIN-35), WeakMap cache of serialized tool sizes (MAIN-18).

## Invariants to keep
- A blank line at the top level of the reveal parser must keep resetting all parser state. If a
  construct ever spans blank lines, `StreamingRevealParser` caching breaks. The prefix
  equivalence test in `streaming-reveal.test.ts` guards this.
- Terminal sequences stay contiguous per batch, and the renderer drops `seq <= lastSequence`.

## Deferred
- MAIN-32 (`chat:done` sending the whole chat, plus timeline snapshots): this is a contract
  change across renderer, Remote, and the native clients.
- UI-9 (an external store for streaming text out of ChatPane): broad refactor.
- UI-20 (content-visibility/windowing): risk to scroll-follow and sticky headers.
- UI-22 (object URLs for images): base64 stays in the query cache anyway, and StrictMode would
  revoke the URLs.
- MAIN-34 transport (send bytes instead of base64 through IPC and the worker).
- MAIN-18 chat LRU and projection cache.
