# Performance and Efficiency Deep Dive

Status: current-state audit (read-only)  
Date: 2026-08-24  
Commit: `94e612a` on `feature/bots-and-ios`  
Related plan: [`docs/plans/performance-stability-efficiency-plan.md`](plans/performance-stability-efficiency-plan.md) (still Planned; Phase 0 instrumentation has not landed)

This document is a fresh whole-app audit of performance, efficiency, battery, memory, and idle work. Five exploration passes covered renderer, Electron main/IPC, storage/memory, iOS/remote/Telegram/bots, and packaging/native/power. Findings were then spot-checked against source.

It does **not** replace the master plan. It records what is true now, what landed independently of that plan, and what the July 2026 claims missed.

## Snapshot

| Item | Value |
| --- | --- |
| App | Aiden Agent 0.30.0 (Electron + React desktop; iOS Aiden On The Go 0.1.0 build 19) |
| Runtime | Electron main/preload + sandboxed renderer; native helpers in `Contents/Helpers/` |
| Pi | `@earendil-works/pi-agent-core` / `pi-ai` 0.80.10 |
| Audit method | Five parallel source audits, then line-level verification of P0/P1 claims |
| Packaged size / energy | **Not remeasured.** No production-equivalent build or Instruments traces in this environment. Size and energy numbers from the July plan remain historical snapshots, not 2026-08-24 measurements. |

## Executive verdict

Aiden is not slow because of one framework choice. It is expensive because **unbounded or always-on paths compound**: polling Git while a folder chat is open, keeping an animation-frame loop alive for the streaming reveal, rewriting pretty-printed chat JSON that still embeds base64 attachments, running a ~600 MB speech recognizer on the Electron main thread, and keeping Telegram long-polls alive even with the Mac window closed.

The July 2026 plan is still the right sequencing: **measure, then bound memory, then kill idle work, then isolate heavy native/repo work, then split the renderer**. Do not start with Highlight.js or vibrancy micro-optimizations.

Two important corrections to that plan's *status*:

1. Several **durability and input-bound** items have landed as part of other work. Chat/index writes are atomic. Attachment ingestion has count and byte caps. Generation history is main-owned. MCP connect is single-flight. The plan text that says "implementation not started" is therefore stale for those bullets, even though the coordinated Phase 0–5 program has not started.
2. Surfaces that barely existed in July now dominate some idle and memory budgets: **Telegram multi-profile long-poll**, **Aiden Remote SSE**, **iOS full-chat reloads**, and **subagent utility processes**.

Highest-leverage remaining work, in order:

1. Stop embedding historical attachment bytes in chat JSON / IPC, and stop pretty-rewriting the whole transcript on every append.
2. Stop idle Git subprocesses and the perpetual streaming-reveal RAF loop.
3. Move Parakeet off the main thread and cap voice IPC.
4. Make parent coding-tool Stop real; own MCP close, crash recovery, and model install.
5. Then renderer scale, startup split, package maps, and a real measurement loop.

## Method

| Pass | Scope |
| --- | --- |
| 1 | Renderer: streaming, RAF, React Query, lists, bundle imports, scroll |
| 2 | Main: Git, MCP, voice, schedules, terminals, IPC cadence, crash/quit |
| 3 | Storage: chat JSON, attachments, caches, voice payloads, compaction |
| 4 | iOS / Remote / Telegram / bots / subagents |
| 5 | Packaging, Vite, native helpers, power policy, instrumentation |

Each July claim was classified **still valid**, **partial**, **fixed**, or **new**.

---

## What changed since the July 2026 plan

| July claim | Now | Notes |
| --- | --- | --- |
| Chat JSON overwritten in place | **Fixed** | Staged `wx` write, `sync`, `rename`, directory sync in `chat-store-core.ts` and generic `DataStore` |
| Unreadable state silently becomes defaults | **Partial** | Chat index quarantines and rebuilds. Authoritative stores often `preserveCorruptFile` / `rejectCorruptWrite`. Soft stores (`usage.json`, schedules, telegram-runtime, subagent-health) can still overwrite a corrupt file on the next save |
| Attachments have no count/aggregate budget; `Promise.all` full reads | **Mostly fixed** | 20 attachments, 16 MiB batch, 8 MiB images, 100k text chars, bounded prefix read, sequential ingest. Legacy stored messages can still rewrite up to `20 × 8 MiB` |
| Renderer-supplied base64 history for generation | **Fixed** | `chat:start` takes ids; main loads history |
| Content-addressed attachment storage | **Still open (P0)** | Chat messages still store inline `data` |
| Pretty-print full-history rewrite | **Still open (P0)** | `JSON.stringify(chat, null, 2)` on every chat write |
| MCP connect not single-flight | **Fixed** | `GenerationBoundConnectionCache.getOrConnect` reuses the in-flight promise |
| MCP schemas per generation / no idle expiry / close not awaited | **Still open** | `listTools()` after connect; `void mcpManager.closeAll()` on quit |
| Git 5 s poll / ~6 commands | **Still open** | Cache TTL is 1 s, so a 5 s poll always misses. Review/push/compare now gate on panel visibility |
| Streaming delta IPC | **Partial** | Renderer coalesces to ≤1 React commit per animation frame. Main still emits every `text_delta` |
| Streaming reveal RAF forever | **Still open** | Effect always reschedules `requestAnimationFrame(tick)` |
| Local voice sync in main | **Still open** | `transcribePcm` is synchronous; ~600 MB ONNX per cached model |
| Stop vs recursive repo tools | **Partial** | Subagent grep/glob honor `AbortSignal` + deadlines. Parent chat tools do not |
| Renderer crash hot-reload | **Still open** | Immediate `loadURL`, no backoff or retry ceiling |
| Model install deletes then extracts | **Still open** | `rm(dir)` then `tar`; cancel does not abort extract |
| Schedule catch-up stampede | **Still open** | Per-task overlap only; no global/battery/lock budget |
| Eager Highlight.js / KaTeX / xterm / settings routes | **Still open** | No `React.lazy`, no `manualChunks` |
| Source maps in production globs | **Still open** | Vite and `build-electron.mjs` both `sourcemap: true`; `files` includes `build/**` with no `!**/*.map` |
| Packaged perf feedback loop | **Still open** | Dev-only process diagnostics; no budgets, visualizer, or idle-spawn tests |

New surfaces since the July audit (now first-class efficiency risks):

- Telegram: 30 s long-poll × every enabled profile (up to 16), ownership heartbeat, typing every 2.5 s, unthrottled reasoning edits.
- Aiden Remote: 15 s SSE heartbeats, 10 s renderer settings poll, iOS 1-hour resource timeout + reconnect loop, per-event disk writes on stream apply.
- iOS: cache-first bots and bounded media caches ship; chat GET is still a full transcript (up to 10k messages / 1 MiB JSON).
- Subagents: concurrency gates exist; each local inference worker is still an Electron `utilityProcess`.

---

## Priority ledger

Severity is user-visible impact if the path is exercised, not "is this easy to fix."

### P0 — data loss, unbounded allocation, or always-on cost in the default path

| ID | Issue | Surface | Evidence |
| --- | --- | --- | --- |
| P0-1 | Historical attachments stay inline base64 in chat JSON, IPC `chats:get`, renderer `data:` URLs, and generation rehydration | Storage / IPC / renderer | `main/services/types.ts` attachment `data`; `visible-chat-projection.ts` `chatForRenderer` does not strip `data`; `renderer/components/message-bubble.tsx` rebuilds data URLs; `generation-messages.ts` rehydrates `attachment.data` |
| P0-2 | Every chat mutation pretty-prints and rewrites the entire transcript | Storage | `writeChat` in `main/services/chat-store-core.ts` (`JSON.stringify(chat, null, 2)`). Chat **reads** are unbounded `fs.readFile`. Visible content ceiling is 64 MiB (`MAX_VISIBLE_MESSAGE_CONTENT_CHARS`) |
| P0-3 | Voice IPC has no duration or byte cap | Main / IPC | `voice:transcribeLocal` → `pcmToFloat32(asString(...))` with no size check (`local-voice.ts`, `voice-codec.ts`). Hosted `voice:transcribe` is the same (`phase2.ts`, `transcription.ts`). Recorder has no stop-by-size |
| P0-4 | Folder-backed chats spawn ~6 Git children every 5 s while the pane is open | Main + renderer | `useGitInfo` `refetchInterval: 5_000`, `staleTime: 1_000` (`queries.ts`); `git.ts` cache TTL 1_000 ms; `info()` = `repository()` (3 `rev-parse`) + `status()` (`status`, `remote`, `for-each-ref`) |

### P1 — main-thread stalls, idle battery, or stop/lifecycle holes

| ID | Issue | Surface | Evidence |
| --- | --- | --- | --- |
| P1-1 | Streaming reveal schedules RAF forever while mounted | Renderer | `streaming-markdown-reveal.tsx` effect always calls `requestAnimationFrame(tick)`. Scheduler can set `dueAt: null` when caught up / reduced motion (`streaming-reveal.ts`), but the loop never exits. Loop ends only when the component unmounts after handoff |
| P1-2 | Streaming reparses growing Markdown and re-highlights fences; ChatPane also re-renders Composer + ModelPicker every frame | Renderer | `parseStreamingReveal(content)` per content change; `MarkdownContent` → full `ReactMarkdown` + GFM + math + KaTeX; `highlight.js` default import. `streamingText` lives in the same `ChatPane` as footer chrome |
| P1-3 | Overlapping scroll observers + `autoScrollDeps` include full `streamingText` | Renderer | `ScrollArea` in `ui.tsx`: toolbar/footer `ResizeObserver`, viewport `ResizeObserver` on the element **and every child**, plus `MutationObserver` `{ childList, subtree: true }`. Same pattern on `Sidebar` |
| P1-4 | Local Parakeet loads ~600 MB ONNX and decodes synchronously in Electron main; cache has no idle eviction | Main | `parakeet.ts` comments and `getRecognizer` `Map`; `transcribePcm` is sync; `releaseRecognizer` only on model delete |
| P1-5 | Parent (chat) `grep` / `glob` / `list_dir` / `read_file` ignore `AbortSignal`; parent grep is JS `RegExp` walk | Main | `makeParentGrep` / `makeParentGlob` / `makeParentListDir` / `makeParentReadFile` omit `signal`. Subagent variants honor signal + deadlines. Parent `read_file` `fs.readFile`s the whole file then slices `MAX_READ_BYTES` |
| P1-6 | MCP: `listTools()` every generation; no idle TTL; quit fire-and-forgets `closeAll` | Main | `mcp.ts` `collectMcpAgentTools`; `main/index.ts` `void mcpManager.closeAll()` |
| P1-7 | Renderer crash recovery is an immediate reload with no backoff, reason filter, or retry ceiling | Main | `render-process-gone` → `loadURL` (`main/index.ts`) |
| P1-8 | Local model install deletes the usable directory before validating the replacement; cancel cannot stop `tar` | Main | `local-models.ts` `rm(dir)` then `execFile(/usr/bin/tar)`; abort is fetch-only |
| P1-9 | Scheduled catch-up dispatches every missed task with only per-task overlap protection; no battery/lock/global budget | Main | `schedule-service-core.ts` startup catch-up; `powerMonitor` is resume → portable-config refresh only |
| P1-10 | Telegram long-poll is always-on while enabled, for every profile, with the Mac window closed | Telegram | 30 s long-poll, 3 s error sleep; all profiles `start()` in parallel (up to 16); ownership heartbeat ~`staleMs/4` |
| P1-11 | Soft JSON stores lack `maxBytes` / corrupt-write rejection | Storage | `usage-store.ts`, `schedule-store.ts`, telegram-runtime, `subagent-health-metrics.ts` vs bots / AA cache which bound and reject |

### P2 — scale, startup, package, and secondary always-on work

| ID | Issue | Surface | Evidence |
| --- | --- | --- | --- |
| P2-1 | Closed model picker still queries every provider and rebuilds catalog structures | Renderer | `useProvidersModelInfo(providers)` not gated on `open`; mounted from composer chrome |
| P2-2 | Bare `QueryClient()` → `staleTime: 0`, `refetchOnWindowFocus: true` for most queries | Renderer | `router.tsx` `new QueryClient()`. Exceptions: model info 1 h, AA Infinity, Git 1 s |
| P2-3 | First React paint waits for `providersApi.list()` | Renderer | `renderer/main/index.tsx` bootstrap |
| P2-4 | Settings, Profile, Scheduled, Bots, xterm, KaTeX CSS, full Highlight.js are in the eager graph | Renderer / Vite | Static router imports; `import hljs from "highlight.js"`; `import "katex/dist/katex.min.css"`; no `manualChunks` |
| P2-5 | High-cardinality lists are unwindowed | Renderer | Transcript `messages.map`, files, review diffs, sidebar chats, model picker, command palette. Zero virtualizer. `React.memo` only on Markdown/CodeBlock |
| P2-6 | Terminal and LLM deltas cross IPC at source cadence | Main | `pty.onData` → `terminal:data`; every `text_delta` / `thinking_delta` → `chat:delta` |
| P2-7 | Production packaging includes source maps | Package | `vite.config.ts` and `scripts/build-electron.mjs` `sourcemap: true`; `package.json` `files` globs `build/**`; verifier does not reject `.map` |
| P2-8 | Remote settings poll every 10 s from the always-mounted sidebar popover | Renderer | `useAidenRemoteSettings` `refetchInterval: 10_000` |
| P2-9 | iOS SSE stay-alive (1 h resource timeout) + reconnect; per-event `saveActiveStream` | iOS / Remote | `AidenRemoteClient.swift`, `AidenChatFeature.swift`; Mac 15 s heartbeats |
| P2-10 | Remote chat GET is a full transcript (≤10k messages / 1 MiB), no message pagination | iOS / Remote | Protocol caps exist; iOS loads the whole chat; title refresh can re-fetch up to 7 times |
| P2-11 | Telegram queue unbounded; reasoning `editMessageText` is unthrottled (drafts throttle at 900 ms) | Telegram | `telegram-queue.ts`, `telegram-activity.ts` |
| P2-12 | `MessageList` `useLayoutEffect` with no dependency array runs every commit | Renderer | `message-list.tsx` |
| P2-13 | `highlightAuto` when language is missing | Renderer | `code-block.tsx` |
| P2-14 | Stream journals: 256 streams × 4096 events, prune after 24 h | Remote | `aiden-remote-streams.ts` |
| P2-15 | Telegram outbound can `readFile` up to 50 MB into memory | Telegram | `telegram-service.ts` |
| P2-16 | Dual history: ChatStore JSON plus Pi JSONL journals | Compaction | Compaction reduces **provider context**, not ChatStore bytes |

### P3 — smaller timers, measurement gaps, accepted tradeoffs until traced

| ID | Issue | Notes |
| --- | --- | --- |
| P3-1 | Foundation Models 5 s poll while `model_preparing`; each probe spawns a helper | Cached 30 s / 5 s preparing + single-flight; `activate` forces a probe |
| P3-2 | Subagent panel 1 s `setInterval` while runs are active | UI clock only |
| P3-3 | Dictation pill `backgroundThrottling: false` | Created on first show, destroyed on dispose; energy unmeasured |
| P3-4 | Transparent + vibrancy main window | Unmeasured GPU/energy cost |
| P3-5 | Updater 15 s first check then 6 h | Bounded; acceptable unless traces show otherwise |
| P3-6 | Live Activity `Text(timerInterval:)` on Lock Screen | System timer; expected; display capped ~100 min |
| P3-7 | Skeleton shimmer 30 fps TimelineView | Cold load only; Reduce Motion freezes it |
| P3-8 | Pairing countdown 1 s interval | Only while pairing UI is open |
| P3-9 | No packaged budgets, bundle visualizer, idle-spawn tests, or Instruments runbook | Phase 0 of the master plan |

---

## Surface 1 — Renderer

### Streaming

The reveal scheduler is documented as a persistent animation-frame loop (`advanceStreamingRevealSchedule` in `renderer/lib/streaming-reveal.ts`). The React effect in `streaming-markdown-reveal.tsx` always reschedules the next frame. Reduced motion jumps to fully revealed (`dueAt: null`) but **does not cancel RAF**. The loop dies only when the streaming UI unmounts after handoff.

Partial mitigation: `chat-pane.tsx` and `use-assistant-chat.ts` coalesce incoming deltas to at most one React commit per animation frame. That does not stop Markdown reparse of the accumulated string, Highlight.js on growing fences, or parent re-renders of Composer and ModelPicker.

`code-block.tsx` memoizes highlighting on the full `code` string and uses the **full** `highlight.js` catalog (`import hljs from "highlight.js"`). Unknown languages call `highlightAuto`.

### Scroll

`ScrollArea` (`renderer/components/ui.tsx`) observes toolbar/footer size, viewport size, **every child**, and the whole subtree via `MutationObserver`. Chat pane `autoScrollDeps` include `streamingText`, so every coalesced stream frame can retrigger scroll measurement. A detached reader is supposed to stay put; overlapping observers make that contract expensive.

### React Query

`new QueryClient()` in `renderer/main/router.tsx` keeps TanStack Query v5 defaults: `staleTime: 0`, `refetchOnWindowFocus: true`.

| Hook | staleTime | refetchInterval | refetchOnWindowFocus |
| --- | --- | --- | --- |
| Most (`useChat`, `useSettings`, `useProviders`, …) | 0 | — | true |
| `useModelInfo` / `useProvidersModelInfo` | 1 h | — | default true |
| `useGitInfo` | 1 s | **5 s** (if workspace) | default |
| `useGitReview` | 1 s | **4 s** if panel enabled | default |
| `useGitPushCapability` | 1 s | **5 s** if enabled | default |
| `useGitComparison` | 1 s | **5 s** if enabled | default |
| `useGitWorktrees` / `useGitBranches` | 1 s | — | default |
| `useDiscoveredSkills` | 30 s | — | default |
| `useArtificialAnalysisStatus` | Infinity | — | **false** |
| `useComputerUseStatus` | 5 s | — | true |
| `useFoundationModelsConnection` | default | 5 s iff `model_preparing` | true |
| `useAidenRemoteSettings` | default | **10 s** | **true** |

Git review/push/compare intervals are the one real improvement: they disable when the environment/review surface is inactive. `useGitInfo` is **not** gated on visibility or document hidden state and is used from the chat pane whenever a folder workspace is selected.

### Lists, memo, lazy

- No list virtualization anywhere in the renderer.
- `React.memo` only on Markdown/CodeBlock.
- No `React.lazy` / route-level `import()`.
- `MessageList` runs a no-deps `useLayoutEffect` every commit for subagent-chip focus handoff.

### Bundle / startup

`vite.config.ts`: two HTML entries (`main-window`, `pill`), `sourcemap: true`, no `manualChunks`, no visualizer, no chunk budgets.

Eager in the first graph:

- Router statically imports Settings, Profile, Scheduled, Bots (`renderer/main/router.tsx`).
- Settings statically imports every section.
- KaTeX CSS at `renderer/main/index.tsx`.
- `@xterm/xterm` from `terminal-drawer.tsx`, pulled by the chat layout even though the drawer returns `null` when closed (runtime win, still a parse/compile cost).
- Full Highlight.js.

Bootstrap still `await`s `appApi.getInfo()` and `providersApi.list()` **before** `createRoot`. Stale catalog refresh is fire-and-forget after that and does not contact models.dev.

July snapshot of **2.54 MB minified / 764 KB gzip** was not remeasured here (no `build/renderer` in this environment). Nothing in config would have reduced it.

### What the renderer already does well

- Stream deltas coalesced to RAF before `setState`.
- Reveal unmounts after successful handoff (RAF does not outlive a finished turn).
- Markdown/CodeBlock memoization.
- Artificial Analysis query is Infinity / no focus refetch.
- Model-info staleTime is one hour.
- Terminal surface unmounts when closed; resize is RAF-coalesced.
- Model-pad pointer RAF is one-shot coalesce, not a spin loop.
- Pill waveform RAF only while recording.
- Reduced-motion hooks; CSS transitions rather than a motion library.
- Error boundaries around message bubbles.

---

## Surface 2 — Electron main, IPC, children, lifecycle

### Git

`main/services/git.ts`:

- Commands use argv (no shell), process groups, 4 s read timeout, 1 MiB default buffer, AbortSignal, SIGTERM→SIGKILL after 750 ms.
- In-memory cache: **1 s TTL**, 64 entries.
- Uncached `info()` still launches about **six** Git processes.

Because the renderer polls every 5 s with `staleTime: 1_000`, the cache never amortizes the poll. A normal open folder chat is ~72 Git children/minute from info alone, plus Review at 4 s when that panel is open.

There is no workspace freshness coordinator, no watcher-driven invalidation, and no pause when hidden, minimized, locked, or on battery.

### Local voice

`parakeet.ts` constructs `OfflineRecognizer` in-process, caches one per model in a `Map`, and decodes on the caller’s thread. Models are labeled ~620 MB in `local-models.ts`. Using both v2 and v3 can retain on the order of 1.2 GB until delete.

`voice:transcribeLocal` is an `async` IPC handler that calls **synchronous** `transcribePcm`. There is no worker, utility process, queue, cancellation of in-flight decode, or memory-pressure eviction.

Install path (`local-models.ts`): download to a temp tar (abortable), then `rm` the existing model directory, `tar -xjf` with a 5-minute timeout and **no AbortSignal**, then validate. Failure deletes the directory again. An interrupted install can remove a working model.

### Tools and Stop

| Tool path | Abort / deadline | Notes |
| --- | --- | --- |
| Parent `read_file` | No | Whole-file `readFile`, then truncate |
| Parent `list_dir` | No | Unbounded `readdir` |
| Parent `glob` | No | `fs.glob` walk |
| Parent `grep` | No | JS `RegExp`, recursive |
| Subagent `grep` / `glob` | Yes | RE2, visit/byte/duration budgets |
| `run_command` | Yes | Abort + 120 s + force-kill |
| Exa / network `fetch` | Yes | `signal` passed |
| MCP `callTool` | Yes | `{ signal }` |

Foreground chat uses the **parent** tool set (`buildCodingTools` → `buildParentCodingToolSet`). Pressing Stop therefore does not reliably stop recursive JS search.

### MCP

Improved: `GenerationBoundConnectionCache` is single-flight per id/generation.

Still open: tool schemas fetched via `listTools()` after connect on each generation; no idle expiry; `cleanupApplication` does `void mcpManager.closeAll()` so helpers can outlive quit.

### Terminals and LLM IPC

- Terminal buffer is bounded (`MAX_BUFFER_CHARS = 200_000`).
- Output is still forwarded at PTY cadence (`pty.onData` → IPC).
- LLM `text_delta` / `thinking_delta` are forwarded immediately (`llm-client.ts`). Renderer coalesces; main does not.

Hidden PTYs persist with the session; they close on renderer destroy / `did-start-loading`.

### Crash, quit, power

**Quit** is ordered: abort generations → await LLM shutdown → subagent registry → remote stop → cleanup → settle schedules/telegram/terminals. Renderer is closed before teardown (`quit-barrier`). MCP close is the hole.

**Crash:** `render-process-gone` logs, closes terminals, immediately reloads. No exponential backoff, no rolling retry window, no safe-mode screen, no distinction of `crashed` vs `killed` vs `oom` for policy.

**Power:** `powerMonitor.on("resume")` refreshes portable config. No battery, lock, suspend, idle, or low-power handlers. No central lifecycle signal as Phase 5 of the plan described.

### Schedules

Cron per task. Startup catch-up fires every missed run with `void dispatch(...)`. Overlap protection is per-task only. No global concurrency, jitter, catch-up ceiling, or AC/battery/lock policy.

### Child-process inventory (main-owned)

| Owner | Mechanism | Cadence | Cancel |
| --- | --- | --- | --- |
| Git | `spawn(git)` | Renderer 4–5 s polls + on-demand | AbortSignal + 4 s read timeout + process-group kill |
| Terminal | `node-pty` | User sessions; data at PTY cadence | Closed on webContents destroy |
| `run_command` | detached `spawn(shell)` | Tool calls | Abort + 120 s + force-kill |
| Foundation Models Helper | `open -W -n` helper app | Status/title; 5 s while preparing | Timeout + AbortSignal + cancel file |
| Local models | `fetch` + `/usr/bin/tar` | User download | Fetch abort only |
| Schedule scripts | `spawn` | Cron / catch-up | Schedule cancel |
| Computer Use | broker + bridge | Session-scoped | Session close |
| Aiden Remote | listener; `dns-sd` if LAN advertise | While remote enabled | Shutdown settle |
| Tailscale | `execFile` | Remote Tailscale routes | Operation-local |
| Subagent inference | `utilityProcess.fork` | Child inference | Shutdown controller + lease |
| Subagent run-store / file-mutator / shell-runner | `spawn` helpers | Subagent ops | Runner abort |
| Worktree remover | `spawn` | Worktree delete | Operation-local |
| Bot inbox writer / keychain | `spawn` | Rare | Local timeouts |

Helpers are **not** started at app launch except as needed. There is still no shared idle-eviction / power-policy layer.

### Persistent timers in main (production)

| Timer | Interval | Notes |
| --- | --- | --- |
| App updater | 15 s first, then 6 h; retry 30 s / 5 m / 30 m | Packaged only; bounded |
| Telegram long-poll | 30 s | Per enabled profile |
| Telegram ownership heartbeat | ~`staleMs/4` | While a turn is owned |
| Telegram typing | 2.5 s | While a turn is active |
| Remote SSE heartbeat | 15 s | Per subscriber; `unref` |
| Local model load monitor | 500 ms | Only while loading |
| Schedule cron | per task | Catch-up on start |

The heavy idle load is **renderer refetch intervals driving main Git**, not a pile of main `setInterval`s.

---

## Surface 3 — Storage, memory, compaction

### Durability that now works

Chat and index writes:

1. Remove crash-left stages.
2. Write sibling temp with `flag: "wx"`, mode `0o600`.
3. `sync` the file.
4. `rename` onto the target.
5. Sync the parent directory.
6. Best-effort remove the staged file.

Chat index quarantine + rebuild from valid chat bodies is implemented. Generic `DataStore` uses the same atomic rename pattern.

Attachment **ingestion** is bounded:

- `MAX_ATTACHMENTS_PER_MESSAGE` (20)
- 16 MiB batch / 8 MiB image
- 100k text chars with bounded prefix read
- Sequential ingest (not `Promise.all`)
- Admission controller before allocation

Generation no longer clones renderer-supplied history. `chat:start` sends ids; main loads the chat.

### What still grows without a budget

1. **Inline attachment `data` in durable chat JSON.** Opening a long image chat parses JSON, ships base64 over IPC, and rebuilds `data:` URLs in React (triple expansion). Compaction replaces binaries with continuity markers in the **Pi journal**, not in ChatStore.
2. **Pretty full-file rewrite** of unbounded history on every append.
3. **Unbounded chat file reads** (`fs.readFile` of the whole JSON).
4. **Voice PCM/base64** with no cap.
5. **Parakeet recognizer Map.**
6. **Soft stores** without `maxBytes`: usage, schedules, telegram-runtime, subagent health. Contrast: Artificial Analysis cache is 32 MiB + atomic rename; bots/capabilities/remote state generally `maxBytes` + reject corrupt writes; Pi runtime effects prune to capacity; Gemini context cache has TTL + snapshot/workspace caps; renderer bot photo cache is 4 concurrent / 64 entries / 32 MiB / 4 MiB per photo.

Legacy `safeStoredAttachments` can still admit up to `20 × 8 MiB` on read/rewrite of old messages.

### Compaction as an efficiency mechanism

Pi-native compaction is **strong for provider context** (threshold, overflow retry, crash-recoverable journals, child parity). It is **weak for device storage, IPC, and renderer heap**. Successful compaction can add summarizer usage and journal growth while the visible ChatStore JSON stays large. Dual history (pretty JSON + JSONL journals) is itself a disk cost.

Terminal buffers are one of the few clearly bounded runtime rings (200k chars).

---

## Surface 4 — iOS, Aiden Remote, Telegram, bots, subagents

### Already optimized (shipped)

| Area | What it does |
| --- | --- |
| Cache-first Bot UI | Disk hydrate before network; segment merge keeps last-good on partial refresh |
| Cold-only skeletons | Shimmer only when cold; Reduce Motion freezes it |
| Client reuse | Cached `AidenRemoteClient` / `URLSession` by installation+device |
| Conversation paging | Inbox/search `maxConversationPage = 50`; remote `limit` 1–50 |
| Chat wire caps | ≤10k messages, ≤1 MiB JSON, ≤200k chars/message |
| Stream journal caps | 256 streams, 4096 events, 8 MiB event bytes, 15 s heartbeat + `unref` |
| Remote attachments | Turn/device/chat/TTL/pixel caps; 10 min TTL prune; 12 MiB request / 64 MiB pending |
| Mac photo cache | 4 concurrent, 64 entries, 32 MiB, 4 MiB/photo |
| iOS media | 96 MiB attachment disk cache; 24 thumbnails / 32 MiB; source images capped then downscaled |
| Bot cache envelopes | 4 MiB snapshot, 4 MiB avatar |
| Live Activities | No push; 5 min `staleDate`; marked stale on background |
| iOS energy baseline | No `UIBackgroundModes`, location, or background fetch in `Info.plist` |
| Telegram drafts | Edits ≥900 ms |
| Telegram inbound media | 20 MB download; 8 MB image skip |
| Skill watchers | Narrow directory watch, `persistent: false` |
| Inventory leases | Generation fence; abort on drift |
| Subagents | hosted ≤2 / local ≤1; queue ≤32; children ≤32; IPC frames capped (32 MiB protocol); aggregate health metrics |
| Bot list projection | `mapBounded(..., 8)` |
| Thinking orbs (iOS) | `TimelineView` pauses off-screen; no `CADisplayLink` |

### Remaining risks

**Telegram is the Mac background tax.** Settings copy tells the user it keeps working with the window closed. That is correct — and it means 30 s HTTPS long-poll × every enabled profile (up to 16), plus ownership heartbeats and typing indicators during turns. Reasoning activity enqueues an `editMessageText` **per delta** with no interval (unlike drafts). The outbound queue has no max size.

**iOS streaming is radio-heavy by design.** SSE resource timeout is one hour. Reconnect is 500 ms idle / 1 s soft error / exponential to 30 s. Mac sends 15 s heartbeats. Every applied SSE event can `saveActiveStream` (flash + energy during fast token streams). Foreground resume also reconciles Live Activities.

**Chat history on the phone is not windowed.** Protocol allows 10k messages / 1 MiB. iOS loads the entire chat into a `LazyVStack`. Oversized histories fail as `payload_too_large` or pay decode/render cost. Title refresh can re-fetch the full chat several times.

**Attachment decode peak:** iOS may read up to 32 MiB then `UIImage(data:)` before downscale.

**Subagents:** concurrency gates are real. Each local child is still a process. Remote or Telegram turns that spawn nested subagents inherit that cost.

**Bonjour `dns-sd`:** spawned only when LAN advertise is on.

**Workspace browser:** 5_000 entries / depth 20 — bounded but still expensive for huge trees.

---

## Surface 5 — Packaging, native, power, instrumentation

### electron-builder (`package.json` `build`)

| Setting | Value |
| --- | --- |
| `asar` | true |
| `asarUnpack` | `sherpa-onnx-node`, `sherpa-onnx-darwin-*`, `node-pty` |
| `files` | `build/main/**/*`, `build/preload/**/*`, `build/renderer/**/*`, model-capabilities, notices, `package.json` — **no map exclusion** |
| `extraResources` | app icons + computer-use artifact/LICENSE |
| `mac.extraFiles` → `Helpers/` | Foundation Models Helper, CuaDriver.app, worktree-remover, bot-inbox-writer, subagent-run-store, file-mutator, shell-runner |
| Fuses | `afterPack: configure-electron-fuses.mjs`; `afterSign: verify-macos-package.mjs` |

Vite and `scripts/build-electron.mjs` both emit source maps. `verify-macos-package.mjs` does not reject `.map`. The July “~9.8 MB of generated source maps” figure was a measured snapshot; this environment has no packaged artifact to re-weigh, but the config path is unchanged.

### Native helpers

On-demand, not boot daemons:

- Worktree remover, bot inbox writer, subagent I/O helpers: spawn per operation.
- Foundation Models Helper.app: `/usr/bin/open -W -n` per request; tracked in `activeHelperRequests`.
- Computer Use: host opens broker, spawns bridge, session-scoped cleanup. Rust broker in `native/computer-use-broker/`.
- Subagent inference: `utilityProcess.fork`.

### Window / energy knobs

- Main window: `transparent: true`, `vibrancy: "sidebar"`, `visualEffectState: "active"`, `backgroundColor: "#00000000"`.
- Pill: `backgroundThrottling: false` so recording continues while unfocused/hidden. Created on first dictation show; destroyed on dispose. Comment in `pill-window.ts` documents the intent.

These remain **measurement gaps**, not proven regressions.

### Instrumentation

`installProcessDiagnostics` is **development-only**: pid, rss, heap, uncaught exception, signals, exit. Packaged builds do not initialize `aiden-dev.log` (see `.papercuts/troubleshooting.md`). Subagent failures write a redacted JSONL record to `logs/subagent-runtime.log`.

There are **no**:

- Privacy-safe diagnostic event ring (startup milestones, event-loop delay, IPC bytes, child launches, RAF counts)
- Bundle visualizer or CI chunk budgets
- Git child-count / idle-spawn assertions
- Packaged energy/startup/heap soak gates
- Tests that the reveal loop stops when complete (`streaming-reveal.test.ts` covers schedule math, not “zero RAF”)

`renderer/lib/slash-command-performance.test.ts` is a palette ranking/mount timing test under catalog limits, not a runtime budget.

---

## Idle-work map (what still runs when the user is not typing)

Assume: Mac app open, folder workspace selected, no generation in flight, Review closed, Telegram enabled, Remote settings query mounted, window visible.

| Work | Runs? | Typical rate |
| --- | --- | --- |
| Git `info` | Yes | 6 spawns / 5 s |
| Git review/push/compare | No | Gated off |
| Streaming reveal RAF | No | Only while streaming UI mounted |
| Remote settings IPC | Yes | 10 s |
| Query focus refetch | On focus | Most queries staleTime 0 |
| Telegram long-poll | Yes | 30 s × profiles |
| App updater | Packaged | 6 h after first 15 s |
| Foundation Models | On activate / preparing | Helper spawn |
| MCP | If previously connected | No idle TTL |
| Parakeet | If used this session | ~600 MB retained |
| iOS SSE | Only while a stream is open / reconnecting | 15 s heartbeat on Mac |
| Subagent workers | Only while runs exist | Concurrency-gated |

Hidden/minimized/locked: **Git info still polls** (no visibility gate). Telegram still polls. Remote settings still poll if that query remains mounted.

---

## Memory shape (qualitative)

Not measured this run. Source-implied growth:

1. Long chats with images: disk JSON + parse + IPC + `data:` URLs.
2. Voice: unbounded Float32 / base64 on main and renderer, plus cached ONNX.
3. Compaction journals + ChatStore both retained.
4. Remote stream journals until 24 h prune.
5. Telegram queue if reasoning is verbose.
6. iOS: 96 MiB attachment cache + 32 MiB decode peak; avatar envelopes 4 MiB.

Settling after attach/remove/chat-switch is unproven (Phase 0 heap traces still missing).

---

## Claim-by-claim vs the July 2026 plan

| July claim | Verdict |
| --- | --- |
| Chat JSON overwritten in place | **Fixed** (atomic writer) |
| Parse failure → empty index / missing chat | **Mostly fixed** (quarantine + rebuild); soft stores still weaker |
| Attachments unbounded / concurrent full reads | **Mostly fixed** at ingest; historical inline `data` remains |
| History carries base64 on generate | **Fixed** for generate; **open** for persist/IPC/UI |
| No content-addressed blobs | **Open** |
| Pretty full rewrite | **Open** |
| Reveal RAF forever | **Open** (unmount-after-handoff only) |
| Git 5 s / ~6 commands | **Open**; review gated; cache TTL fights the poll |
| Parakeet sync in main | **Open** |
| Stream copies + reparse Markdown | **Open**; delta coalesce only |
| Overlapping scroll observers | **Open** |
| Stop ≠ repo/network cancel | **Partial** (subagent + Exa + MCP + `run_command`; parent search open) |
| MCP not single-flight | **Fixed** |
| MCP schemas / idle / close | **Open** |
| Crash hot reload | **Open** |
| Model install deletes first | **Open** |
| Schedule catch-up stampede | **Open** |
| Closed model picker catalog work | **Open** |
| Startup waits on providers | **Open** |
| Eager routes / HL.js / KaTeX / xterm | **Open** |
| Terminal/LLM IPC at source cadence | **Open** on main; renderer coalesces LLM |
| Unwindowed lists | **Open** |
| Renderer 2.54 MB / 764 KB gzip | **Not remeasured**; config still eager |
| ~9.8 MB maps in package | **Config still ships maps**; size not remeasured |
| No trustworthy feedback loop | **Open** |
| Pill `backgroundThrottling: false` | **Confirmed** |
| Vibrancy/GPU cost | **Still unmeasured** |

---

## Sequencing (do not start over)

Keep [`docs/plans/performance-stability-efficiency-plan.md`](plans/performance-stability-efficiency-plan.md) as the delivery plan. This audit only updates the evidence.

Safe parallel lanes after a thin Phase 0 (even a counter-only diagnostic ring plus git-spawn and RAF tests):

1. **Attachment references + compact chat writes** (P0-1, P0-2) — biggest disk/IPC/heap win; compaction already solved the model-context half.
2. **Git freshness coordinator + stop Git/info polling when idle/hidden** (P0-4).
3. **Reveal scheduler that actually sleeps** + isolate stream turn from composer/picker (P1-1, P1-2, P1-3).
4. **Voice bounds + worker isolation** (P0-3, P1-4).

Follow-ons unchanged from the plan: parent-tool Stop, MCP idle/close, crash backoff, atomic model install, schedule/power policy, virtualization, route split, map-free packages, soak gates.

Do not combine persistence-format migration, worker isolation, and UI virtualization in one release.

### Plan text that should be edited when implementation starts

- MCP bullet: connect **is** single-flight; remaining work is schema cache, idle expiry, awaited close.
- Durability: atomic chat/index writer **has landed**; remaining P0 is blob references + pretty rewrite + voice caps + soft-store `maxBytes`.
- New first-class rows: Telegram always-on long-poll, Remote/iOS SSE, iOS full-chat GET, subagent `utilityProcess` cost.

---

## Out of scope / non-goals (unchanged)

- Rewriting away from Electron or React.
- Replacing JSON stores with SQLite before an append journal is measured.
- Speculative visual-quality cuts (vibrancy, blur, transparency) without packaged traces.
- Lazy-loading the primary chat shell or composer.
- Polling models.dev from normal runtime.

---

## How to re-run this audit

1. Re-read this file and the master plan; do not assume July line numbers.
2. Search for `refetchInterval`, `requestAnimationFrame`, `setInterval`, `JSON.stringify(.*null, 2)`, `fs.readFile`, `spawn(`, `utilityProcess`, `backgroundThrottling`, `sourcemap: true`.
3. Confirm Git cache TTL vs renderer poll, parent vs subagent coding tools, and whether `chatForRenderer` still forwards `attachment.data`.
4. If a packaged build exists, weigh `*.map`, the main-window JS entry, and `asarUnpack` natives.
5. Energy numbers require a named Mac + Instruments; this Linux cloud checkout cannot produce them.
