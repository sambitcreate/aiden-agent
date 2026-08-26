# Phase 0 performance baseline

Recorded: 2026-08-10  
Commit under test: `c26f6e5dd64d5c8708de7bfa774bf63b94f22520` plus the Phase 0 working-tree delta  
Build: signed development package, Electron 43.1.1, arm64  
Reference Mac: Apple M1 Max, 10 logical CPUs, 64 GiB RAM, Darwin 25.4.0, AC power

This is the reference baseline for the Performance, Stability, Battery, and
Efficiency plan. The raw device-local report stays under ignored
`build/performance-results/`; it is deliberately not committed because a user
must inspect and explicitly choose where to share a diagnostics export.

## Phase status

Phase 0 instrumentation and reproducibility tooling are implemented, but the
laboratory exit gate remains open. The available reference machine is a Mac
Studio and has no battery. It can produce the AC matrix only; the required
battery Instruments runs must be performed on a portable reference Mac before
Phase 0 can be declared complete. No battery values are inferred below.

## Directional pre-schema package and startup sample

The figures in this section were captured before the settled strict receipt,
artifact-hash, and exact-package binding schema. They are retained as
directional engineering evidence only and cannot satisfy the Phase 0 exit gate.
Every final AC/battery number must be regenerated from a newly signed profiling
package and pass the current `--require-complete` verifier.

| Metric                              |                           Baseline |
| ----------------------------------- | ---------------------------------: |
| Renderer JavaScript                 |                    2,953,554 bytes |
| Largest renderer chunk              |                    2,530,996 bytes |
| Build source maps                   |                   13,701,940 bytes |
| Signed unpacked app payload         | 588,582,275 bytes across 474 files |
| Main loaded                         |                          513.82 ms |
| Electron app ready                  |                          579.59 ms |
| Window created / navigation started |                 760.14 / 760.46 ms |
| Window ready to show                |                          960.59 ms |
| Providers ready                     |                        5,104.16 ms |
| First shell paint                   |                        5,155.91 ms |
| Composer ready                      |                        5,244.08 ms |

The startup order confirms the audited bottleneck: provider discovery still
blocks the first React shell. Phase 4 must invert that order while preserving
authoritative provider/model migration before composer mutation.

## Instrumented packaged samples

The explicit `visible-idle` export covered 195 seconds including startup,
opening Settings, and saving the diagnostic report. It recorded:

- main event-loop delay p99 25.43 ms;
- two renderer long tasks, 52 ms and 109 ms;
- zero live RAF callbacks at export, peak two;
- 50 live renderer timers at export, peak 82;
- 94 measured renderer→main IPC invocations, about 72 KiB in and 1.13 MiB out;
- 443 bounded central-file reads totaling 97,063 bytes;
- zero dropped diagnostic events and no prompt, response, credential, tool
  payload, file path, or environment-value field in the exported schema.

This legacy smoke sample deliberately does not claim to be a five-minute idle-energy result:
the Settings/export interaction is active work. It proves the signed-package
pipeline and gives the first comparable counter snapshot.

A second pre-schema signed package was built with React's production profiling renderer
and exercised through the same About export. The 157-second sample recorded 91
real React commits totaling 189.10 ms across 12 bounded samples, 91 diagnostic
events, zero dropped events, direct main-to-renderer IPC accounting, and a
19,063-byte report. A fixed privacy scan found no user path, profile name,
prompt/response, credential, attachment name, or environment value. A clean
quit persisted a 10.17 ms shutdown with zero timeouts/process-gone/crash-loop
events; the next launch exported that exact aggregate as `previousSession`.
This is production-path instrumentation evidence, not a substitute for the
five-minute AC/battery scenario matrix.

## Scenario ledger

The registered 25-scenario fixture inventory is the canonical naming and
reproduction contract. AC and battery Instruments values are laboratory
evidence, not CI data. Each run follows
[`benchmark-runbook.md`](./benchmark-runbook.md) and writes a stamped receipt.

| Scenario group                                     | Baseline disposition                                                                                                  | Phase that must improve or close it |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Cold/warm launch                                   | Packaged startup milestone baseline above; cold/warm Instruments repetition required for release                      | Phase 4/5                           |
| Visible/blurred/minimized/window-closed idle       | Signed counter export works; source audit confirms periodic Git and completed-stream wakeup risks                     | Phase 2/5                           |
| 100/500-turn transcript                            | Deterministic fixtures generated; long-task/heap traces are release laboratory gates                                  | Phase 4/5                           |
| 2k/10k Markdown streams                            | Deterministic code/math/reasoning fixtures generated; audited full-string copy/reparse is the comparison baseline     | Phase 2/4                           |
| Clean/dirty/churning repository                    | 4,000-file fixture generated; audited normal chat launches roughly six Git commands per five-second refresh           | Phase 2/3                           |
| Attachments and long voice                         | 20-file/sparse-file protocol fixed; audited unbounded aggregate reads and main-thread recognizer are release blockers | Phase 1/3                           |
| Four idle/high-output terminals                    | Fixed four-terminal protocol and IPC/PTY counters registered                                                          | Phase 3/4                           |
| MCP offline/hung/duplicate connect                 | Fixed fault protocols and live-client counters registered                                                             | Phase 3                             |
| 20 missed schedules, suspend/resume, lock/timezone | Fixed lifecycle protocol and crash/process diagnostics registered                                                     | Phase 3/5                           |

## Phase 0 budgets frozen for implementation

- CI regression ceiling: renderer JavaScript ≤ 3 MiB, any renderer chunk ≤ 3
  MiB, aggregate build maps ≤ 14 MiB. Phase 4 tightens these to 1.5 MiB, 500
  KiB, and zero packaged maps.
- Main event-loop target after isolation: p99 < 50 ms for voice/tool workloads.
- Renderer stream target after isolation: long tasks < 50 ms at p95, at most one
  scroll write per frame, and bounded parser/highlighter calls.
- Startup target: shell p95 ≤ 1.5 seconds on the reference Mac, with providers
  ready second.
- Idle target: zero continuous app-owned RAF loops and zero periodic Git/helper
  launches while hidden; at least 50% fewer wakeups/CPU time in final AC/battery
  soaks.
- Memory settling tolerance: after a two-minute settling window, retained
  heap/RSS must be within 10% or 64 MiB (whichever is larger) of the pre-cycle
  baseline for attachment, voice, terminal, MCP, chat, and model cycles.

The final Phase 5 release report must replace source-audit dispositions with
before/after Instruments values for every scenario; CI must not fabricate
hardware energy numbers.

## Laboratory receipt status

- The exact 25-scenario inventory, loadable disposable chats, 4,000-file
  workspace, stream/attachment/terminal/MCP/scheduler inputs, signed profiling
  launcher, and strict receipt/export verifier are ready.
- The settled Phase 0 source regenerated a signed profiling package on
  2026-08-10; the real build/package budgets and hardened package verification
  pass. This proves package readiness, not scenario execution.
- Pre-schema AC visible-idle startup/export/shutdown smoke evidence is retained
  only as directional evidence; a current package-bound smoke receipt is still
  pending with the full laboratory matrix.
- The 25 complete AC Instruments receipts are pending.
- All 25 battery receipts are blocked on access to a portable reference Mac.
- Phase 0 must remain open until both rows above are complete or the plan's
  laboratory exit gate is explicitly revised by the owner.
