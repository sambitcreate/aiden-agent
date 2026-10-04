# Renderer bundle and display polling — 2026-10-03

Branch `perf/renderer-bundle-polling`. Audit IDs UI-1–5, UI-14–19, MAIN-22/23 (from the 2026-10 whole-app audit). No persisted-format or Remote protocol change; `git:changed` is desktop-only and never forwarded to iOS/Android.

## Bundle (main-window startup closure, vite build)
- Baseline 3,328 KB JS (1,019 KB gzip) → 1,640 KB (509 KB gzip); dictation pill 475 → 234 KB.
- UI-1 `renderer/lib/syntax-highlight.ts`: hljs core plus per-language dynamic imports; aliases map to grammar modules. `highlightAuto` was dropped, so unlabeled fences render plain (owner decision).
- UI-3 `renderer/lib/markdown-math.ts`: remark-math/rehype-katex and the KaTeX CSS load only when a message contains math delimiters.
- UI-2 `router.tsx` `lazyRouteComponent` for non-chat routes; BrowserPanel and DevicesPanel are lazy.
- UI-4 `renderer/lib/ipc-bridge.ts` / `ipc-voice.ts`: the pill no longer pulls the `ipc.ts` parser graph.
- UI-5 `renderer/main/index.tsx` is a thin entry that issues startup reads, then imports `./app` (`startApp(startup)`). Source-grep startup tests now target `app.tsx`.

## Queries and polling
- UI-16 `createAppQueryClient` (`renderer/lib/query-client.ts`): staleTime 30 s, refetchOnWindowFocus off, retry 1; live surfaces opt back in.
- MAIN-22 `resolveGitExecutableMemoized` (`main/services/git-executable.ts`): keyed on binary/PATH/DEVELOPER_DIR, revalidated, 5 min TTL, failures uncached. Removes one `xcode-select` per Git command under a GUI PATH.
- MAIN-22 `main/services/git-repo-watcher.ts`: `fs.watch` on gitDir admin files, commonDir packed-refs and recursive refs (fallback refs/heads); debounced 250 ms, monotonic generation, evicted after 10 min unread. Started by `workspaces:gitInfo`, `git:review`, `git:pushCapability`; broadcasts `git:changed {workspaceId, generation}`.
- UI-17 `renderer/lib/git-query-sync.ts` (mounted in `root-view.tsx`): `git:changed` invalidates repository reads, `chats:settled` and throttled (5 s trailing) tool results invalidate working-tree reads, window activation restarts intervals and refetches stale reads. Git panels poll at 60 s only while the window is visible and focused (`gitSafetyPoll`).
- UI-18 PR status polls every 5 min; a repository change refreshes it only once it is ≥1 min old.
- UI-19/MAIN-23 `aidenRemoteSettingsQueryOptions(live)`: the always-mounted badge polls at 60 s while active, none while inactive; the open popover and Remote settings keep 10 s. No main-side Tailscale cache (deferred).
- UI-15 ModelPicker memoizes catalog entries on per-provider data references and derives list order/detail positions only while open. `useProvidersModelInfo` itself is untouched (owned by the MCP/network workstream).

## Deferred / skipped
- Repository discovery cache: kept at the 1 s TTL for the reasons in `git-display-read-performance.md`; the watcher removes the need for faster polling instead.
- UI-14 header `backdrop-filter`: kept. Without blur, 6% of sharp transcript text ghosts through the 94% surface; an opaque fill would stop matching the translucent window.

## Measurements
Git spawn counts per read (GUI PATH): info 12 → 6, review 28 → 14, pushCapability 46 → 23. Idle minute with the environment panel open: ~1,116 processes → ~43 focused, 0 blurred.
