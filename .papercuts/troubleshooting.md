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
