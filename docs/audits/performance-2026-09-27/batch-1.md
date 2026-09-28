# Performance batch 1 orchestration

Status: first review follow-ups published after independent review; current-head CI remains pending. User authorized separate worktrees, GPT-6 Astra medium implementers, fresh-context GPT-6 Astra medium edge-case reviewers, PR publication, then 15-minute CI/comment remediation cycles until exact-head checks are green and no actionable comments remain. Merging is not included.

All four lanes start independently at `a9baa4aa3027893e5455043083465c34b4c8b4ac`. Three concurrent subagent slots mean implementation/review waves. Reviews use `fork_turns: none`; reviewers receive scope, worktree, base and verification obligations, without inheriting implementer reasoning.

| Lane | Worktree (under ~/.codex/worktrees/) | Branch | Implementation | Independent review | PR / CI |
| --- | --- | --- | --- | --- | --- |
| Browser throttling DP-01 | perf-browser-throttling/aiden-agent | feature/perf-browser-throttling | Published `deec0c01` | Initial and window-scope reviews clear; follow-up 154 units + native 1/1 | [#282](https://github.com/sambitcreate/aiden-agent/pull/282), current-head CI pending |
| Stream accounting SDR-1 | perf-stream-accounting/aiden-agent | feature/perf-stream-accounting | Committed `c4f195f4` | Fresh review clear; 62 tests + 7,452 independent byte comparisons | [#285](https://github.com/sambitcreate/aiden-agent/pull/285), current-head CI pending |
| Android images AND-03 | perf-android-images/aiden-agent | feature/perf-android-images | Published `e2d1a5dc`; includes test-lifetime cleanup | Fresh product and cleanup reviews clear; cleanup checks 5/5; full-suite flake unresolved | [#284](https://github.com/sambitcreate/aiden-agent/pull/284), current-head CI pending |
| iOS chat loading IOS-03 | perf-ios-chat-loading/aiden-agent | feature/perf-ios-chat-loading | Published `cb53bbe6` | Initial and revocation reviews clear; follow-up 3 focused tests | [#283](https://github.com/sambitcreate/aiden-agent/pull/283), current-head CI pending |

## Gates per lane

1. Revalidate current source, read working agreements/memory and capture deterministic baseline evidence with synthetic fixtures.
2. Implement one bounded optimization; preserve ownership, authority, durability and cancellation. Update the lane's `docs/performance/` before/after record and project memory.
3. Run local focused behavior tests and applicable static/build checks. Distinguish device execution from compile-only and deterministic counters from hardware energy.
4. Fresh-context Astra medium reviewer inspects code and tests, probes edge cases, and reports actionable findings. Implementer addresses findings; review corrected diff before publication.
5. Publish independent PR against main, attach it to this chat. Do not rebase/force-push a reviewed/shared branch.
6. After publication, check exact-head CI and all review/issue comments at 15-minute intervals. Address valid findings, run local affected checks, push, and repeat. No broad retries, skipped tests or hidden failures.
7. Stop monitoring only when all PRs have passing applicable checks on their current SHA, no unresolved actionable comments, and no requested review in progress. Report environmental or external blocks honestly.

## Existing concurrent work

Open mobile model/transcript and dictation PRs were inspected by title/scope to avoid duplicated work. This batch does not modify their branches. Shared recovery, native response ownership and browser navigation fixes already on main remain correctness constraints.

## Progress log

- Created four attached managed worktrees from current origin/main; existing audit worktree retains the central ledger.
- Started browser, Android and iOS implementers; installed pinned root dependencies in the stream worktree for baseline preparation. No catalog refresh or real-account traffic.

- Remote baseline captured before implementation: 64 small appends produce 64 full snapshot calls both with empty retention and ~4.2 MB retained history. Five measured samples after one warmup: ~2.6–2.9 ms vs ~90–104 ms; Node 26.10.0, Darwin 27 arm64, concurrent build load. These are exploratory wall times, not hardware energy or release acceptance. Raw fixture/results retained under `evidence/`.

- Baseline stream suite: 59/59 passed before modification.
- Heartbeat `performance-batch-pr-follow-up` created at 15-minute intervals. It waits until all implementation PRs are published plus 15 minutes before the first hosted follow-up; then fixes and rechecks exact heads until clean.

- Published audit/tracking PR [#281](https://github.com/sambitcreate/aiden-agent/pull/281), separate from the four implementation PRs so code changes remain independently reviewable.

- Browser local units (154), type checks and scoped lint pass; native checks underway. iOS first full fixed simulator run 211/211 passes; original-source regression probe hit simulator launch infrastructure and one retry is allowed. Android off-Main dispatch mutation fails its new JVM regression as expected; fixed run passes, existing emulator booted for image instrumentation. These are progress observations, not final-head acceptance.

- All first-wave implementations committed; three separate fresh-context Astra medium reviewers running. Browser: 154 units + native lifecycle 1/1 and build/types/policy passed. iOS: final 212/212 passed, original-source held-catalog regression failed 7 assertions. Android: original full 251 passed, final full 250/251 with initial-load timeout before image path; one permitted targeted retry 2/2 passed, lint/instrumentation compile and three executed emulator codec tests passed. Android flake remains explicitly unresolved, not converted to a pass.

- Published browser #282/iOS #283/Android #284 after individual fresh-context reviews. Android full-suite limitation is explicit in the PR; independent bounded test-lifetime diagnosis underway, with no unchanged rerun loop or weakened gates. Remote accounting implementation now running.

- Remote final implementation: 62 stream tests, 533 broader Remote tests passed with one existing occupied-port skip; types/lint/diff passed. Same 64-append fixture now makes 0 full snapshots versus 64, with identical final serialized sizes. Exploratory after samples about 0.2 ms; raw after results retained. Fresh review underway.
- Android test-only cleanup follow-up `41adca58c` proves cancelled children must settle before resetMain. Controlled old-semantics regression fails, focused 3/3 passes. Full changed-harness run 251/252 still has initial-load timeout but no Main-after-reset exception; diagnosis continues without conflating the two. Follow-up remains unpublished pending fresh review.

## Publication and follow-up schedule

All four implementation PRs were published by **2026-09-28T02:40:07Z** (Remote #285 creation). The first hosted CI/comment inspection is due at or after **2026-09-28T02:55:07Z**, then every 15 minutes while unfinished. Include audit/tracking #281 and implementations #282/#283/#284/#285. Check exact current head, not earlier passes. Fresh reviews are complete for all four published implementation heads. Android test-harness follow-up was independently reviewed and published at `e2d1a5dc`; five focused checks passed. Its clean-source full suite remains 251/252 with an initial-load timeout. A bounded HTTP diagnostic execution passed 252/252 with probes, which establishes neither the cause nor a final clean-source pass. No further unchanged retries are planned.

- Android cleanup follow-up passed fresh-context Astra medium review with 5/5 focused checks and was pushed to #284. The startup timeout remains separately unresolved; diagnostic probes were removed. All four implementation lanes and the Android follow-up now have independent reviews.


## Hosted follow-up 1 — 2026-09-28 02:56 UTC

All five exact heads were inspected after the required wait: #281 `ad4ef395`, #282 `0a56d0ce`, #283 `c68550e5`, #284 `e2d1a5dc`, #285 `c4f195f4`. No requested reviewers; CI remains queued/running across the batch, so no PR is declared complete.

- #281: one unresolved reproducibility suggestion. Added explicit installed-`tsx` invocation and executed it against both baseline-equivalent and changed stream sources; 64→0 snapshot calls and equal final bytes reproduced.
- #282: reviewer identified Electron's window-wide effect when an attached guest holds an unthrottled lease. Implementation agent is establishing the activity exception's bounds and adding native validation/documentation; fresh review required before push.
- #283: reviewer identified transcript publication followed by catalog credential revocation while purge is pending. Implementation agent is adding prompt mounted-model redaction and a held-purge ordering regression; fresh review required before push.
- #284: no review threads. Linux arm64 job [108767808300](https://github.com/sambitcreate/aiden-agent/actions/runs/36371118746/job/108767808300) failed during AppImage packaging with upstream HTTP 500, after tests/build reached packaging. A targeted job retry request was rejected because the containing workflow is still running; no retry has started. Allow one infrastructure retry after workflow completion; do not change Android code for this packaging response. The local startup timeout remains separately unresolved.
- #285: no review threads; completed checks pass, others remain pending.

Raw snapshots and failed-job log are local under `/tmp/aiden-performance-batch-1/cycle-1/`. Monitoring remains active. Pending CI and external failures are not passes.


### Follow-up remediation published — 2026-09-28 03:07 UTC

- #281 reproducibility suggestion fixed in `b6b0eb372`, replied with reproduction counters and resolved its thread.
- #282 published `deec0c010` after fresh-context Astra review. Native attached/minimized lifecycle test and 154 browser units independently pass. Documentation now explicitly accepts Electron's shared-window compositor exception during active browser operations, states unbounded debugger/disk awaits, and distinguishes auto-stop cleanup from explicit-stop export validation. Raw host/sibling RAF observations do not establish compositor quiescence. Review thread replied to with evidence and resolved; no production behavior change in this follow-up.
- #283 published `cb53bbe6a` after fresh-context Astra review. Synchronous removal redaction clears messages before purge suspension. New held-purge regression reproduces two pre-fix assertion failures; fixed production full suite 213/213, final focused 2/2 after a launch-only retry, independent reviewer 3/3 without retry. Ordinary optional-catalog failures preserve transcript/selection. Review thread replied to with evidence and resolved.
- #284 packaging retry remains pending workflow completion; none has run. Its local initial-load timeout remains unproven and distinct from hosted packaging failure.
- Next routine hosted snapshot is 03:10 UTC. Passing checks from superseded browser/iOS/audit commits cannot accept the new heads. Keep monitoring all five PRs; do not merge.
