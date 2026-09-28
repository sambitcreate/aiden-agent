# Foreground file tools: X03/X04/X05

Baseline: `a9baa4aa3027893e5455043083465c34b4c8b4ac`. Same macOS arm64 host,
Node 22.22.3, and clean `npm ci --ignore-scripts` dependencies (Pi **0.87.1**)
for both source-counter runs. No provider traffic, catalog fetch or user profiles.
These are deterministic filesystem counters and synthetic timings, not energy or
packaged UI latency measurements. Raw receipts: [before](before.json),
[after](after.json), [Electron runtime](electron.json).

| Fixture | Before | After |
| --- | ---: | ---: |
| 16 MiB read_file: actual bytes read | 16,777,216 | 200,001 |
| Same read: output characters | 200,014 | 200,014 |
| Already-aborted grep | Returns match; reads 7 bytes | Rejects; reads 0 bytes |
| 10,100-entry no-match scan: entries enumerated | 10,100 | 10,000, explicit incomplete notice |
| Wide list output | 200,989 characters | Bounded incomplete notice; over-cap directory omitted |

Grep has a 10 MiB aggregate input ceiling, including each overflow probe; tests
exercise growth after stat and exact byte counts. List/glob/grep have 10,000-entry,
5-second work limits; an over-cap directory is omitted for deterministic results.
Collection limits are 500/500/200 and search/list output is at most 20,000 chars.
Read_file retains its existing 200,000-byte content cap and truncation suffix,
but no longer returns a broken trailing UTF-8 character.

Native JavaScript regex semantics remain supported, including lookbehind and
backreferences. No RE2 fallback changes the accepted language. Patterns above
1,000 characters now fail explicitly; a pathological pattern stops at the search
deadline with an incomplete notice. A fixed-source worker receives model input as
data and is terminated/awaited on every exit. Four concurrent workers are allowed;
additional searches return a busy error. This adds roughly 17 ms per tiny grep on
the quiet fixture run (see raw samples), versus sub-millisecond baseline calls.
It provides cancellable matching and removes regex execution from Electron's main
thread. The worker is not retained between calls.

A foreground operation scope covers pending filesystem I/O as well as matching.
Cancellation rejects the caller promptly; the five-second search deadline returns
an explicit incomplete notice even if a syscall is still pending. An issued
kernel syscall cannot be cancelled in JavaScript: its owner keeps one of four
process-wide admission slots until the original operation and descriptor cleanup
settle. Late acquisitions close without another read, late errors remain observed,
and a failed close quarantines capacity rather than admitting unbounded work.
Worker termination begins on cancellation/deadline even while traversal is pending.
Deferred-I/O tests cover acquisition/read cancellation across all four tools,
concurrent and repeated cancellation, blocked cleanup, and capacity recovery.
A deadline while I/O is pending returns only the notice, without partial results.


Parent hidden-file/credential policy remains distinct from the stricter child
policy. Read_file still supports safe symlinks and metadata, excludes .env secrets,
and rejects outside-root targets. Grep retains hidden/symlink/dependency ignores.
Glob uses pinned minimatch 9.0.9 with Node fs.glob parser options. It tracks
segment positions and link traversal states without prematurely normalizing
`**/..`. Filesystem access stays on the bounded host. The first independent review
found gaps in a flattened-path matcher; the replacement has differential tests
for absolute paths, mixed absolute/relative brace arms, braces/extglobs, globstars, linked prefixes, linked wildcard
paths, and glob-dependent parent segments. Worker-engine fixtures also exercise
Windows drive and UNC roots with Windows path/parser semantics. Node traversal attribution is in
THIRD_PARTY_NOTICES.md.

Pinned Electron 43.1.1 / Node 24.18.0 smoke uses a bundled entry and real app main
process. It verifies native glob compatibility, JS lookbehind/backreferences,
six invalid-pattern failures and six catastrophic-pattern cancellations followed
by successful calls, deadline settlement, and zero retained worker message ports.
150 ms cancellation timers settled at 150–154 ms in the recorded run.

Reproduce counters (the temporary baseline copy stays in this worktree):

```sh
npm ci --ignore-scripts
git show a9baa4aa3027893e5455043083465c34b4c8b4ac:main/services/coding-tools.ts > main/services/.foreground-baseline.ts
npx tsx scripts/benchmark-foreground-file-tools.ts main/services/.foreground-baseline.ts
npx tsx scripts/benchmark-foreground-file-tools.ts
rm main/services/.foreground-baseline.ts
```

Run behavioral acceptance and the Electron smoke:

```sh
npx tsx --test main/services/coding-tools.test.ts main/services/generation-runtime.test.ts
npm run type-check
npx eslint main/services/coding-tools.ts main/services/coding-tool-matcher.ts main/services/coding-tool-glob-worker.ts main/services/foreground-read-scope.ts main/services/coding-tools.test.ts scripts/benchmark-foreground-file-tools.ts scripts/smoke-foreground-file-tools.ts
node node_modules/electron/install.js
npx esbuild scripts/smoke-foreground-file-tools.ts --bundle --platform=node --format=esm --packages=external --external:electron --outfile=build/main/foreground-file-tools-smoke.mjs
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/main/foreground-file-tools-smoke.mjs
```

The existing coding-tools test file is already in the root test chain and CI
registry. No shared server/native contract or transcript UI changed; no mobile
implementation or plan-status update is needed for these internal tools.
