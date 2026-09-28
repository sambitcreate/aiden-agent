# DP-01: Browser scheduling ownership — 2026-09-27

Baseline a9baa4aa3027893e5455043083465c34b4c8b4ac. See `docs/performance/browser-throttling.md` for native evidence and limits.

Guest WebContents now default to normal background throttling. `BrowserBackgroundThrottling` owns idempotent, reference-counted temporary exceptions: queued action execution, bounded captures (including PiP/annotation), and recorder lifetime. Abort releases synchronously; finally releases normal/error completion; recorder closed releases recording; current renderer crash and tab close reset ownership. Crash also finalizes the now unusable recording. Stale releases cannot affect replacement owners. Linux invisible native-host attachment is unchanged. Hidden PiP/encoder windows keep existing configuration.

Exact baseline native test fails `false !== true` for idle throttling. Three native baseline guests report [false,false,false], candidate [true,true,true]. Native candidate validates hidden timer automation, visible/hidden image output, cancellation/failure, real WebM stop/start-cancel, real crash closing encoder, and native guest close. Unit suite154, native test, both type checks, scoped lint, production build/main rebuild, CI discovery/policy19, diff check pass. New files are discovered by existing browser glob and E2E shard planner.

No measured CPU/energy claim: this is native policy/ownership evidence. Five-minute power/resource traces and Linux native execution remain unperformed. A detached hidden requestAnimationFrame promise stalls on exact baseline and candidate macOS; do not misreport as a new regression or a fixed behavior. Cold never-presented blank capture also lacks a surface; native fixture presents local DOM once before hiding. No UI/protocol/onboarding change.

Fresh review and current-head hosted CI remain required before publication/merge. Root owns plan index, papercut records, PR, and CI; this lane does not push.

## PR #282 review: attached host rendering effect

Electron43.1.1 aggregates each attached WebContents into the host compositor: any guest false permits window-wide background drawing even if host/sibling getters are true. Accepted/documented as an active-operation exception; no reparenting or production behavior change. Five-minute recording duration is not an unconditional wall-time lease cap: acquisition precedes asynchronous startup, release follows encoder finalization, and overlapping/repeated work can extend it. Source links and hashes plus decision in docs/performance/browser-throttling.md.

Extended native fixture attaches guest+sibling, actually minimizes/restores the host, validates timer automation and valid recording, cancellation overlap, explicit stop and deterministic invocation of the production300000ms auto-stop callback. Awaits encoder closed; host stays minimized until explicit restore and attachments remain unchanged. Raw docs/performance/browser-throttling-attached-native.json records [true,true,false] → [true,true,true]. Host/sibling RAF each0 in the attached JSON samples before/during/after recording, hidden throughout; this does NOT establish compositor isolation/no drawing (renderer visibility is independent), nor any resource savings. Native1/1 passes9.6s on macOS; no Linux-native claim. Fresh review required before push.

Linux fixture explicitly uses native hide/show visibility behavior because bare Xvfb has no window manager; this is not Linux minimize coverage. macOS/Windows path uses real minimize/restore. Final browser154/154, application/E2E type checks, scoped lint, and diff checks pass.
