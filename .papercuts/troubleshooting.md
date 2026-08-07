# Troubleshooting papercuts

## 2026-08-06 — Unreferenced bounded-settlement timers

Do not call `unref()` on a timer when that timer is the only completion path
for an awaited bounded operation. In `node:test` (and short-lived host
processes), Node can drain the event loop before an uncooperative remote
operation reaches its timeout, leaving the promise pending and cancelling its
parent test. Keep the deadline referenced and clear it in `finally` instead.

## Rust port: guard against python-driven file rewrites corrupting Rust source

When porting TS modules to Rust with `rust/aiden-data/src/`, prefer the `edit`
tool over python `str.replace`/`re.sub` passes over whole source files. Two
failure modes bit during the aiden-data port:

1. `re.sub(r'r"((?:[^"\\]|\\.)*)"', ...)` intended for regex-literal
   conversion also matched plain string literals, silently deleting lines and
   injecting stray `#` characters into unrelated strings (e.g. `"id"` became
   `"#id"`), breaking `normalize_stored_run` and the cron parser in ways that
   only surfaced as logic failures, not compile errors.
2. A single `write` tool call for a ~2,500-line module was truncated
   server-side, and every subsequent python edit operated on the truncated
   file, producing unclosed delimiters that were hard to trace. Rewrite
   oversized modules in two parts (main + `#[cfg(test)]` via an anchor
   marker) and re-verify the file tail after writing.

Symptom to watch for: `cargo test` hangs (deadlock) when a serialized store
method recurses into another serialized method on the same non-reentrant
`parking_lot::Mutex` — keep inner non-serialized variants (`*_inner`) for
same-lock recursion.

## 2026-08-06 — aiden-agent port: three silent-behavior traps

1. `tokio::sync::mpsc::Sender::send(...)` returns a future — forgetting
   `.await` silently drops the event (no compiler error, no runtime panic).
   After a sed-style `.await` insertion pass over multi-line sends, verify with
   `cargo clippy -- -D warnings` + a fixture test asserting the full event
   sequence; clippy caught nothing, the test did.
2. macOS temp dirs live under `/var/folders/...` (lexical) but resolve to
   `/private/var/...` (realpath). Node's `path.relative` tolerates the skew by
   emitting `..`-climb forms; `strip_prefix` fails and falls back to the full
   lexical path, whose dot-prefixed `.tmpXXXX` segment then trips the
   credential-path hidden-directory guard. Fix: implement Node-style
   `path_relative` (common-prefix climb) and use non-dot `tempfile` prefixes in
   tests. Also: `slice::contains(&[&str], x)` needs `&&str`, not `&str`.
3. The `regex` crate (RE2-style) rejects JS-only constructs the parent grep
   permitted (`(?<=foo)bar` lookbehind). Ported tests must use RE2-compatible
   patterns; document the deviation rather than emulating backtracking.

## GPUI port: aiden-git + aiden-data additions (2026-08-07)

- `tokio::join!` + borrowed temporary args = E0716. `tokio::join!` wraps its
  futures in an async block, so `&["a", &format!(...)]` temporaries die at the
  statement end while the joined future still borrows them. Workaround used:
  bind argument arrays to named locals or drop `join!` for sequential awaits
  (git CLI calls are ~ms each, so no perf loss). `&[1]`/`&[128]` in
  `RunOptions.allow_exit_codes` are fine because integer-literal arrays promote
  to `'static`.
- `std::fs::read("/dev/urandom")` never returns (no EOF) → 100% CPU hang in
  tests. Use `File::open` + `read_exact` for exactly N bytes.
- `git push` updates the local `refs/remotes/<remote>/<branch>` tracking ref on
  success (git ≥ 2.x), so a pre-push "absent → CAS with 40-zero old" snapshot
  fails with "reference already exists". Re-read the tracking ref's old value
  right before the CAS `update-ref`.
- `parse_remote_refs` (git.ts) keeps empty `\0` fields — ref/symref pairs must
  stay aligned. Filtering empty strings mis-pairs `%(refname)%00%(symref)%00`.
- V8 `localeCompare(…, {numeric:true})` compares digit runs numerically but
  non-digits char-by-char; a naive "digit-run vs text-run" natural sort gives
  wrong ordering for `file.txt` vs `file1.txt`.
- `/var` → `/private/var` skew on macOS: compare worktree paths via
  `std::fs::canonicalize` on both sides, not string `starts_with`.
- macOS `MetadataExt::mode()` doesn't exist on darwin; use
  `metadata.permissions().mode()` (PermissionsExt) for mode assertions.
- gpui-component 0.5.1 `Input` elements call `Root::read(window, cx)` while
  painting, so EVERY window that renders an `InputState`-backed input needs a
  gpui-component `Root` as its window root — a "no dialogs, so no Root" window
  (the old onboarding window) panics at first paint (`root.rs:268 unwrap`).
  Root-wrap any window that hosts gpui-component inputs; deliver completion
  via a callback when the Root handle hides the real view.

## 2026-08-07 — main-process services port (aiden-providers/aiden-agent/aiden-data/aiden-mac)

- **Workspace breakage from in-progress members**: an uncommitted
  `aiden-subagents` workspace member with a manifest referencing a
  non-existent `aiden-agent.workspace = true` dep blocked **every** cargo
  command (the whole workspace manifest fails to load, even for
  `-p aiden-providers`). If a WIP crate is half-wired into `workspace.members`,
  `cargo metadata` dies before you can build anything. (Resolved by concurrent
  work adding the missing workspace dep.)
- **tokio `select!` + oneshot drop hazard**: awaiting two `oneshot::Receiver`s
  where one sender is dropped (because its closure was discarded) turns that
  receiver into `Ready(Err)`, and tokio's *fair* polling picks it at random —
  flaky "wrong branch" results that pass alone and fail in a suite. Use a
  first-wins slot (`AtomicU8` + `Notify`) or `biased;` only when you are sure
  the loser can never close its channel.
- **Blocking std channels inside async test futures**: a `Deferred` future
  built on `std::sync::mpsc::Receiver::recv()` deadlocks `#[tokio::test]`
  (current-thread) runtimes — the test future can't run while the spawned task
  blocks the single thread. Use `tokio::sync::oneshot` (or parking-lot
  condvar) for manually-settled async test fixtures.
- **`final` is a reserved keyword in Rust** — `let final = ...` in ported TS
  tests doesn't compile; rename to `final_timeline`/`snapshot`.
- **Clippy `bool_assert_comparison` + `manual_range_contains`**: `assert_eq!`
  on a `bool` literal and hand-rolled range checks are hard-denied under
  `-D warnings`; `assert!(x)` / `!(1..=10).contains(&n)` from the start.

## 2026-08-07 — MCP + subagent shell audit friction

- **`tokio::process::Command::kill()` kills only the direct child.** A timed-out
  shell whose grandchildren inherited the output pipes leaves the drain
  (`read_to_end`) blocking until they exit. Use `process_group(0)` at spawn +
  `killpg` on timeout/cancel/overflow, and bound every post-kill drain with
  `tokio::time::timeout`. Also: the deadline-break path must be included in the
  "needs kill" decision — the old cleanup only killed on overflow/cancel, so a
  timed-out command was simply awaited to completion (5s test that looked like a
  pass).
- **Time-seeded PRNGs collide across concurrent callers.** `uuid_like()` seeded
  only from `SystemTime` produced identical ids for two threads spawning shells
  within the same clock tick ("private tree failed" flakes in parallel tests).
  Mix in a process-wide `AtomicU64` counter.
- **Holding a `tokio::sync::Mutex` across an `.await` serializes unrelated
  work.** `McpClientManager` held the client map lock for the whole 60s MCP call,
  so a slow tool blocked every other server and a second chat generation.
  Clone the `Arc` under the lock, drop the guard, then await.
- **`#[tokio::test]` parallel flakes**: process/pipe timing tests (100ms
  timeouts) race under parallel test threads; make them assert duration bounds
  and keep spawned grandchildren short-lived.

## 2026-08-07 — Live-wiring chat services (usage/timeline/MCP/subagents)

- **Concurrent-agent edit storms**: while wiring chat services, the workspace owner was simultaneously editing `rust/aiden-ui/src/services/chat_service.rs` and adding `rust/aiden-ui/src/workspace/**` + `mod workspace;` in `main.rs`. Their in-progress code repeatedly broke `cargo test -p aiden-ui` mid-flight (missing `aiden-git` dep, GPUI API mismatches, an off-by-one test expectation). Lesson: poll `cargo test -p aiden-ui --no-run` and `stat` the files before final verification, and only add *non-semantic* `#[allow(dead_code)]`/import fixes to others' in-progress code when a lint gate requires it — never fix their logic.
- **`usize::then` doesn't exist** (only `bool::then`); use `(count > 0).then(...)`.
- **gpui-component `IconName` has no `PartialEq`** — match with `matches!(icon, Some(IconName::X))` instead of `==`.
- **`tokio::time::interval` first tick fires immediately** — fine for flush draining since `take_flush` no-ops on empty pending.
- **`TimelineProjector::finish` settles still-Running tool steps as `Failed`** (not `Completed`) — execute/dispatch must call `tool_finished(Completed)` before finish; a unit test asserting `Completed` must mirror that order.
- **`parse_generation_timeline` (chat_store replay) is strict**: `generationId` must be `[a-zA-Z0-9._:-]` ≤128 (use `chat_store::new_uuid_like()`), tool ids `tool-N`, `toolCallId` `call-N`, `order == index` — the `TimelineProjector` output already satisfies these.
- **sherpa-onnx is a build-time download**: `sherpa-onnx-sys` fetches a prebuilt static lib (~20 MB .tar.bz2) from k2-fsa GitHub releases during `cargo build` (cached under `target/`). Builds are network-tied; keep the dep behind the `dictation` feature so `--no-default-features` still compiles offline.
- **objc2 0.6 object creation**: `Retained::new()` is deprecated; `AVAudioEngine::init(Allocated::new())` is not public. Use `ClassType::alloc()` for `init`-style constructors (`unsafe { T::init(T::alloc()) }`); the `alloc()` helper lives on the unsafe `AnyThread` trait, not `ClassType`.
- **block2 tap blocks**: `AVAudioNodeTapBlock` is `*mut block2::DynBlock<dyn Fn(...)>` with `DynBlock = Block`. Build with `block2::RcBlock::new(closure)` (no `Send` bound on the closure) and pass `RcBlock::as_ptr(&block)`; the framework copies the block on install.
- **objc2 objects are not `Send`**: an AVAudioEngine-based capture cannot live in a `Box<dyn Trait + Send>`. The `AudioCapture` trait is deliberately non-`Send`; create the capture inside its dedicated thread (the pill's capture thread) and only touch it there — only the `on_samples` callback (Send) crosses threads.
- **Lazy Rust futures ≠ eager TS promises**: the TS coordinator tests start promises eagerly; Rust `async fn`s don't poll until awaited. Porting `Promise.all([result(), next()])` must `tokio::spawn` the futures (or the deferred that a spawned op resolves will never fire).
- **Env-var tests race in parallel**: tests that set `MODELS_ROOT_ENV` clobber each other under the default test harness; serialize them on a shared `tokio::sync::Mutex` (see `local_models::MODELS_ENV_LOCK`).

## 2026-08-07 — Rust port friction (provider auth / connection caches / gemini cache)

- **parking_lot re-entrancy is a deadlock**, not a panic. `self.state.lock().unwrap()`
  while already holding the guard (e.g. nested in `if let Some(x) = self.lock().get(k)`
  where the guard temporary lives through the body) hangs the whole tokio test suite.
  Bind the guard to a `let`/statement and `drop` before re-locking.
- **TS async functions start eagerly; Rust futures don't.** Tests that call
  `coordinator.start(...)`/`cache.get_or_connect(...)` and then wait on an injected
  barrier must `tokio::spawn` the future, or the barrier never resolves. Mirror of
  the fire-and-forget promise semantics.
- **`if let Some(x) = self.mutex.lock().get(k)` guard lifetime footgun** (std Mutex):
  the temporary guard lives across the if-let body, so calling a method that locks
  the same mutex inside deadlocks. Extract the value at statement level first.
- Closures that must fit `Arc<dyn Fn(...) + Send + Sync>` cannot consume captured
  one-shots; wrap `oneshot::{Sender,Receiver}` in `Arc<Mutex<Option<_>>>` + take.

## 2026-08-07 — GPUI ObjC-callback panic audit (aiden-ui)

- **`unreachable!()` / `.expect()` in render/on_click/on_action/subscription
  closures are SIGABRT bombs.** GPUI runs these on the NSApplication run loop;
  a Rust panic there hits `panic_cannot_unwind` and aborts (no unwind through
  ObjC). Replaced the three `unreachable!` arms on the onboarding completion
  path (`on_next_pressed`, `save_provider_then_advance`, and the dead
  `make_onboarding_provider` base-url arm for `OpenaiSignin`) with quiet
  no-ops + `tracing::error!`, and the `build_theme_config` `.expect` (reached
  from the sidebar appearance-mode `on_click`) with a `ThemeConfig::default()`
  fallback. The onboarding→main-window crash itself had already been fixed by
  spawning the `PillCoordinator` watcher via `gpui_tokio_bridge::Tokio::spawn`
  instead of bare `tokio::spawn` (commit 24e5d57) — bare tokio on a GPUI thread
  has no runtime guard.
- **Audit rule for the wired view**: `OnboardingMachine::advance()` only ever
  yields `Advanced`/`Completed` (never `Blocked`); `Blocked` is exclusive to
  the `#[allow(dead_code)]` `next()`. So a `match` on `advance()` can treat
  `Blocked` as a defensive no-op. Locked in by
  `advance_never_yields_blocked_across_the_whole_flow`.
- **Provably-safe `.unwrap()` is still a smell** in an ObjC path
  (`self.active_chat_id.clone().unwrap()` one statement after the `Some`
  assignment in `ChatService::send_message`). Prefer the local value.
  `view_state::settle_messages`/`settle_failed_messages` had the same pattern
  (`pop().unwrap()` after `last()` was `Some`, `unwrap()` after `is_some_and`);
  rewrote them borrow-safe so the pure helpers can never abort a render.

## 2026-08-07 — Persistence/state concurrency audit (aiden-data, aiden-ui)

- **`DataStore` (lib.rs) re-entrancy is safe.** `parking_lot::Mutex` is
  non-reentrant, but every public method routes through the private
  `path_locked(&mut Inner)`/`load_locked`/`write_now_locked` helpers that take
  the already-held guard — no method re-locks. `loaded_from_corrupt_file` and
  siblings do two *sequential* lock acquisitions (not nested), which is fine.
  The Phase-3 note ("path resolution requires the lock-held path_locked()") is
  already satisfied. No deadlock.
- **Chat stream cancellation is correct, but only because GPUI `Task` cancels
  on drop.** `stop_generation`/`cancel_generation` set `self._stream_task =
  None; self._driver = None;`. GPUI's `Task::drop` calls `set_canceled()`
  (async-task 4.7.1), so dropping `_driver` cancels the `gpui-tokio-bridge`
  background future → drops `AbortOnDrop` → `tokio::task::JoinHandle::abort()`
  → the SSE stream future is dropped → the HTTP connection closes. The watcher
  also runs `read_with`+`update` synchronously (no await between), so the
  `generation_matches` check and `apply_stream_msg` are atomic on the
  single-threaded foreground — a stale stream cannot write to the wrong chat.
  Caveat: never `detach()` the driver/watcher or this cancellation breaks.
- **FIXED — git refresh stale-workspace race** (`workspace/state.rs`).
  `refresh_git_info`/`refresh_branches`/`refresh_review`/`refresh_push` are
  one-shot background reads whose completion order is nondeterministic. A slow
  read for a switched-away workspace would overwrite the active workspace's
  `git_info`/`branches`/`review`/`push_capability` (wrong branch shown, could
  mislead a commit/push). Added a folder-identity guard (`active_folder ==
  expected_folder`) at the top of each watcher's update. The 15 s poll loop is
  already guarded by its per-`Poll` `watch::Sender<bool>` stop signal, so it
  needed no change.
- **FIXED — chat history reordering under out-of-order appends**
  (`chat_store.rs::append_message`). The chat service persists the user
  message, the assistant turn, and a retry's next user message from separate
  background tasks. They serialize through the store lock but can acquire it
  out of submission order, so a plain `push` could persist
  `[user1, user2, assistant1]` (a corrupted transcript). `append_message` now
  stable-sorts messages by monotonic `created_at` after the push, making
  on-disk order deterministic. Covered by
  `append_message_orders_history_by_created_at_under_out_of_order_appends`
  (three threads, staggered timestamps).
- **Non-issue noted**: `ChatService::send_message` does a *synchronous*
  `stores.chat.create(...)` (file I/O) on the GPUI foreground when
  `active_chat_id` is `None` — a UI-jank smell, not a race (the `ChatStore`
  lock serializes it against background writes).

