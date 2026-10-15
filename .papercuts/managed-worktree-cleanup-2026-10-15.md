# Managed worktree cleanup friction

- The project history pointer in `.memory/PROJECT-CONTEXT.md` names `.memory/PROJECT-HISTORY.md`, which is absent from this checkout. The active lifecycle plan and stack disposition supplied the relevant status.
- A shell glob for `main/services/shell*.ts` failed under zsh's `nomatch`; use `rg --files` for optional paths.
- A fresh worktree has no root `node_modules` or built native helpers. Typecheck and focused worktree tests fail with missing `tsc`, `node-pty`, and `aiden-worktree-file-io` until the standard dependencies and helpers are installed/built.
- Root `npm run type-check` did not compile the self-contained `packages/cli`; the Linux container gate caught its stale synchronous terminal adapter. Run CLI build/typecheck locally whenever a shared application-service dependency changes.
