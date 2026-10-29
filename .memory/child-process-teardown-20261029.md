# Child-process teardown fixes (2026-10-29)

Branch `claude/audit-fix-process-teardown`. These fixes come from audits 04 (inference and subagents) and 05 (ACP, MCP and native helpers).

## What changed
- **Form fill** (`form-fill/helper-client.ts`, `runtime.ts`, the Swift helper's `main.swift`):
  - The helper echoes the request id when it cannot encode a response, so only that request fails. An empty id means a request could not be read at all, and the client then fails everything in flight.
  - stdin errors are absorbed, so EPIPE no longer crashes main.
  - An error that can't be tied to one request fails everything in flight.
  - `cleanupApplication` in `main/index.ts` disposes the runtime.
- **ACP crash sweep** (`acp/pid-ledger.ts`, `launcher.ts`):
  - Every launch gets a random `AIDEN_ACP_RUN` env marker.
  - A group whose leader is gone is stopped when a member carries the marker or runs from the runtime directory.
  - A group that survives the kill stays in the ledger.
  - Linux reads `/proc`.
  - macOS SIP binaries hide their environment from `ps`. A leftover group made only of SIP binaries can't be identified by the marker.
- **Antigravity quit** (`antigravity/service.ts`, `launcher.ts`, `runtime.ts`):
  - The launcher tracks every process it starts, including sign-in and validation agents, and refuses new launches once shutdown begins.
  - `shutdownAntigravity()` is idempotent and runs in the quit `Promise.all` with a 4 s budget. It must not run from `before-quit`: the launcher closes for good, and a quit can still be cancelled there.
  - An exit hook kills whatever is still running.
- **ACP connection** (`connection.ts`):
  - One exit subscriber fans out to pending requests, so long sessions no longer keep finished requests' closures alive.
  - Stdout line reassembly is linear.
- **ACP runtime**: `makeRoom()` reserves a slot through `startingSessions`, so concurrent starts can't exceed the live limit.
- **Subagent stop** (`subagent-inference-process-core.ts`):
  - When the identity-checked hard kill or the exit proof fails, it retries with unref'd backoff.
  - The run settles once the process is provably gone. Cleanup stays fail-closed: it is marked unhealthy and never assumed dead.
  - Retries stop after about 75 s; a run whose exit is still unproven then stays pending on purpose.
- **Foundation Models helper**: it is signalled only while `open -W` still waits and the pid still runs an executable inside the helper bundle (`ps -o comm=`).
- **Bot inbox writer**: a 30 s deadline, then SIGKILL, then a bounded settle.
- **Computer Use**:
  - A send waiting on drain also rejects on `close`.
  - `retryPendingCleanup` drops a directory after 3 failures instead of throwing for every later session.
- **Quit after Stop** (`llm-client.ts` `cancel`): on `application_shutdown`, a turn that is already cancelled is aborted again. The Stop origin is kept.
- **ACP scratch** (`acp/scratch-directory.ts`): deleting a chat now removes its scratch directory and any private fallback. This runs through `forgetDeletedChat` in `chat-application-service`, fire-and-log, so it never delays the delete reply.
- **Background jobs**:
  - Finished jobs are capped at 10 per chat and `MAX_FINISHED_JOBS` (50) overall. Over the global cap, the chat with the most finished jobs loses its oldest first, so a quiet chat keeps its only result.
  - Deleting a chat drops its `runWindows` and `runStarts`, and a run that ends after its chat was deleted adds no window.
- **Live thread store**: `begin()` drops the cached store if the first save throws.

## Deliberately not done
- 04-7: an advisor attempt stuck in `prepared` is reconciled to cancelled on the next launch, and nothing in the session reads it as in flight.
- 05-14: the CUA broker has no teardown handle and relies on its native lease. Whether to add a pid file plus an identity-checked kill is the owner's call.
- 04-8 (Windows subagents) is informational.
- The duplicated kill helpers (git, clone, schedule-script, bounded-shell-command) and the PTY belong to the shell/git/terminal workstream.

## Known environmental test failure
In this environment, `client-files.test.ts` "writes create missing folders…" fails because it needs the native confinement helper. This is not a regression.
