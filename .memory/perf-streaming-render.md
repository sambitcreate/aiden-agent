# Streaming and transcript render performance (2026-10)

Branch `perf/streaming-render` (optimization audit, section 3.4). Merged in PR #329 (0.53.0).

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

## Renderer CPU/GPU and leak audit fixes (2026-10-29, branch `claude/audit-fix-renderer-perf`)
Implemented from two read-only audits: renderer GPU (audit 02) and renderer leaks (audit 03).

**Streaming:**
- Detached-stream deltas notify `useSyncExternalStore` subscribers once per animation frame (F1).
- Reconciliation retries are bounded (F2).
- Under Reduce Motion, the streaming reveal keeps the normal release cadence instead of rendering on every token.

**KaTeX:** each formula is typeset once into an LRU cache. When KaTeX first loads, only messages that contain math re-render.

**Off-screen pausing:** `renderer/lib/offscreen-pause.ts` provides one shared IntersectionObserver.
- `observeOffscreen` and `pauseWhenUnseen` set `data-offscreen` on the element.
- `:root[data-document-hidden]` follows `visibilitychange`.
- CSS pauses these under either attribute: the thinking shimmer, activity marks, working Bot faces, the image scan, and the onboarding `oa-anim-*` tile art.
- Bot avatar keeps its own observer, but only for lazy photo loading (rootMargin 160px), which needs different semantics.

**Reduce Motion:** `renderer/lib/use-reduce-motion.ts` (`useReduceMotion`) is the one live hook over `:root[data-reduce-motion]`. Activity marks and Bot chat activity still also check the system query on purpose.

**Native browser (F3):** the native browser presents only for body mutations and scrolls that can move or cover it (`browserOcclusionMutated` and `browserOcclusionScrolled`). Streaming text does not trigger it.

**Terminal drawer:** while the drawer animates, its body stays at the settled size and is clipped, so the canvas no longer refits every frame. This is covered in `tests/e2e/terminal.spec.ts`.

**Leaks:**
- `startGeneration` disposes the stream when main resolves without accepting (F4).
- The HTML visual preview cache is an LRU of 64 (F5).
- An empty, unobserved chat message queue is released from the module map (F6).
- AGENTS.md notices are ignored for a generation the pane no longer owns (F7).
- The diagnostics rate window clears its old flush timer on rollover (F8).

**MessageList:** `visualFollowUpBusy` reaches visuals through a context, so settled rows stay memoized when a turn starts or ends.

**Still deferred, as owner decisions:**
- Dropping backdrop blur where the surface alpha is 0.94 or higher: a subtle visible change.
- Unloading off-screen HTML iframes: it loses guest JS state.
- Streaming text in a leaf subscriber.
- Single-pane terminal canvas overflow: pre-existing; the canvas is taller than the drawer.
