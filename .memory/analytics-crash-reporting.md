# Analytics crash reporting — 2026-11-04

Crashes reach analytics through one observer on the diagnostics journal (`observeDiagnosticEvents`), and `crashSignalFor` in `analytics-crash.ts` picks the subset. Anything not named there is ignored, which is what keeps soft errors out. Raw errors travel beside an event as `DiagnosticEventDetail`, never in it. The observer runs before the journal's write-mode filter returns, so `AIDEN_DISABLE_PRODUCTION_DIAGNOSTICS` does not silence fatal reports, and it cannot re-enter itself.

Messages use an allowlist, not redaction alone. `redactExceptionMessage` keeps only `KNOWN_ENGINE_MESSAGES`, turning every quoted name into `[name]`, and everything else is `[message withheld]`. Redaction cannot spot chat text and this app's errors can quote prompts. The plan originally said redact and cap; the allowlist is the deliberate change. The CLI shares it.

Patterns must not have open-ended gaps: an early `E[A-Z]+: [a-z ,]+` system-error pattern passed `ERROR: my biopsy results`. System errors are a fixed table of libuv texts. Error names come from the fixed `KNOWN_ERROR_NAMES` list, because a class-shaped name such as `AliceCancerError` can still carry private text (Pullfrog, PR 732); custom class names are reported as `Error`. There is no `app.asar` path fallback: only `appRoots` make a frame in-bundle, and a home folder can be called `app.asar`. Frames outside the bundle keep no function name, since text in a message tail can pose as a Node frame.

`captureImmediate` resolves even when the send failed: the SDK reports it only through `error`. `captureNow` in the client listens for that. Do not treat a resolved promise as an acknowledgement.

The pending record stays until acknowledged (`readPendingCrash`, then `acknowledgePendingCrash`), with its id as the event UUID so a repeat is de-duplicated. It stores the install id, and a mismatch is discarded. `takePendingCrash` still exists for callers that want read-and-delete. The marker and the record hold a run id, so a record explains only the unclean exit of the run that wrote it.

A throw in an ES module's top-level code reaches `uncaughtException` without firing the monitor, and `main` is ESM. That is why `bootstrap-import-failed` also maps to fatal.

Electron keeps running after an uncaught main exception (it shows a dialog), so `level: fatal` does not mean the process died.

Electron main runs Node's rejections in warn mode, measured on 43.8.4: `uncaughtExceptionMonitor` never fires for a rejection, and the process survives. So `installProcessDiagnostics` has an `unhandledRejection` listener (`level: error`, nothing written for the next launch), which re-raises the warning carrying the reason because a listener silences Node's two warnings. Fake-process tests cannot see this: `emit("uncaughtExceptionMonitor", x, "unhandledRejection")` passed while the real path was dead. In plain Node (the CLI) a listener would change fatal behaviour, so do not move it into shared code.

Renderer details: main answers through `diagnostics:policy` (`errorDetails`) and pushes `analytics:sending-changed`. Startup IPC admission holds the renderer's policy call until just before `analyticsService().start()`, and `sendsErrorDetails` waits for start, so errors queued during boot keep their details.

The browser tab crash report runs in a microtask after the `render-process-gone` handler. `writeDiagnosticEvent` calls `recordDiagnosticHealth`, which arms a 1,000 ms save timer, and `browser-lifecycle.spec.ts` counts every timer the handler starts to prove crash recovery owns exactly one. A synchronous report there failed 19 tests in CI (PR 732).

The owner accepted that a bundle function named by a computed key shows that key in a frame, and chose to keep function names (2026-11-04). Do not remove them on a reviewer's request without asking.

A server report sends no message, but a stack still opens with one, so `withoutMessage` in `packages/cli/src/server-analytics.ts` removes it from the stack before dropping it. Passing `message: ""` alone left a multi-line message's lines to pose as frames, and one naming a bundle path kept its text as a function name.

The server goes further than `stackWithoutMessage`, because it blanks the message before the sanitizer sees it: `stackBelowHeader` in `packages/cli/src/server-analytics.ts` keeps frames only when the stack's header is a name (plus any `[CODE]`), then `: `, the current message and a line end. An empty message must have the name alone: `Error: ` with no text is what a message opening on a new line leaves behind. V8 writes the header once, so a message changed after `.stack` was read leaves the old lines behind. Frames are lost on `error.message = "prefix: " + error.message`, which is the accepted cost. One case can't be told apart: a multi-line message cut to exactly its first line. The desktop still uses `stackWithoutMessage`, which returns an unmatched stack whole.
