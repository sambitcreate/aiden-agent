# Managed worktree cleanup friction

- The project history pointer in `.memory/PROJECT-CONTEXT.md` names `.memory/PROJECT-HISTORY.md`, which is absent from this checkout. The active lifecycle plan and stack disposition supplied the relevant status.
- A shell glob for `main/services/shell*.ts` failed under zsh's `nomatch`; use `rg --files` for optional paths.
- A fresh worktree has no root `node_modules` or built native helpers. Typecheck and focused worktree tests fail with missing `tsc`, `node-pty`, and `aiden-worktree-file-io` until the standard dependencies and helpers are installed/built.
- Root `npm run type-check` did not compile the self-contained `packages/cli`; the Linux container gate caught its stale synchronous terminal adapter. Run CLI build/typecheck locally whenever a shared application-service dependency changes.
- Review exposed a synchronous callback gap: `owner.onInvalidated()` can call back before returning, so a PTY exit listener installed after that subscription leaves a retained exit promise unresolved. Register exit observation before subscribing.
- A PTY shell exit is weaker than a worktree-safe process drain: interactive job control moves background jobs to another process group. On macOS, `ps -o sess` yielded `0` for a `forkpty` session leader; after shell exit, a surviving job lost its controlling TTY as well. Both `ps` fields missed the member. Audit POSIX session membership with `getsid` through the packaged native helper and fail closed if inventory is unavailable.
- A pre-Git Remote refusal must clear its idempotency admission; otherwise the client cannot retry the same deletion key after the terminal job stops.
- The Android Gradle wrapper could not find a default Java runtime or SDK in this fresh worktree; set `JAVA_HOME` to Android Studio's bundled JBR and `ANDROID_HOME` to the installed user SDK for the focused unit suite.
