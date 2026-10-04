# Aiden Agent optimization audit — 2026-10-03

Read-only audit of `origin/main` at `3f86d41af` (0.52.0) and the 9 open PRs (#299, #301–#307, #310).
Four parallel auditors covered: (A) open PRs, (B) main process / backend / packaging, (C) renderer perf and UX flow, (D) CLI, iOS, Android, Remote protocol and CI.
Nothing was edited. Findings marked *(unverified)* were not confirmed by measurement or a second read.

Baseline: [`docs/plans/performance-stability-efficiency-plan.md`](../plans/performance-stability-efficiency-plan.md) (July 2026, still "planned"). Several of its items were fixed piecemeal since; the status table in §9 records where each one stands.

**ID prefixes** — `PR-<n>-<k>`: open PR finding · `X-<k>`: cross-PR · `MAIN-<k>`: main process · `UI-<k>`: renderer/UX · `EXT-<k>`: CLI, mobile, protocol, CI.
**Impact / effort** — H / M / L, and S (≤ 1 day), M (a few days), L (a week or more).

---

## 1. Top 15, ranked by value ÷ effort

| # | What | IDs | Impact | Effort | Expected win |
|---|---|---|---|---|---|
| 1 | **Fix the approval-details privacy leak in #310 before it merges** | PR-310-1 | H (privacy) | S | `host-run-registry.ts:147-160` keeps raw approval `details`, bypassing the Remote `approvalDetails()` allowlist and exposing #303's classifier state to Remote clients. |
| 2 | **Stop shipping source maps, renderer-only deps, esbuild, `.d.ts`/`.ts`/docs in the asar** | MAIN-5, MAIN-6, MAIN-7, MAIN-9, UI-6 | H | S | About −180 MB packaged app (88 MB maps, ~70 MB renderer packages, ~20 MB esbuild, ~14 MB types/sources). |
| 3 | **Cut catalog-bot CI cost and over-triggering** | EXT-37, EXT-39 | H (cost) | S | ~5,500 job-min/month saved; 58 bot commits/month each run the full ~95 job-min CI plus a queued macOS release job. |
| 4 | **Debounce the Remote stream journal** (per-token clone + stringify + fsync of up to 16 MB) | MAIN-12, EXT-31, #310 | H | S | #310 already coalesces to 250 ms. Finish: flush on structural events, drop indentation, track bytes incrementally. |
| 5 | **MCP: cache `tools/list`, collect servers in parallel, add deadlines, await close, reuse clients** | MAIN-20, MAIN-21, PR-305-1, PR-307-1, PR-307-2 | H | S–M | Zero `tools/list` per warm turn; hung servers can't block generation; Ajv compile halved (46.2 → 22.5 ms/100 schemas). |
| 6 | **Create the window before the ~20 sequential startup awaits; lazy-load gated subsystems** | MAIN-1, MAIN-2, MAIN-3 | H | M | Hundreds of ms off cold launch (418 ms of eager externals measured; reconcile scales with chat count). |
| 7 | **Renderer bundle: highlight.js core + allowlist, lazy routes, on-demand KaTeX, split `ipc.ts`** | UI-1, UI-2, UI-3, UI-4 | H | S–M | Initial main-window JS is 3.41 MB (1.05 MB gz); hljs alone is 893 KB (31%). Pill stops loading a 471 KB shared chunk. |
| 8 | **Make chat list/meta index-only; stop whole-file pretty rewrites with inline base64** | MAIN-10, MAIN-11, MAIN-32, UI-22 | H | M–L | Removes the O(chats) parse on every append and list, multi-MB rewrites per append, and multi-MB IPC payloads. |
| 9 | **Stop ChatPane re-rendering ~60×/s while streaming; batch deltas in main** | UI-9, UI-10, UI-13, MAIN-30 | H | M | One IPC per token today, fanned out to N listeners; ChatPane, unmemoized rows and ScrollArea's ResizeObserver all churn per frame. |
| 10 | **Event-driven git refresh + memoized git executable; gate Tailscale and PR polling** | MAIN-22, MAIN-23, UI-17, UI-18, UI-19 | H (battery) | M | ~72 git spawns/min idle on one repo → near 0; Tailscale ~12 spawns/min → ~1. |
| 11 | **Quantize onboarding PNGs** | MAIN-8, UI-7 | M | S | 21 MB → under 5 MB, keeping the 1024² transparent PNG contract. |
| 12 | **Fix silent data-loss paths and consolidate durable writes** | MAIN-16, MAIN-17, MAIN-15 | M (durability) | S–M | Corrupt chats quarantined instead of vanishing; ~20 atomic writers → 1 `durable-fs.ts`. |
| 13 | **iOS / Android streaming hot paths** | EXT-9, EXT-10, EXT-25, EXT-26 | H (mobile battery) | S–M | Live Activity per token; O(n²) markdown reparse; O(n²) `_liveText += delta`; notification debounce never fires while streaming. |
| 14 | **Android basic navigation and lifecycle** | EXT-22, EXT-23, EXT-24 | H (UX) | S–M | Back exits the app (no `BackHandler` anywhere); Activity recreation leaks the coordinator; draft fsync on Main per keystroke. |
| 15 | **High-visibility UX defects** | UI-47, UI-57, UI-67, UI-32, UI-41, UI-24 | H (UX) | S | Stop discards queued messages; "Reset onboarding" wipes keys; wrong provider in voice error; raw IPC errors in 35 files; no retry on failure. |

---

## 2. Fix-now: correctness, privacy, data loss, AGENTS.md violations

These are not optimizations so much as defects found along the way. Each is small.

| ID | Finding | Location | Fix |
|---|---|---|---|
| PR-310-1 | Approval `details` retained in the host run registry bypass the Remote allowlist; leaks #303 classifier state to Remote clients. | `host-run-registry.ts:147-160` (#310) | Project through `approvalDetails()` before storing; add a behavioral test that a classifier field never reaches a Remote snapshot. |
| PR-299-1 | CLI `storeFor` takes the lease in `migrateAidenMcpConfig` before checking for a legacy file, so plain reads can throw "Another Aiden process owns…". | `packages/cli/src/mcp-config-migration.ts:19` (#299) | Check for the legacy file first; take the lease only when a migration is needed. |
| MAIN-16 | A corrupt chat file returns `null` and silently disappears; several DataStores overwrite corrupt files with defaults; pi-compaction `readIndex` swallows EIO and persists `{chats:{}}`. | `chat-store-core.ts:478-498`; `schedule-store.ts:5-6`, `usage-store.ts:11`, `tool-output-store.ts:59`, `models-dev-cache.ts:18`, `main-window-state.ts:12`; `pi-compaction-session-store.ts:763-788` | Make `preserveCorruptFile` the DataStore default; quarantine corrupt chats and surface a count; rethrow non-ENOENT in pi-compaction. Extend `data-store.resilience.test.ts`. |
| MAIN-40a | Brave, OpenAI and Tavily search adapters lack the `/\p{Cc}/u` control-character rejection the other 8 copies of `normalizedSourceUrl` have. | `web-search-brave-adapter.ts:88` and siblings | Shared `web-search-adapter-kit.ts`; behavioral URL tests. |
| MAIN-40b | `aiden-remote-approved-roots.ts` uses `startsWith("..")`, wrongly rejecting children named `..foo`. | `aiden-remote-approved-roots.ts:18` | Shared `isPathInside`/`assertPathInside` (45 inline copies today). |
| MAIN-40c | Peer-host reimplements safeStorage gating without the try/catch `secure-storage.ts` has. | `peer-host-service-main.ts:47-54` | Route through `secureStorage`. |
| MAIN-27 | Local model swap does `rm` then `rename` (a failed rename loses the model); a crash mid-install leaks ~620 MB; `stopDownloads` is never called on quit. | `local-models-core.ts:90-104`, `:206-227`, `:254-257` | Backup-rename swap; sweep stale staging at startup; export and call `stopDownloads`. |
| UI-57 | "Reset onboarding" wipes providers and API keys. | Settings | Reset only onboarding state; offer key removal as a separate, confirmed action. |
| UI-47 | Stop discards queued messages. | `chat-pane.tsx:2723-2726` | Keep the queue; Stop halts only the active generation. |
| UI-67 | An OpenAI voice-key error is reported as Gemini. | `dictation-operation-gate.ts:109-110` | Use the active provider's label. |
| UI-63 | Commit-mode radio cards have decorative borders (violates AGENTS.md). | Git commit panel | Communicate selection with the radio and background tokens only. |
| EXT-23 | Android has no `BackHandler`; back exits the app from any screen. | Android app | Add `BackHandler` per navigable screen with saveable nav state (pairs with EXT-22). |

---

## 3. Speed and resource use

### 3.1 Startup and bundle (desktop)

| ID | Finding | Location | Impact | Effort | Recommendation |
|---|---|---|---|---|---|
| MAIN-1 | Window is created after ~20 sequential awaits (stores, artifact recovery, `chatStore.list()` parsing every transcript, migrations, credential rotation, Remote init). | `main/index.ts:1668-2022` | H | M | Create the window and `loadURL` after settings + window state + protocol registration; run reconcile concurrently behind the existing admission gates; defer `pruneExpired` and artifact recovery past first paint. Add `performance.mark`s. |
| MAIN-2 | 742 modules statically reachable; 418 ms of eager externals (pi-ai 191, pi-agent-core 149, MCP SDK 112, electron-updater 88, @google/genai 82 ms…). 47 of 48 dynamic imports point at already-static modules. | `main/index.ts:1-151`, `main/handlers/index.ts`, `index.ts:1555-1557` | H | M | Lazy-import gemini-live, MCP SDK, electron-updater, bonjour, asset-discovery, tts/remark, telegram, computer-use, devices, form-fill behind stub IPC handlers. Target < 400 modules. |
| MAIN-3 | 326 KB Playwright injected source and ~300 KB Remote OpenAPI JSON imported eagerly. | `browser/service.ts:57`, `peer-response.ts:3` | M | S | Load from resources on first browser session; extract only needed schemas at build time. |
| MAIN-4 | Main bundle is unminified (7.0 MB; 3.6 MB minified) with a 12.9 MB map. | `scripts/build-electron.mjs:5` | M | S | `minify` (or whitespace + syntax) for packaged builds; external maps archived, not shipped; consider V8 compile cache *(unverified for Electron ESM main)*. |
| UI-5 | Renderer first paint waits on `getInfo` and `providersApi.list`. | `renderer/main/index.tsx:40-78` | M | S | Render the shell immediately; suspend only the parts that need the data. |
| UI-1 | highlight.js full build (893 KB, 31% of initial JS) plus `highlightAuto`. | `code-block.tsx:7` | H | S | Core + allowlisted languages, lazy-loaded; drop auto-detection. |
| UI-2 | No lazy routes; settings (319 KB) is in the initial chunk. | `router.tsx:9-18` | H | S | `lazy()` routes for settings, onboarding, devices, browser. |
| UI-3 | KaTeX (238 KB) loaded eagerly. | Markdown renderer | M | S | Load when a message contains math. |
| UI-4 | `ipc.ts` drags a 471 KB shared chunk into the pill window. | `renderer/lib/ipc.ts` | M | S | Split per-domain IPC modules. |
| UI-6 | Renderer sourcemaps shipped (see MAIN-5). | `vite.config.ts:22` | M | S | `sourcemap: "hidden"`, archive maps in CI. |
| — | Bundle has grown ~15% since July with no budget. | — | M | S | Add a bundle-size budget check in CI. |

### 3.2 Packaging size

| ID | Finding | Win | Effort |
|---|---|---|---|
| MAIN-5 | 6,069 `.map` files, 88.3 MB in the asar (27.4 MB ours, 60.9 MB from node_modules). | −88 MB | S |
| MAIN-6 | Renderer-only packages are prod `dependencies` (lucide-react 24.7 MB, three 11.4 MB, react-dom 7.3 MB, chart.js 5.9 MB, hljs 5.4 MB, plotly 4.9 MB, katex 4.0 MB…). Vite already bundles them. | ~−70 MB | S–M |
| MAIN-7 | esbuild + native binary (20.7 MB unpacked) ship only because `@earendil-works/chord` declares it; nothing reaches it at runtime (grep-verified). | −20 MB | S |
| MAIN-8 / UI-7 | 28 onboarding PNGs = 21 MB; two at the same contract are 14–46 KB, so quantization works. | −16 MB | S |
| MAIN-9 | 5.2 MB `.d.ts`, 8.6 MB `.ts`, READMEs, tests in node_modules. | −14 MB | S |
| EXT-46 | Duplicated PNGs in the repo. | small | S |

Add a packaging test that asserts no renderer-only package or `.map` file exists in the asar.

### 3.3 Chat storage and persistence

| ID | Finding | Location | Impact | Effort | Recommendation |
|---|---|---|---|---|---|
| MAIN-10 | `list()` and `updateMeta` (called on every append/rename/title) read and parse every transcript; a summary-only reader already exists but only Remote uses it. | `chat-store-core.ts:379-384`, `:638-655`, `:731-742` | H | M | Make `index.json` authoritative; patch one entry on write; point every list consumer at the summary path. |
| MAIN-11 | Each append rewrites the whole pretty-printed chat (base64 inline, up to 20×8 MiB images per message), ~3 readdirs and ~7 fsyncs, behind one global queue. | `chat-store-core.ts:113-125`, `:1135-1227`, `:569-593` | H | M–L | Content-addressed blob files for attachments; no pretty-print; per-chat queues + index lock; clean stages once at startup; memoize userData dir. Later: append-only JSONL. |
| MAIN-18 | Each turn re-reads the full chat several times and re-projects the whole history; draft context-pressure refresh does three full passes per keystroke with a 1.5 s TTL. | `llm-client.ts:488`, `context-pressure.ts:70,134,217`, `generation-context.ts:94-110,392-450`, `pi-agent-runtime-harness.ts:1437-1444` | M | M | LRU of parsed chats keyed by write version; cache projection by journal revision; invalidate via `invalidateChatContextJournal`; memoize tool-schema token counts. |
| MAIN-13 | Usage store does a full fsynced rewrite per model request; buckets grow forever; not corrupt-protected. | `usage-store-core.ts:424-490` | M | S | Map index, ~2 s debounce with quit flush, monthly roll-up, `preserveCorruptFile`. |
| MAIN-14 | Subagent run store v2 reads, validates and writes the whole DB as base64 over helper stdio per tool start/finish/usage event. | `subagent-run-store-v2-core.ts:437-447,668-685`, `subagent-run-store-io.ts:256-263` | M | M | In-memory authoritative copy with generation check; debounced upserts; no pretty-print. |
| MAIN-15 | Diagnostic journal runs `pruneExpired` (sync open/read/close per rotated file) and directory validation on every line. | `diagnostic-journal.ts:82-107,193-212,320-342,519-539` | M | S | Validate dir once; prune on rotation/timer; keep fd open; batch writes. |
| MAIN-19 | SQLite memory store is synchronous on main with `busy_timeout=5000`; `prepare()` per query. | `memory-store.ts:235-239,598-702` | L–M | M | Cache prepared statements; lower timeout or move to a worker. |
| MAIN-29 | Per-chat Maps never evicted (`ambientProfiles`, `journalSnapshots`, compaction `sessions`). | `context-pressure.ts:38,62,68`; `pi-compaction-session-store.ts:730` | L–M | S | LRU of 8–16 chats or release on close. |

### 3.4 Streaming and IPC (desktop)

| ID | Finding | Location | Impact | Effort | Recommendation |
|---|---|---|---|---|---|
| MAIN-30 | One `chat:delta` IPC per token; every subscriber gets its own `ipcRenderer.on` and filters by streamId; terminal sync slices a 1 MB string per delta. | `llm-client.ts:614-631,3149-3176`; `preload.ts:29-36`; `ipc.ts:1410-1430`; `chat-terminal-sync.ts:99-102` | M | S | Batch per stream at 16–33 ms; flush before tool/timeline/done; one listener + `Map<streamId, handler>`. |
| UI-9 | ChatPane re-renders ~60×/s while streaming. | `chat-pane.tsx:498`, `:1029-1048` | H | M | Streaming text in an external store read via `useSyncExternalStore`; `memo` the pane's static parts. |
| UI-10 | Message rows aren't memoized; a dep-less `useLayoutEffect` runs `querySelectorAll` every render. | Transcript rows | H | S | `memo` rows by id + version; scope the effect. |
| UI-11 | Full reveal reparse of the streaming message is O(n²). | Markdown reveal | M | M | Incremental parse: finalize completed blocks, reparse only the tail. |
| UI-12 | Open code fences are re-highlighted on every line. | `code-block.tsx` | M | S | Highlight on fence close; plain text while open. |
| UI-13 | ScrollArea rebuilds its ResizeObserver every frame. | `ui.tsx:819-1092` | M | S | Stable observer; ref-based callbacks. |
| UI-14 | Backdrop blur behind a 94%-opaque header. | Header | L | S | Drop the blur. |
| UI-15 | ModelPicker derives its lists while closed. | ModelPicker | L–M | S | Derive on open. |
| UI-16 | `new QueryClient()` with no defaults (refetch on focus, retry 3, staleTime 0). | `router.tsx:144` | M | S | Set sane `staleTime`, `retry`, `refetchOnWindowFocus`. |
| UI-20 | No windowing in transcript, sidebar or lists. | — | M | M | Virtualize long transcripts and the chat list. |
| UI-21 | Unstable context values re-render subtrees. | Providers | M | S | `useMemo` context values. |
| MAIN-31 | Terminal: each pty chunk copies a 200 K buffer, re-splits history and sends one IPC; server-detect regex on every chunk. | `terminal.ts:350-364`; `terminal-history.ts:248-261`; `browser/core.ts:215-235` | M–H | S–M | Chunk ring; cap in debounced flush; 8–16 ms coalescing; regex only on chunks containing `http`/`localhost`. |
| MAIN-32 / UI-22 | `chat:done`/`chat:error` and chat mutations return the whole chat including inline base64; timeline sends full snapshots per step; images rendered as data URLs. | `llm-client.ts:3690-3765`; `chats.ts:128-160,721`; `generation-timeline.ts:637-698` | M–H | M | Return the appended message + metadata and patch the query cache; timeline patches; serve attachments on demand via a protocol handler (pairs with MAIN-11). |
| MAIN-34 | Voice audio crosses IPC as base64 Float32 text (~25 MB copied 3× for 5 min). | `voice-recorder-core.ts:69-77,158-173`; `voice-codec.ts:12-17` | L–M | S | `Uint8Array` PCM16; typed-array decode. |
| MAIN-35 | Pi runtime event bus structured-clones each event 3+ times. | `pi-runtime-events.ts:146-185,225-254` | L | S | Clone once, freeze, share; filter by type at registration. |
| MAIN-33 | `providers:list` runs ~40 `checkAuth`s, each a credential read + synchronous decrypt, and embeds full model lists; `models:info` is one IPC per provider, each decrypting. | `provider-registry.ts:354-398`; `queries.ts:363-377`; `openrouter-benchmark-runtime-core.ts:215-220` | M | S–M | Read the credential doc once per list; memoize with event invalidation; batched `models:infoAll`; never decrypt for cache-only reads. |

### 3.5 Background work, battery, leaks

| ID | Finding | Location | Impact | Effort | Recommendation |
|---|---|---|---|---|---|
| MAIN-22 / UI-17 | Git info/comparison poll at 5 s, review 4 s, push 5 s against a 1 s main cache; 6 git spawns per read; `resolveGitExecutable` walks PATH (and spawns `xcode-select`) per command. | `queries.ts:385-434`; `git.ts:29,1180-1203,1526-1550`; `git-executable.ts:26-76` | H | M | Memoize executable; cache discovery; `fs.watch` `.git/HEAD`, `index`, `refs`, `packed-refs` and push invalidations; 60 s safety poll paused while hidden. |
| UI-18 | `gh pr view` every 30 s per expanded workspace. | `queries.ts` | M | S | Refresh on focus/push events; longer interval. |
| MAIN-23 / UI-19 | Always-mounted Remote popover spawns `tailscale status` + `serve status` every 10 s. | `chat-sidebar.tsx:1325`; `remote-connection-popover.tsx:97`; `queries.ts:627-635` | M | S | Poll only while popover/settings is open; cache 60 s; refresh on resume. |
| MAIN-20 | MCP `listTools()` per generation, serial across servers, no connect/list/call deadlines. | `mcp.ts:293-299,360-367,410-459` | H | S | Cache per connection generation (invalidate on `list_changed`); `Promise.allSettled`; 10 s / 5 s deadlines; skip a server's tools on timeout. |
| MAIN-21 | `void mcpManager.closeAll()` not awaited, closes serially; no idle expiry; generations Map never pruned. | `main/index.ts:315`; `mcp.ts:312-319`; `generation-bound-connection-cache.ts:74-81` | M | S | Parallel close awaited in shutdown (~2 s budget); idle expiry ~10 min. |
| MAIN-24 | Synchronous `ps` via `execFileSync` per subagent launch, retried up to 10×25 ms. | `subagent-inference-process.ts:298-372` | M | M | Async `execFile` or native `proc_pidinfo`. |
| MAIN-25 | Scheduled catch-up has no global concurrency, battery/lock policy, or resume re-evaluation. | `schedule-service-core.ts:128-200,294-360` | M | M | Semaphore of 2, staggering, defer on low battery/lock, re-evaluate on resume. |
| MAIN-26 | Telegram: no fetch timeouts, aborted long-polls leak sockets, one `editMessageText` per reasoning token. | `telegram-bot-api.ts:186-275`; `telegram-activity.ts:35-37,76-116` | M–H | S | `AbortSignal.any` with timeouts; gate thinking edits at ≥ 900 ms with a dirty flag. |
| MAIN-28 | `localVoice:status` forks the speech worker; PiP captures every 250 ms even when occluded; portable-config refresh on every window focus. | `parakeet.ts:141-150`; `browser/service.ts:1508`; `main/index.ts:2006-2010` | L | S | Answer from main state; pause when hidden; debounce/mtime check. |
| — | Transcription and Telegram fetches lack deadlines (prior-plan P1 residue). | `transcription.ts:87,136` | M | S | Same timeout pattern as web search. |

---

## 4. Open PRs

### 4.1 State and merge plan

- **Stack:** #299 → #302 → #301 → #304 → #303 → #306 → #305 → #307, all based on stale main `2681471de`. #310 is independent on current main. All 9 are green on their current heads.
- **Conflicts:** #307 and #310 both touch `aiden-remote-streams.test.ts` and `scripts/ci-test-registry.json` — resolve by union.
- **Recommended order:**
  1. Fix PR-310-1, then merge #310.
  2. Merge `origin/main` into #299 (no rebase), regenerate the lockfile with `npm install`.
  3. Cascade merges down the stack; merge each only when CI is green on its exact new head.
  4. After #310 lands, rerun `test:aiden-remote` on #303 and re-check the Remote protocol revision (claim the next one at merge time, update iOS, Android and fixtures together).
- **Restructure:**
  - Split #302 into (a) codemode/discovery, (b) MCP OAuth/images, (c) OpenAI login.
  - Fold #307's Model Freedom e2e rewrite into #303.
  - Consolidate the onboarding copy edits scattered across PRs (X-6).
- **Hotspot (X-4):** `llm-client.ts` is touched by 8 of 9 PRs. Extracting `prepareGeneration` (~900 lines) and the stream loop (see §6) after this stack lands would stop it being a perpetual conflict source.

### 4.2 Per-PR optimizations

| ID | PR | Finding | Impact | Effort | Fix |
|---|---|---|---|---|---|
| PR-299-2 | #299 | Legacy harness alias pulls a duplicate pi-ai/openai/genai graph (~50 MB *(estimate)*). | M | S | Alias to the single installed copy or drop the legacy path. |
| PR-302-1 | #302 | O(n²) work in nested tool calls. | M | S | `pi-agent-runtime-harness.ts executeNestedToolCall`: index instead of rescan. |
| PR-302-2 | #302 | Codemode redundancies. | L | S | Collapse duplicate passes. |
| PR-302-3 | #302 | Per-tool discovery metadata duplicates server instructions (~4 MB per 512-tool server). | M | S | Store instructions once per server; reference from tools. |
| PR-302-4 / X-1 | #302 + others | Three duplicate bounded JSON cloners. | L | S | One shared helper (fits `main/shared/guards.ts`, MAIN-40). |
| PR-302-5 | #302 | Base64 decode → re-encode roundtrip. | L | S | Pass through when already encoded. |
| PR-301-1 | #301 | Pi compaction defaults hard-coded (16,384 / 20,000). | M | S | Derive from model context window. |
| PR-301-2 | #301 | Partial override may tighten the budget *(unverified)*. | M | S | Merge overrides field-wise; add a test. |
| PR-301-4 / X-3 | #301 + others | `getSettings` on every context-pressure call; no per-generation config snapshot. | M | S | Snapshot settings once per generation and pass it down. |
| PR-301-5/6, X-7 | #301 | Memory settings page becomes a catch-all for compaction/caching. | M (UX) | S | New "Context & caching" section (ties into UI-55, UI-58). |
| PR-304-1 | #304 | Cache warming `structuredClone`s the full transcript and sha256s it on every request, even when disabled, and retains it 60 min. | H | S | Short-circuit when disabled; hash incrementally or by message ids; bounded retention. `pi-cache-warming.ts:122-129`. |
| PR-303-2 | #303 | Each image reference decoded 3 times. | M | S | Decode once, pass the buffer. |
| PR-303-3 | #303 | `inventory()` re-reads the chat per image. | M | S | Read once per call. |
| PR-303-4 | #303 | `listProviders` on every prepare. | M | S | Use the generation snapshot (X-3) or memoized list (MAIN-33). |
| PR-306-1 | #306 | Sequential `getProvider` per model. | L–M | S | `Promise.all` or batch lookup. |
| PR-305-1 | #305 | New MCP Client handshake per auth operation. | M | S | Reuse the connection cache (pairs with MAIN-20/21). `mcp-provider-auth-core.ts:84-114`. |
| PR-305-2 | #305 | ~6 config + keychain reads per connect. | M | S | Read once per connect. |
| PR-307-1 | #307 | New Ajv per tool schema, compiled eagerly per generation, duplicating the SDK's compile (46.2 vs 22.5 ms/100 schemas). | M | S | One Ajv instance; compile lazily on first call; or reuse the SDK validator. |
| PR-307-2 | #307 | Tool inventory not cached. | M | S | Cache by tool-set identity (pairs with MAIN-20). |
| PR-310-2 | #310 | One journal event per token, so the 4,096-event cap forces `snapshot_required` on late observers. | M | S | Coalesce deltas into one event per window (also MAIN-12). |
| PR-310-4 | #310 | Array copy just to find the last element. | L | S | `findLast`. |
| PR-310-6 | #310 | Test loads source via esbuild + `new Function`; brittle. | L | S | Import the module normally. |

---

## 5. UX flow

### 5.1 Onboarding and setup

| ID | Finding | Recommendation |
|---|---|---|
| UI-24 | Next is disabled with no explanation (`onboarding-flow.tsx:597-603`). | Inline reason under the button. |
| UI-25…31 | Onboarding friction and accessibility issues; UI-27 (bento tiles not focusable) is fixed by #307. | Address the rest after #307 lands. |
| UI-39 | No-provider empty state is a dead end. | Primary action to add a provider. |
| UI-42 | Inconsistent setup wording across onboarding and settings. | One glossary. |
| X-6 | Onboarding copy creep across PRs. | Consolidate in one copy pass. |

### 5.2 Chat, generation and approvals

| ID | Finding | Recommendation |
|---|---|---|
| UI-40 | A failed chat load looks like an empty new chat. | Error state with retry. |
| UI-41 | "Generation failed" offers no retry or regenerate. | Retry and regenerate actions. |
| UI-47 | Stop discards queued messages. | See §2. |
| UI-48 | Approvals steal focus while the user is typing (`chat-pane.tsx:2314-2323`). | Announce, don't focus, when the composer has focus. |
| UI-49…51 | Approval and ask-user flow rough edges. | — |
| UI-52…54 | Model switching friction; model selection is app-wide rather than per chat. | Per-chat model with app-wide default. |
| UI-43 | Transcript accessibility gaps. | Roles, live-region throttling. |
| UI-44…46 | Attachment flow issues. | — |
| UI-77 | Missing shortcuts; Escape doesn't stop generation. | Escape = Stop when the composer is empty/focused. |
| UI-78 | Blocked-send toasts instead of inline reasons. | Inline composer hint. |
| UI-32 | Raw "Error invoking remote method…" text shown across 35 files. | Normalize errors once in the preload. |

### 5.3 Settings, sidebar, git, voice, devices

| ID | Finding | Recommendation |
|---|---|---|
| UI-55 / UI-56 | 18 settings sections and no search. | Regroup (fold in "Context & caching", X-7) and add settings search. |
| UI-57 | Reset onboarding wipes providers and keys. | See §2. |
| UI-58 / UI-59 | Settings pages drift from the settings design system. | Align to `docs/settings-design-system.md`. |
| UI-33…38 | Provider settings friction. | — |
| UI-60 | Chat row actions are right-click only. | Hover/focus overflow button. |
| UI-61 | Dialogs don't submit on Enter. | Form semantics. |
| UI-62 | Delete and rename fail silently. | Error toast + rollback. |
| UI-63 | Decorative borders on commit-mode radio cards. | See §2. |
| UI-64…66 | Git panel rough edges. | — |
| UI-67…72 | Voice: wrong provider name, no microphone-permission deep link, pill error disappears after 2 s. | Fix label, deep link to System Settings, persistent error until dismissed. |
| UI-73 | Devices and Browser panels can spin forever. | Timeouts with error/retry states. |
| UI-74 | One-click destructive actions. | Confirm or undo. |
| UI-75 / UI-76 | Devices accessibility. | — |

---

## 6. Code health and architecture

| ID | Finding | Recommendation | Effort |
|---|---|---|---|
| MAIN-17 | ~20 hand-rolled atomic writers, 8 byte-identical `syncDirectory` copies; several skip fsync or use fixed `.tmp` names. | `main/services/durable-fs.ts` with one fault-injection suite. | M |
| MAIN-40 | Duplicated security helpers: path containment (45), URL normalization (11), redactors (5), bounded body readers (6), `isRecord` (53), `exactKeys` (20); manual fetch timeouts in 12 files; 5+ abortable sleeps. | Shared helpers with behavioral tests. | M |
| MAIN-39 | Unwired code: `background-subagent-coordinator-v2.ts` (391 lines, test unregistered), orphan smoke test, durable-jobs groundwork, v1 run store kept as rollback; 107 dead exports + 64 test-only. | Register or delete; set v1 removal date; knip as dev-only CI check. | S |
| X-4 / Large files | `git.ts` 6,665 · `aiden-remote-protocol.ts` 5,352 · `llm-client.ts` 4,106 · `aiden-remote-router.ts` 3,003 · `pi-agent-runtime-harness.ts` 2,830 · `browser/service.ts` 2,486 · `main/index.ts` 2,054 · `chat-pane.tsx` 2,967 · composer 2,526 · `AidenChatFeature.swift` 7,589. | Split behind facades: `git/{runner,review,commit,push,compare,managed-worktrees}`; per-resource protocol/router modules; `llm-client` → admission / prepare-generation / stream loop; `main/index.ts` → lifecycle / windows / service-bootstrap. Do this after the PR stack lands. | L |
| EXT-35 | Remote protocol revision churned 9 → 18 in ~2 months; projection logic duplicated across desktop, iOS, Android. | Shared behavior fixtures driving all three clients. | M |
| EXT-34 | Android contract fixture is a hand-copied duplicate. | Gradle `srcDir` pointing at `protocol/`. | S |
| EXT-7 | Vendored advisor copies may be removable now that `aidenRelativeTsRewritePlugin` exists *(unverified)*. | Try importing originals directly; drop the drift test if it works. | S |

---

## 7. CLI (`packages/cli`)

| ID | Finding | Impact | Effort | Recommendation |
|---|---|---|---|---|
| EXT-1 | pi-ai bundled twice (e.g. `bedrock-converse-stream.js` 903 KB ×2). | M | S | Dedupe via shared chunk / alias. |
| EXT-2 / EXT-45 | dist is 46 MB, not the 16 MB logged: `model-capabilities.json` 8.9 MB pretty-printed, `subagent-worker.js` 8.4 MB, plotly 4.7 MB, docs PNGs. | M | S | Minify JSON, exclude docs images, lazy-load plotly; fix the size log. |
| EXT-3 / EXT-4 | Worker outside the shared chunk graph; advisor runtime emitted twice. | M | M | Single esbuild graph with shared chunks. |
| EXT-5 | `--version` takes 0.31–0.35 s vs 0.03 s Node baseline — ~328 ms of module evaluation before argv parsing. | M | S | Fast-path `--version`/`--help` before importing the runtime; lazy imports. |
| EXT-6 | SQLite ExperimentalWarning on every run. | L | S | Suppress that specific warning. |
| EXT-8 | Docker image ships devDependencies. | L | S | Multi-stage build with `npm ci --omit=dev`. |

## 8. Mobile

### iOS

| ID | Finding | Location | Impact | Effort |
|---|---|---|---|---|
| EXT-9 | Live Activity updated on every token. | `AidenChatFeature.swift:3374`, `AidenRemoteLiveActivityManager.swift:232-245` | H | S — throttle to ~1/s and on state changes. |
| EXT-10 | O(n²) markdown reparse; `chronologicalRows` computed 5–7× per render. | Chat feature | H | M — cache rows; parse completed blocks once. |
| EXT-11 | Every foreground (and `.inactive`) triggers a refetch storm. | App lifecycle | M | S — `.active` only, debounce, conditional fetch. |
| EXT-12 | Progress fetched 3× per open, fixed 1 s retry. | — | M | S |
| EXT-13 | Keychain read before the cache. | — | L–M | S |
| EXT-14 | `waitsForConnectivity` + 1 h resource timeout. | `AidenRemoteClient.swift:2056-2068` | M | S — bounded timeouts. |
| EXT-15 / EXT-16 | Unbounded cache; session leaks. | — | M | S |
| EXT-17 | Backoff without jitter (also Android). | — | L | S |
| EXT-18 | Animations at 120 Hz. | — | L | S |
| EXT-19 | SSE parser reads byte by byte. | — | M | S — buffered line reader. |
| EXT-20 / EXT-21 | `AidenChatFeature.swift` 7,589 lines; LazyVStack issue *(unverified)*. | — | M | L |

### Android

| ID | Finding | Impact | Effort |
|---|---|---|---|
| EXT-22 | Activity recreation leaks the coordinator and OkHttp client; nav state not saveable. | H | M |
| EXT-23 | No `BackHandler`; back exits the app. | H | S |
| EXT-24 | Disk I/O and fsync on Main; draft saved on every keystroke. | M | S — `Dispatchers.IO`, debounced draft save. |
| EXT-25 | `_liveText += delta` is O(n²); Regex compiled every composition. | H | S — `StringBuilder`; hoist regexes. |
| EXT-26 | `debounce(400)` never fires while streaming. | M | S — `sample`, `setOnlyAlertOnce`. |
| EXT-27 | `versionCode=1`, no R8, unused dependencies. | M | S |
| EXT-28 | No `@Immutable`; 97 `collectAsState` vs 0 `collectAsStateWithLifecycle`. | M | S |
| EXT-29 / EXT-30 | No Gradle caches in CI; large files. | L–M | S–L |

### Remote protocol / server

| ID | Finding | Impact | Effort |
|---|---|---|---|
| EXT-31 / MAIN-12 | Stream journal persists the full pretty snapshot per token (partly fixed by #310). | H | S |
| EXT-32 | No gzip, no ETag/304. | M | S |
| EXT-33 | Progress endpoint ignores `after`. `aiden-remote-chat-progress.ts:405-510` | M | S |

---

## 9. CI, build and dev loop

| ID | Finding | Impact | Effort | Recommendation |
|---|---|---|---|---|
| EXT-37 | 58 catalog-bot commits/month each run full CI (~95 job-min) plus a macOS release job queued ~37 min. | H | S | Path-filter catalog-only commits in `ci-changes.mjs` and `release.yml` `paths-ignore`; ~5,500 job-min/month saved. |
| EXT-39 | `ci-changes.mjs` over-triggers: `.memory/`, `packages/cli`, `protocol` each fan out everything. | H | S | Map paths to the suites they affect. |
| EXT-38 | Linux jobs run on every PR, ungated and not required; Linux x64 (15–20 min) is the wall-time tail. | M | S | Gate on relevant paths or run on main/nightly. |
| MAIN-38 / EXT-41 | Four full macOS builds per run (3 e2e shards + verify). | M | S | One build job, share `build/` as an artifact. |
| EXT-42 | iOS compiles twice, no cache. | M | S | Build once, `test-without-building`; DerivedData cache. |
| EXT-40 | macOS queueing; 60% of PR runs cancelled. | M | S | Concurrency groups by PR; fewer pushes trigger full fan-out (EXT-39). |
| EXT-43 | Main fails 31% of pushes (33 ✓ / 15 ✗), with named flakes: iOS simulator, `guided-setup.spec.ts:42`. | H | M | Treat each named flake as a bug per AGENTS.md; fix the root causes. |
| EXT-44 / MAIN-37 | `npm test` is one serial chain: 68 nested `npm run`s, 54 `tsx --test` processes, 106 duplicate test-file runs. | M | S–M | Use the existing lane runner in parallel; collapse tsx invocations; dedupe. |
| MAIN-36 | Native helpers rebuild unconditionally ~32× across scripts. | M | S | Hash-stamp skip; one parallel `build:native`. |
| EXT-47 | Local repo: 8.24 GB unreachable pack, 224 branches, 33 worktrees. | L | S | `git gc --prune`, prune merged branches and clean worktrees (only those with nothing unpushed). |
| EXT-48 | 5 plans missing from `docs/plans/README.md`. | L | S | Index them. |

### Prior-plan status (in-scope items)

| Item | Status |
|---|---|
| P0 chat-store atomic writes | Partial — chat-file corruption not quarantined (MAIN-16). |
| P0 global queue / pretty rewrite / inline base64 | Open (MAIN-11). |
| P0 data-store defaults on read failure | Partial (MAIN-16). |
| P0 attachment budgets | Fixed. |
| History over IPC | Fixed. |
| P1 git polling | Open (MAIN-22). |
| P1 local voice off main | Fixed (residual MAIN-28). |
| P1 tool stop/cancel | Partial (Telegram, transcription). |
| P1 MCP single-flight / cache / expiry / close | Partial (MAIN-20, MAIN-21). |
| P1 renderer crash loop | Fixed (no safe-mode UI). |
| P1 local model install | Mostly fixed (MAIN-27). |
| P1 scheduled catch-up | Partial (MAIN-25). |
| P2 per-provider model info | Partial (MAIN-33). |
| P2 startup provider enumeration | Partial (MAIN-33). |
| P2 delta / terminal IPC | Open (MAIN-30, MAIN-31). |
| P2 packaged sourcemaps | Open and worse: 88 MB (MAIN-5). |
| Renderer: streaming rAF loop, lazy terminal | Fixed. |
| Renderer: git polling, streaming copies, data-URL images | Partial. |
| Renderer: open fences, closed picker, per-provider IPC, startup gating, lazy routes/KaTeX/hljs, windowing, QueryClient defaults, bundle budget | Open. |

---

## 10. Suggested sequencing

**Wave 0 — this week, alongside the PR merges (all S)**
PR-310-1, PR-299-1, PR-304-1, PR-307-1/2, PR-305-1; the §2 defects; EXT-37/39 CI path filters.

**Wave 1 — cheap, large wins (S)**
Packaging exclusions (MAIN-5/6/7/9) with an asar test; PNG quantization (MAIN-8); hljs/lazy routes/KaTeX (UI-1/2/3); QueryClient defaults (UI-16); Tailscale gating (MAIN-23); MCP cache + deadlines + close (MAIN-20/21); Remote journal debounce completion (MAIN-12); Telegram timeouts and edit throttle (MAIN-26); iOS Live Activity throttle (EXT-9); Android back + `StringBuilder` + `sample` (EXT-23/25/26); CLI `--version` fast path and dedupe (EXT-1/2/5).

**Wave 2 — the hot paths (M)**
Startup reorder + lazy subsystems (MAIN-1/2/3, UI-5); streaming pipeline end to end (MAIN-30, UI-9/10/11/12/13); event-driven git (MAIN-22, UI-17/18); credential fan-out + per-generation config snapshot (MAIN-33, X-3, PR-301-4, PR-303-4); durability consolidation (MAIN-15/16/17); CI build sharing and parallel test lanes (MAIN-36/37/38, EXT-41/42/44); UX pass on §5.2 (retry, errors, focus, Escape).

**Wave 3 — structural (M–L)**
Blob attachment storage + index-only chat list + slim IPC payloads (MAIN-10/11/32, UI-22); transcript windowing (UI-20); shared protocol behavior fixtures (EXT-35); large-file splits (llm-client first, X-4); settings regroup + search (UI-55/56, X-7); mobile refactors (EXT-10, EXT-20, EXT-22).

## 11. How to measure

Add these once, before Wave 1, so every change has a before/after:

- `performance.mark` at `whenReady`, `createMainWindow`, `ready-to-show`, first renderer IPC; cold launch with 0 / 200 / 1,000 chats.
- `app.asar` and DMG size; renderer initial JS (raw + gzip) budget in CI.
- `appendMessage` p50/p95 and bytes written on a 500-chat image-heavy profile.
- IPC messages per generation; renderer long tasks and React commit count at ~200 tok/s.
- Idle git + tailscale spawns per minute; Activity Monitor energy impact.
- `tools/list` count per warm turn; a fake MCP server that never answers `initialize`.
- Event-loop delay p99 (`monitorEventLoopDelay`) during a Remote stream and a subagent fan-out.
- CI job-minutes per run and per month; main-branch pass rate.
- CLI `--version` wall time; dist size.

## 12. Caveats

- Startup numbers are component measurements (import timings, bundle sizes), not end-to-end packaged launch profiles.
- Packaging numbers come from the installed 0.51.0 app.
- Not deep-audited: child-process sites in `external-editors.ts`, `github-pull-request.ts`, `computer-use/*`, `devices/*`, `form-fill`, `schedule-script.ts`, `workspace-files.ts`; several heartbeat timers.
- *(unverified)* items: PR-299-2 size, PR-301-2, MAIN-4 compile cache, MAIN-7 runtime reachability (grep only), EXT-7, EXT-21.

## 13. Implementation status (2026-10-03)

Fix pass complete. Every branch below is pushed; none has an open PR and nothing is merged. Each branch's own `.memory/` note has per-finding detail.

| Branch | Head | Done | Partial / deferred |
|---|---|---|---|
| `feat/multi-machine-control-plan` (follow-up to merged #310) | `07919a2ca` | PR-310-1/2/4/6, MAIN-12 | — |
| `perf/cli-bundle-startup` | `a7386dc18` | EXT-1/2/3/4/5/6/7/8/45 | Docker image not built. `--version` 343 → 34 ms; dist 46 → 25 MB |
| `perf/ci-efficiency` | `2665826b9` | EXT-29/37/38/39/40/41/42/44/48, MAIN-37/38 | EXT-43 (only the Tailscale flake fixed). `npm test` 341 → 201 s |
| `perf/storage-durability` | `510cf9c59` | MAIN-10/16/17 | MAIN-11 partial; MAIN-13/14/15/19/27/29 not started. Warm list 62 → 0.17 ms |
| `perf/mcp-network-background` | `65e317027` | MAIN-20/21/24/25/26/28 | MAIN-33 deferred |
| `perf/renderer-bundle-polling` | `57ad10c19` | UI-1/2/3/4/5/15/16/17/18, MAIN-22 | UI-19, MAIN-23 partial; UI-14 skipped. Startup JS 3.3 → 1.6 MB |
| `perf/packaging-size` | `8ae5d27dd` | MAIN-4/5/6/7/8/9/36, UI-6 | asar 239 → 88 MB; .app 599 → 429 MB |
| `perf/startup-path` | `6d47046a6` | MAIN-1 | MAIN-2/3 partial. Window shown 1342 → 925 ms |
| `perf/streaming-render` | `a39dc8508` | MAIN-30/31/35, UI-10/11/12/13/21 | MAIN-18/34, UI-9 partial; MAIN-32, UI-20/22 deferred |
| `perf/remote-server` | `7f0f504d3` | EXT-32/33 (server side) | Clients don't send If-None-Match or `after` yet; EXT-35 deferred |
| `perf/ios-streaming` | `a28a1f7c3` | EXT-9/10/12/13/14/16/17/18/19 | EXT-11/20 partial; EXT-15 deferred; EXT-21 skipped |
| `perf/android-lifecycle-streaming` | `b0085e787` | EXT-17/22/23/24/25/26/27/28/34 | Needs an on-device smoke test; release CI must pass `-PaidenVersionName` |
| `refactor/code-health-helpers` | `59923b74f` | MAIN-39 | MAIN-40 partial |
| `ux/chat-approvals-onboarding` | `7b8723068` | UI-24/25/30/32/39/40/44/47/48/51/67/69/77/78 | UI-31/41/42/43/49/50/52 partial; UI-26/28/29/45/46/53/54/68/70 deferred |
| `ux/settings-sidebar-devices` | `710eb3ab0` | UI-35/36/37/38/56/57/63/64/65/73/74/75/76 | UI-61/62/66 partial; UI-33/34/55/58/59/60 deferred |
| Pi 1.0 stack #299–#307 (existing PRs, updated) | see PRs | PR-* findings | 301-6/X-7, 304-3/4/5, 305-1/3, 302-2 deferred; split #302 into three |

### Integration hazards
- The CLI branch deletes `packages/cli/src/vendor/advisor/`, but the storage branch edits `vendor/advisor/data-store.ts`. Drop that hunk; the CLI now imports `main/services` directly.
- Add startup's lazy `electron-updater` to the hand-list in `scripts/main-runtime-dependencies.test.mjs` (packaging).
- Re-baseline the bundle budget after the renderer-bundle and streaming merges.
- Overlapping files:
  - `code-block.tsx`: streaming and renderer-bundle.
  - `main/index.ts`: startup and MCP.
  - `git.ts`: code-health and renderer-bundle.
  - `composer.tsx`: both UX branches.
  - `ui.tsx`: settings UX and #311.
  - `about-settings.tsx`: settings UX and storage.
  - `settings-view.tsx`: settings UX and renderer-bundle.
- Most branches touch the `package.json` test chain and `scripts/ci-test-registry.json`. Resolve by union.
- Point the AGENTS.md hotspot note at `test:serial`. The CLI branch removed the vendored-advisor bullet.

### Baseline failures on main (pre-existing, uninvestigated)
- aiden-remote-files
- workspace-files
- generative-ui-extension
- subagent-run-store-core
- pi-compaction-core (4)
- git.test managed-worktree (15)
