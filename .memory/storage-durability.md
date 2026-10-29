# Storage durability and chat-store performance — 2026-10-03

Branch `perf/storage-durability`, from the main-process optimization audit (MAIN-10/11/16/17).

## Durable writes (MAIN-17)
- `main/services/durable-fs.ts`: `writeFileAtomic` / `writeJsonAtomic` stage a unique dot-prefixed sibling, fsync, rename (or hard-link with `exclusive`), then fsync the directory. `fsync: false` is only for regenerable caches.
- New stores should use these helpers, not hand-rolled `.tmp` + rename sequences.

## Unreadable-file preservation (MAIN-16)
- DataStore `preserveCorruptFile` now defaults on: an unreadable store file is copied to `.invalid-<stamp>-<rand>` before defaults are used. Regenerable caches opt out explicitly (OpenRouter benchmarks, models.dev cache, portable-config, main-window state).
- The vendored CLI copy `packages/cli/src/vendor/advisor/data-store.ts` must mirror it (header kept, `.ts` import rewrites).
- Chat payloads (`chat-store-core.ts`):
  - A payload that fails `JSON.parse` or is not an object with a `messages` array is renamed aside intact to `.<id>.json.<uuid>.corrupt`, the directory is fsynced, and the index entry is dropped (owner reads only).
  - An id-mismatched payload is NOT quarantined; it just reads as missing.
  - `quarantinedPayloadCount()` feeds `diagnostics:status` → `quarantinedChats`, which Settings → Diagnostics shows as a notice (`quarantinedChatsNotice`).
  - `createWithFirstMessage` reads with the `"pure"` policy and rejects a draft ID whose bytes are either still in place or already quarantined. Never let a new draft reuse an ID with preserved bytes.
- Pi journal index (`pi-compaction-session-store.ts`):
  - A missing file reads as empty.
  - Torn or malformed bytes are copied to `.aiden-journal-index.json.<sha16>.corrupt` (content-addressed, exclusive create) before the next mutation replaces them.
  - Any other read error is rethrown (fail closed).
  - Writes use `writeFileAtomic`.

## Chat store concurrency and index (MAIN-10, MAIN-11)
- Locks: there is no global queue any more.
  - Keyed mutex: per-chat locks, plus `INDEX_LOCK`.
  - Lock order is always chat locks (sorted) first, then the index lock.
  - `copyVisibleHistory` locks both source and new ID. `create` computes the ID before locking.
- Exclusive maintenance waits for in-flight shared ops to drain. It runs only when needed:
  - first init
  - after a failed `writeChatAndMeta` (`reconcileNeeded`)
  - pending directory-sync retry
  - when the index memo is null

  Maintenance does the crash-left stage sweep (startup only), transaction reconcile, and the index read.
- The index memo is the authoritative list:
  - `list()` and meta updates read the memo. A bigint stat stamp (`ino:size:mtimeNs:ctimeNs`) is re-checked at each index-needing op, so external edits force re-verification.
  - Operational payload read errors under the owner policy invalidate the memo.
- Read policies:
  - `owner` migrates, quarantines, and fixes the index.
  - `exclusive` is used by maintenance and reconcile.
  - `pure` never writes.
- Payloads and the index are written as compact JSON. Legacy indented files still load and get rewritten compactly on the next mutation.
- Benchmark (500 chats × 20 messages, local SSD):

  | Measurement | Before | After |
  |---|---|---|
  | Cold `list` | 75 ms | 63 ms |
  | Warm `list` | 62 ms, 501 reads | 0.17 ms, 0 reads |
  | `appendMessage` | 72 ms, 502 reads | 8 ms, 1 read |
  | 20 parallel appends to different chats | 1391 ms | 78 ms |

## Deferred design note — blob attachments (MAIN-11)
- Today, attachment data lives inline in chat JSON, so every append rewrites it.
- Proposal:
  - Content-addressed blobs under `chats/blobs/<sha256[0:2]>/<sha256>`, written via `writeFileAtomic({ exclusive: true })`. EEXIST counts as success.
  - Messages keep `{ blob: sha256, size, mime, name }`.
  - Reads resolve lazily for renderer/IPC.
  - GC is a startup-only mark-and-sweep over all chat payloads plus Pi journals, with a grace window (skip blobs newer than 24 h) so in-flight writes are never collected.
- Migration: dual-read (inline or blob), and write blobs only for new attachments. Do not rewrite old chats eagerly.
- Needs Remote protocol and mobile consumer review before landing, because summaries and transcripts may embed attachment data.

## Done on `claude/audit-fix-persistence-cpu` (2026-10-29)
- MAIN-15: the diagnostic journal batches every line queued during one drain into a single append, caches directory validation, and prunes expired rotations only when due. No persistent fd: batching gets the CPU win and keeps the rename/delete semantics.
- MAIN-13 (partial): the usage store indexes buckets in a Map and coalesces saves for 2 s (unref'd timer, compact JSON). `usageStore.flush()` joins the quit flush in `main/index.ts`. The CLI passes no delay, so it still saves per record. Roll-up of old buckets is NOT done: it changes the "all" range, streaks and day series, so it needs an owner decision.
- MAIN-29 (partial): `generationProfiles`, `promptCacheRefreshes` and `ambientProfiles` are `RecentChatCache` LRUs of 16 chats. Each `journalSnapshots` entry is dropped by an unref'd timer at its TTL. Pi compaction `sessions` is NOT bounded: there is no lease or refcount, so evicting a session in use would let `openChat` create a second writer for the same JSONL journal. It needs a lease design first.
- MAIN-19 (partial): memory-store caches prepared statements per open `DatabaseSync` (a WeakMap, so closing drops them), and the cached `db()` path no longer re-chmods on every call. Modes are still repaired at open, after writes and on close. `busy_timeout` is unchanged: lowering it would turn rare stalls into failed memory writes. The real fix is a worker/utility process.
- `DataStore.writeNow` clones the previous value only when a publish hook needs it.
- `secrets.ts` keeps the parsed (still encrypted) key map, validated by an lstat stamp (dev, ino, size, mtimeNs, ctimeNs), and writes through `writeFileAtomic` with the mutation guard and authority invalidation in `beforePublish`.
- App-controls ledger: unresolved (`outcome_unknown`) receipts are kept on purpose. `docs/aiden-remote-api-v1.md` documents that the ledger rejects new operations at 500 records rather than drop replay protection. Expiring them is an owner decision.

## Not done yet (audit leads, still open)
- MAIN-13 roll-up of old usage buckets (see above).
- MAIN-14 subagent run-store memo
- MAIN-27 local-model swap/staging/`stopDownloads`
- MAIN-29 Pi compaction `sessions` lease and idle eviction (see above).
- MAIN-19 moving SQLite off the main thread.
- `ensureUserDataDir` memo: skipped, because memoizing would break recovery if the folder is deleted while running, and `mkdir -p` on an existing directory is cheap.

## Known pre-existing failures (also on main `3f86d41af`)
- `pi-compaction-core.test.ts`: 4 long-history summary tests.
- `aiden-remote-files.test.ts`.
- `subagent-run-store-core.test.ts`: "Subagent run storage is unavailable", environmental.
