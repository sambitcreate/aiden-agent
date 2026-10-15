# GitHub rate limits and PR reads (P0) — 2026-10-07

Branch `cursor/github-rate-limit-p0-aa2a`, PR #378. Patterns adapted (not copied) from T3 Code.

## Shape
- `main/services/github/`: `github-api.ts` (direct REST/GraphQL transport), the credential source
  (`gh auth token` is only a token source; the token never leaves that module, IPC, cache keys or logs),
  `github-rate-limit.ts` + `github-request-gate.ts` (one gate for every request).
- `github-runtime-main.ts` owns the singletons; handlers import from it.
- PR reads: `github-local-repository.ts` resolves owner/name/branch/head owner/tracking SHA from local git
  config (no network). `github-pull-request-graphql.ts` builds aliased batch documents with values in
  variables. `github-pull-request-reader.ts` (`BatchedPullRequestReader`) coalesces within 15 ms, dedupes,
  shares in-flight reads and caches by entry key + version (head SHA). Failures are never cached.
- `gh pr create` is still the create path (REST create is P1); read-back goes through the API.

## Invariants
- The governor refuses every request, interactive included, until `retryAt`. Never retry earlier.
- Budget comes from response headers / injected `rateLimit`, never from REST `/rate_limit`.
- Background reads leave a 10% GraphQL reserve for interactive calls.
- Typed `rate-limited` availability with `retryAt` flows to the renderer. Chat PR refresh returns
  `rateLimitedUntil` and notifies only on real snapshot changes (ignoring `syncedAt`).
- Renderer stretches polling past `retryAt` and keeps the last PR status while paused
  (`renderer/lib/github-pause.ts`). The UI says "GitHub paused until <time>".
- Mobile clients have no PR/GitHub status consumers; the new union value is desktop-only.

## Measurement
`github-replay.test.ts` replays a scripted 30-minute session against `FakeGitHub`.
Baseline (pre-change code with a counting gh runner): 73 calls, 4 notifications.
After: 19 calls (-74%), 4 notifications. The test asserts <=30% of baseline.

## Deferred (P1)
Background sync, ETags/conditional requests, agent PR watcher, REST PR create, diagnostics IPC usage
snapshot (the ledger already logs a 10-minute summary to the journal).
