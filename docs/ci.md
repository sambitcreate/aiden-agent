# Continuous integration

The `CI` workflow exposes one aggregate result, **CI required**. The gate fails
when detection, policy checks, or a selected job fails, is cancelled, is missing,
or unexpectedly skips. Branch protection can require this check; the workflow
itself does not change repository protection settings.

## Selecting work

PRs compare the merge base and PR head using complete, NUL-delimited Git output.
Rename detection is disabled so both the removed and added paths select work.
`scripts/ci-changes.mjs` maps each path to seven areas: `desktop`, `apple`, `ios`,
`android`, `cli`, `linux` and `catalog`. Only explicit prose documentation paths
(including root community docs such as `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
and `CODE_OF_CONDUCT.md`, plus `.github/ISSUE_TEMPLATE/`—validated by the always-run
policy job—and pull request templates) select nothing; contributor-instruction files
such as `AGENTS.md` and the design guide are not treated as prose. Android-only and iOS-only PRs select their own
platform checks, renderer-only PRs select desktop checks, and CLI-only PRs select
the CLI jobs plus static checks. Desktop changes always imply `catalog`.
`renderer/shared/` selects `desktop`, `cli` and `linux`; the files native clients
mirror (listed in `scripts/ci-changes.mjs`) select every area. Infrastructure,
unknown paths, empty diffs and detection failures select every area, with two
narrower cases on PRs: `scripts/ci-test-registry.json` selects `desktop`, and a
root `package.json` change confined to `scripts` selects `desktop`, `cli` and
`linux`. That case compares the merge base and head manifests, and stays full if
either cannot be read or the change touches what the Apple and iOS jobs execute:
`test:native`, `test:ios-release`, their hooks and any script they reach through
`npm run` or `npm run-script`. Policy checks always run.

Every main push runs full validation except a push that changes only the
generated model catalog (`resources/model-capabilities.json`, reason
`catalog-only`). Those commits run detection, policy and the
`catalog` job; the other jobs skip. Real code changes on main are never routed
this way. Linux packaging jobs run only when the `linux` area is selected, which
includes every full main run.

`scripts/ci-required.mjs` lists, per job, either `always` or the areas that select
it. A job may skip only when every one of its areas is false; any other skip,
failure, cancellation or missing result fails **CI required**. The macOS `e2e`
job follows the `mac-e2e` plan decision instead of an area (see below), and
`linux-e2e` follows `desktop` or `linux`. Branch protection
should require only that check.

PR pushes cancel superseded PR CI, and main pushes cancel superseded main CI:
when several merges land close together, the run that joined the concurrency
group last finishes the full suite, which is normally the newest main commit and
so covers every earlier one. GitHub orders the group by when each run starts
waiting and does not guarantee that order, so with merges seconds apart the
surviving run can be for an earlier commit. If the tip's CI shows cancelled, run
`gh workflow run CI --ref main` (or re-run its CI) to validate it. A superseded
main run shows its jobs as cancelled, and its `CI required`, `Linux x64` and
`Linux arm64` gates as failed, because those gates fail closed on cancelled jobs. Manual `workflow_dispatch` runs keep their own group
and are never superseded. Each main run of `Release consumer contract` still has
its own concurrency group. The release workflows (`release.yml`, the TestFlight
workflows) have their own non-cancelling groups and do not depend on CI, so
cancelling CI never cancels a release. Runner capacity can still cause queueing.

## Execution and coverage

- TypeScript (`npm run type-check`, which chains the root project and
  `scripts/tsconfig.json` for `scripts/` and `docs/`; `npm run type-check:e2e`,
  covering `tests/e2e` and `tests/generative-ui`; and
  `npm --prefix packages/cli run type-check` after `npm --prefix packages/cli ci`
  when `cli` is selected) and lint (covering `.ts`, `.tsx`, `.mts`, and `.cts`)
  run on Ubuntu in `static`. The always-run `policy` job verifies that every
  git-tracked TypeScript file belongs to a CI-checked `tsconfig.json`. One macOS
  `build` job runs `npm run build` and uploads `build/` as a tarred, one-day
  artifact; the Electron shards and `verify` download it instead of rebuilding.
  Diagnostics and branding remain in `verify`; the model-catalog suite runs in
  its own Ubuntu `catalog` job.
- Apple Foundation Models tests run in their own job. The `ios` job resolves
  Swift packages into a cached directory keyed on `Package.resolved`, builds for
  testing once for the generic device and once for the simulator, then runs
  `test-without-building` against the shared DerivedData on one simulator,
  with parallel clones off. iOS-only changes also
  run shipping and TestFlight policies in that job; full desktop runs execute
  them through the preserved regression lane.
- Four desktop lanes use `scripts/ci-test-registry.json`. GitHub allows five
  concurrent macOS jobs on this plan, and macOS is where jobs queue, so on PRs
  `core-git`, `runtime-subagents` and `renderer-other` run on Ubuntu and only the
  `macos` lane runs on macOS. That lane holds every file that fails, skips or
  asserts less off macOS, plus the native helper suites, terminal coverage and
  Rust checks. Main runs all four lanes on macOS, so a macOS-only regression in a
  file that stayed in an Ubuntu lane is caught at merge rather than on its PR.
  When you add a test that only does its work on macOS, put its file in `macos`.
- Every ordinary file in
  the `pretest:serial`/`test:serial` graph belongs to exactly one lane. New files
  require explicit assignment; unknown shell commands, environment changes, test
  flags and root `pretest`/`posttest` hooks fail the inventory check rather than
  silently dropping or duplicating coverage. Validation also discovers every
  `*.test.*` file under `main/`, `renderer/` and `scripts/` on disk: each must be
  reachable from the serial graph, from a registry `workflowScripts` entry (npm
  scripts a workflow runs directly, such as `test:diagnostics` or
  `test:linux-native`, which must still appear as `npm run <script>` in a
  workflow), or from the `manual` allowlist (perf, smoke and Linux D-Bus
  integration files, each with a reason). Prerequisite and preserved ids must be
  unique, so the runner schedules each build once.
- `npm test` runs `scripts/run-ci-tests.mjs --parallel`: prerequisites first, the
  four lanes concurrently with prefixed output (sharing one machine-sized pool
  of Node test workers), then the preserved commands.
  Each registered file runs once. `npm run test:serial` keeps the original chain,
  which runs some files more than once, for comparison.
- When a lane fails, the runner lists its failed tests again after all of its
  output, each with its file, line and error, and adds the list to the job
  summary. A lane's TAP output runs to tens of thousands of lines, so the end of
  the log is where a failure stays findable.
- Browser containment, terminal coverage thresholds, Ruby policy, Rust
  formatting/tests/clippy and native helper production/test builds retain their
  execution modes. Registry validation checks both files and these prerequisites.
- On `main`, merge-group runs and `workflow_dispatch`, Electron files run across
  five isolated macOS runners with one worker each and
  `--fail-on-flaky-tests`, retaining the 20-minute job limit. File-duration weights
  prefer the median of recent hosted Playwright JSON timings (Actions cache plus
  per-shard artifacts, merged on `main` only; CI never pushes timing files).
  Missing or unreadable stores fall back to the conservative `FILE_SECONDS` table
  from hosted runs 41784199399 and 41789418295, then to 30s for a brand-new spec.
  Cancelled terminal windows are lower bounds, never treated as completed timings.
  The completed run 41778188548 independently checks the allocation. A measured
  budget check reserves two minutes for setup/cleanup and at least three minutes
  of headroom; real runner variation can still differ. Newly discovered specs get
  a default weight and always run. A real Playwright collection check verifies
  that every deterministic case belongs to exactly one shard. Live-provider specs
  remain opt-in; production diagnostics run separately with the production profile.
  Pull requests may run a subset of specs (see below); unused shards still start
  and exit successfully so required check names stay stable.
- On pull requests, macOS runs only the specs in the spec map's `macos` list
  (specs that skip or assert less off macOS: the isolated keychain, the iOS
  Simulator device tabs, guided setup's Computer Use and Apple models, and
  Computer Use goals) that the PR selected, on one runner named
  `Electron E2E (1/1)`. When the PR selects none, the job skips and the
  `changes` job reports `mac-e2e=false`, which is the only way **CI required**
  accepts that skip. Every other selected spec runs on the Linux shards, so
  darwin-only branches inside shared specs (such as Meta-modifier shortcuts) are
  checked at merge rather than on the PR, as with the unit lanes. When you add an
  E2E spec that only does its work on macOS, add it to `macos` in
  `scripts/ci-e2e-spec-map.json`.
- Linux runs the same Electron shards on three Ubuntu runners in `linux-e2e`,
  beside the packaging job rather than after it. Any `desktop` or `linux` change
  selects it, so a renderer-only PR runs its E2E specs here. The required `Linux x64` and
  `Linux arm64` checks fail if a selected shard does not pass. Each shard builds
  the app itself, because waiting for the macOS `build` artifact would tie Linux
  to the macOS queue.
- Android retains unit tests, lint, test compilation and emulator coverage, with
  Gradle's build cache enabled and APK publication only on main. Hosted iOS
  compilation is not physical-device XCTest acceptance.

On pull requests only, unit lanes run the registry files whose import graph
reaches a changed path. A quoted path to a source file (`new URL("./x.tsx",
import.meta.url)`, `"main/services/x.ts"`) counts as an import, so a test that
reads a file's source as text is still selected when that file changes.
`path.join("renderer", "preload.ts")` segments and `readdir` of a `main/` or
`renderer/` tree count as well, so a registered inventory test such as
`main/handlers/ipc-contract.test.ts` still runs when a handler it walks
changes. Electron shards run the specs listed for those paths
in `scripts/ci-e2e-spec-map.json`. Pushes to `main`, merge-group runs, releases,
and `workflow_dispatch` keep the full suites. Selection also falls back to the
full suite when a changed path is unmapped, or when shared config, fixtures,
`package.json`, lockfiles, CI files, or test infra change. Empty unit lanes skip
their `tsx --test` invocation but still start. When you add a deterministic
E2E spec, add it to `scripts/ci-e2e-spec-map.json` with the `renderer/` and
`main/` prefixes it covers; CI policy fails if a runnable spec is missing, if
an entry names a spec that no longer exists, or if a listed prefix matches no
file on disk. Shared harness files belong in the map's `full` list so they keep
every spec. Prefixes are exact paths, directories (`settings/`), or stems that
continue with `/`, `.`, or `-` (`chat-fork` matches `chat-fork-service.ts`).
Changing a spec file itself selects that spec. A failed-job rerun downloads the
original `changes` job's selection artifact, not a name built from the rerun
attempt.

Use `node scripts/run-ci-tests.mjs --list` or `--dry-run` to inspect assignments.
Use `--lane core-git`, `--lane runtime-subagents`, `--lane renderer-other`, or
`--lane macos` to reproduce a lane, and `--summary` to report timings. The `macos`
lane needs a Mac. Existing focused npm commands remain available. Browser-dependent
lanes explicitly install Chromium; a warm local browser cache is not proof that
hosted prerequisites are present.

## Measurement and rollout

An advisory report fetches every job page for the current workflow attempt and
summarizes execution, start offsets, per-platform runner-minutes and slow steps.
Start offsets include both dependency waits and runner queueing. API/reporting
failure cannot fail `CI required`. Test lanes also write elapsed summaries.

The September 21 sample of ten successful PR runs had a 25m43s median completion,
25m24s median Electron job and 14m09s median verify job. The older draft ran in
9m16s on a smaller suite; that is not a prediction for today's tests. Compare
multiple comparable full and selected-lane runs, including queue delays, failures,
reruns and total runner usage. Parallelism may trade more runner-minutes for less
waiting. Browser caches, install retries and further Linux migration are follow-up
experiments only if measured overhead or failures justify them.

On 2026-11-04, run [41789418295](https://github.com/sambitcreate/aiden-agent/actions/runs/41789418295)
hit the 20-minute job limit on Electron shard 1 after starting its final case;
GitHub's annotation explicitly identified the job deadline, with no individual
spec failure printed. Its three shards collected 118/80/96 cases. Shards 2 and 3
completed their test steps in 881/684 seconds; shard 1 was cancelled after 1,126
seconds of testing plus setup. The earlier run 41784199399 instead timed out on
shard 3, so refreshing weights from one fast runner alone would conceal the
variance. Four shards using the conservative complete-file measurements project
under 15 minutes each before the setup reserve, while the independent completed
run projects roughly 10–11 minutes. This adds one runner's setup cost in exchange
for headroom. It changes neither test timeouts nor retries; exact-head hosted CI
must still pass.

The Linux x64 job in run [41801806234](https://github.com/sambitcreate/aiden-agent/actions/runs/41801806234/job/126479810811)
failed the flaky-test gate on 2026-11-04: the Usage data persistence check read a
fresh profile's `settings.json` before it existed, then passed on its existing
retry. The switch updates optimistically, so its unchecked state does not prove
that the first settings write has finished. That test now treats only `ENOENT`
as a pending poll result and still requires persisted `analytics.enabled: false`
before relaunching and checking the switch again. A filesystem regression also
requires malformed JSON and other read errors to fail. This changes no product
behavior, test timeout, retry policy or flaky-test gate.

The local proactive suite also exposed a fake-clock ordering failure in the
held-event gap test on 2026-11-04. A fixed 20 ms pause could expire before a
timer's store read finished; the next clock advance then missed a retry timer
registered afterward. The test now gates that read deliberately and waits for
the dispatcher's drain before advancing again. It checks the full five-minute
boundary, exact run order and settled durable receipts without a timing guess.
The production event dispatcher and its limits are unchanged.

Electron shard 2 in run [41813917090](https://github.com/sambitcreate/aiden-agent/actions/runs/41813917090/job/126521250640)
failed the flaky-test gate on the Bot-browser held-tab reveal case: its first
attempt failed the gray-pixel assertion and its existing retry passed. The
fixture showed a new password field after two seconds without establishing that
the periodic held-tab scanner had observed it first. A controlled slow scan
reproduced the unmasked field and text leak under that unsupported premise.
The fixture now waits for the real scanner to finish observing the new password
before the person presses Show, then retains every pixel, no-secret and typing
refusal assertion. Its standalone Electron uses sRGB so exact red controls do
not depend on a host display profile, and pixel snapshots follow two animation
frames after the person's page action rather than assuming load/click means
paint has finished. Production masking, its documented
first-observation limitation, timeouts, retries and the flaky-test gate remain
unchanged.

macOS Electron shard 4 failed the flaky-test gate on the Bot sign-in held-tab
case on PR #838 (run [44480107376](https://github.com/sambitcreate/aiden-agent/actions/runs/44480107376)),
PR #875 (run [45012146127](https://github.com/sambitcreate/aiden-agent/actions/runs/45012146127/job/137213169353))
and PR #876 (run [45013317593](https://github.com/sambitcreate/aiden-agent/actions/runs/45013317593/job/137188222625)):
after the release the Bot got "This tab's password protection was not ready when
it was released". The fixture answered **I'm signed in** as soon as the held tab
reported the callback page loaded, before the browser's own privacy read of that
page had finished. Releasing a held tab whose current page was never inspected
is refused on purpose (a later read cannot tell what a shown password field used
to be), so the fixture raced the product's fail-closed rule rather than finding a
product bug. It now waits for the held tab's read of the callback page, one that
began after the page stopped loading, before the person answers, as the
Bot-browser fixture already does. A person looking at the page answers well after
that read. The release rule, timeouts, retries and the flaky-test gate are
unchanged.

On 2026-11-23 the hosted macOS queue was measured across every CI run since
the self-hosted Mac Studio routing was reverted (#594, 2026-10-28). A full run
does about 25 minutes of work, but pull-request runs took a median of 2 h 08 m
and main runs 7 h 05 m, because macOS jobs waited a median of 40 minutes for one
of the plan's five macOS slots (41% waited over an hour) while Ubuntu jobs
started at once. All five slots were busy 44% of the time, and Electron E2E used
45% of all macOS job minutes. Pull requests therefore stopped running the full
E2E suite on macOS: Linux runs their selected specs and macOS runs only the
macOS-only ones. Main keeps every spec on macOS.

On 2026-11-22 the macOS Electron E2E jobs outgrew four shards. On `main`
(run [45019275411](https://github.com/sambitcreate/aiden-agent/actions/runs/45019275411))
shards 2 and 4 hit the 20-minute job limit, and on PR #882 shard 1 hit it on both
attempts (run [45064649034](https://github.com/sambitcreate/aiden-agent/actions/runs/45064649034)),
each time with no failed test, still running specs when cancelled. The four jobs
of that PR run took about 70 minutes of runner time together, against 57 minutes
on `main` run 45004973683 earlier the same day, so even a perfect four-way split
leaves under two minutes of headroom per job. CI now runs five macOS shards,
which brings an even split to about 14 minutes per job for one more runner
setup. The 20-minute job limit, retries and the flaky-test gate are unchanged.

On 2026-11-11 the flakes that kept `main` red between 2026-11-05 and 2026-11-10
were fixed at their causes, without adding a retry or weakening an assertion.
One wall-clock ceiling was raised; the iOS item says which.

- The design-canvas region test (`renderer-other`, job 129429421249) gave the
  lazy canvas chunk RTL's one-second `waitFor` to load. It now awaits that module
  itself, then leaves only the render after it to `waitFor`. Under 90 concurrent
  runs it failed 87 times before the change and 0 times after.
- Three voice-recorder tests (`renderer-other`, job 127324138476) checked
  `recording` and the live transcript reset straight after `onTranscript`. Those
  updates render from an async `onstop` callback outside `act`, so the checks now
  wait for that render too.
- The subagent shell runner's stalled `setsid` cases (`runtime-subagents`, job
  128208665607) raced the fixture's own one-second bound against the runner's
  two-second deadline. That deadline also covers helper and shell startup, so on
  a slow host it fired first. The fixture runs now take a deadline that only a
  real hang reaches, and the fixture's own bound decides the result.
- Design-canvas text editing (Electron, job 130172496593) reloaded a page under
  the next edit. FSEvents could report the canvas's own write late. The watcher
  now records the digest of each write the canvas makes and drops a report whose
  file still holds those bytes. An event that names no file could also be a
  stylesheet or image beside the page, so it is put down to that write only
  under three conditions:
  - It arrives within three seconds of the write. A report still waiting for
    the quiet period when those seconds pass is judged by when its event
    arrived.
  - Every file beside the page still has the size, inode, and modification and
    change times it had when the write began. The walk skips hidden folders,
    which the watcher ignores, and stops after 500 entries; a larger folder
    counts as changed.
  - None of those files was modified or changed in the three seconds before
    the write began, or since. This catches a stylesheet changed while the
    walk was running, which the walk itself may have taken in, and one changed
    just before the edit whose report arrives late.

  The canvas's write changes only the page itself. Editing two pages in one
  folder within three seconds can still reload the first page once more than
  needed, because its neighbour changed.

  Each page such an event queues is checked on its own. The edited page stays,
  while every other page, and a page whose neighbours changed, is still
  reported. The editor reloads the page itself when no frame shows the change in
  place.
- Terminal docking (Electron, job 130153055685) lost the order of typed input.
  Each keystroke's access check waits on disk, and `ipcMain.handle` lets those
  handlers finish out of order. Input for one session is now written in the
  order it arrived.
- Three iOS foreign-run tests in `AidenChatTests` (jobs 127594787585,
  128145304945 and 130166879005) timed out. Their waits counted 500
  ten-millisecond sleeps on the main actor, while the work they waited on ran
  off it. In those runs ordinary tests took up to 43 seconds on the stalled
  host, and the count ran out before the stub answered. Waits for a lookup to
  finish now await the lookup tasks themselves and then assert the exact
  request count. The remaining condition waits are bounded by 30 seconds of
  wall-clock time, the same failure-only ceiling `waitForRequests` uses. That
  is longer than the old budget of about 5 to 9 seconds. A six-second stub
  stall fails all three tests under the old waits.

Still open. None of these reproduced their CI symptom locally in 10–20 repeats
each:

- `crash-reporting.spec.ts:41`: an unhandled "Target crashed" right after a
  browser tab's renderer is killed (job 130172496756). Locally, 5 of 10
  repeats failed differently: the fixture's first `firstWindow` timed out.
- A first turn that is never answered, in `worktree-folder-deleted.spec.ts:15`
  (job 130053226128).
- `testHeldHomeHTTPResponseCannotReplaceSettlementOrNewerHomeOwner` (job
  127814921450).

Later on 2026-11-11, the last two fixed-count polls in `AidenChatTests` (a
local `waitUntil` and `waitUntil(attempts:)`) took the same 30-second
wall-clock ceiling as `waitForCondition`. Neither had failed yet, but both
counted main-actor turns the same way. The `bots-persistence.spec.ts:10`
failures (jobs 128096428982, 128273572690 and 128292737560, all on
2026-11-07) predate bb90b9125. That change removed about 6.8 seconds of
Keychain calls from each Bot turn, which had pushed the first answer past
the spec's 10-second expectation. It has not failed since, so it is no longer
listed as open.

`AidenChatMarkdownTests.testAPressDuringAStreamIsNotLostToTheNextToken`
failed on 2026-11-11 (job 130752861135). It pressed the copy button after a
fixed 50 ms pause, and the runner had not redrawn the next token yet, so the
press copied the old source. The test now waits, up to the helper's 3-second
ceiling, until the new code text is in the accessibility tree.

`bot-plans.spec.ts:15` failed again on 2026-11-11 (job 130773369673, after
jobs 128235396340 and 128250445861). Chromium's keyboard scroll animates, and a
Home press sent while the End animation was still settling sometimes left the
plan review at the bottom. The review now handles Home and End itself and jumps
straight to its top or bottom, so the test presses Home once and expects the
first step back in view.

The 30-second `waitForCondition` ceiling is an explicit exception to the
AGENTS.md rule against raising timeouts. It applies to all of that helper's
roughly 30 callers in `AidenChatTests`. For the lookup waits it is only a
backstop, because those now await the lookup tasks. For the two "live foreign
output" waits in `testIdleChatAttachesToARunTheRosterAnnouncesAndShowsItLive`
and `testAnnouncedRunNotYetRegisteredIsAttachedByOneRetry`, the longer ceiling
is the whole fix: nothing deterministic was found to wait on instead.

The exception is justified on three counts:
- The wait polls a condition against the wall clock instead of counting
  main-actor turns, so it ends as soon as the output appears and costs nothing
  on a healthy host.
- The old budget was a count of sleeps, not a time. On a stalled CI host it ran
  out after about 5 to 9 seconds, while ordinary tests in those runs took up to
  43 seconds.
- It matches `waitForRequests` (38ab09a53), which already used a 30-second
  wall-clock ceiling.

Replacing those two waits with an expectation the stub fulfils, once it has
served the run's events and the model has shown them, would make the ceiling
bound only a failure there too.

On 2026-11-12 the design-canvas watcher and frame-picture gaps left out of
#793 were closed:

- A folder beside an edited page that is reached through a link now counts as
  changed. The walk never enters a linked folder, so a stylesheet or image
  inside it could change while neither the link nor its target folder did, and
  its one unnamed event inside the three seconds was put down to the canvas.
- The "touched since shortly before the write began" check now reads the
  write's start on the clock that stamps the workspace's files. That offset
  is taken from the page's own times just after the canvas writes it. A
  network volume whose clock runs behind the Mac's could otherwise stamp a
  stylesheet changed during the walk as older than the write.
- A write's note of the files beside its page is let go when its three
  seconds end, not at the next report.
- Of two pictures of one frame captured at once, the one whose capture
  started last is kept, whichever comes back first.
- The "page edited in place" canvas test had polled between `act` calls
  because RTL's `waitFor` hung there, never returning or timing out. The hang
  was the check itself: a failed `assert.equal(iframe, null)` makes Node's
  strict assertion diff happy-dom's whole inspected `<iframe>` against `null`.
  That synchronous diff had not finished after 40 seconds in any local run,
  so neither `waitFor`'s interval nor its timeout could run. The check now compares a
  boolean, as the rest of the file does, and uses `waitFor`.

On 2026-11-20 the macOS Electron E2E startup hang was traced to
`crash-reporting.spec.ts:41`. The hang hit `guided-setup.spec.ts:6` (job
136038828632), `follow-through-lifecycle.spec.ts:30` (job 136069197442) and
`environment-devices-tab.spec.ts:16` on `main` (job 136046189973). In each, the
first launch showed no window within 30 seconds, quitting then hung, and the log
showed `settingsPrepared:false`.

- The crash test ended its app with `process.crash()`. On macOS, ReportCrash
  then spends about 30 seconds on the crashed process and raises a "quit
  unexpectedly" dialog through UserNotificationCenter. An Electron launch that
  overlaps that window reaches `will-finish-launching` but never gets AppKit's
  `applicationDidFinishLaunching`, so `ready` never fires. Its main thread
  waits idle in `-[NSApplication run]`, and `app.quit()` before `ready` never
  completes.
- The hangs began when the shards moved on 2026-11-20, which put another spec's
  launch 30 to 50 seconds after the crash test. In 4 of the 5 jobs where the
  crash test sat just before `environment-devices-tab.spec.ts`, that launch
  hung. None of about 30 jobs that ran other specs straight after it hung.
- A probe workflow reproduced it (run 44680079058, 2 of 2 jobs). The fixture's
  new startup milestones read "will-finish-launching 1065 ms, native ready
  never, Playwright run 1878 ms". This also explains the `firstWindow` timeouts
  in local repeats of the crash test, listed as still open on 2026-11-11.
- The test now ends the process with `SIGKILL` from the same
  `uncaughtExceptionMonitor`, after Aiden's own monitor has written the pending
  crash record. A killed process leaves no crash report and no dialog, and the
  test's assertions do not depend on the signal: the relaunch's `after_crash`
  comes from the unclean-run marker. In the probe's validation run
  (44681438771), three macOS jobs ran the crash test with `SIGKILL` and then
  the device-tab and follow-through specs, three rounds each: all 9 rounds
  passed and no crash dialog appeared. Two control jobs kept `process.crash()`:
  both raised the dialog, and 2 of their 6 rounds hung with "native ready
  never".
- When the first window does not open, the fixture's error now lists the
  startup milestones the bootstrap recorded, so a later hang shows how far
  launch got.

On 2026-11-24 the blocking iOS job was failing or hanging on `main` (job
138014789163) and on PRs that touch no iOS code (#890, #900, #901, #904, #915).
Different tests failed each time, and every failing test had stalled for
minutes on a test that takes a fraction of a second locally:

- `AidenSandboxedHTMLTests.testAPreviewPageMakesNoNetworkConnections` ran
  192 and 345 seconds and missed a 30-second page load (jobs 138345806379,
  138355678757).
- `AidenNativeIntegrationTests.testReconcileEndsAnActivityFromAnOlderPairing`
  ran 128 seconds; its in-memory demo machines took about 95 seconds to
  connect, past the scheduler's 10-second probe (job 138386215673).
- `AidenChatTests.testUploadCleanupRevocationDoesNotDeadlockRemoval` ran 228
  and 596 seconds (job 138014789163, then an `IDERunOperation` crash in
  xcodebuild, and #904's run 45340108118).
- #900's run 45336499109 hung after 2,512 passes with both clones silent until
  the 50-minute limit, and #890's run had a clone time out connecting to
  `com.apple.instruments.deviceservice.lockdown`.

Two causes were fixed:

- The XCTest step ran two parallel simulator clones on the 3-core, 7 GB hosted
  runner. The clones took 6 to 9 minutes to boot before any test ran, and
  then the suite took 1,360 to 1,550 seconds of wall time, more than the 759
  to 1,032 seconds its tests summed to. One test host grows to about 1.6 GB
  over a local full run, so two of them plus WebKit content processes left
  whole test processes stalled. The step now passes
  `-parallel-testing-enabled NO` and runs one simulator, in both iOS jobs.
  Local Xcode keeps the scheme's parallel setting. On one simulator the full
  suite ran in 273 seconds locally (2,569 passed) with the host's load
  average near 130.
- `AidenChatProgressLifecycleURLProtocol.releaseHeldRequest()` only completed
  a request that had already been held. A request that arrived after the
  test's release was still held, with nobody left to release it, so a test
  whose request was late waited on it until the session's request timeout
  instead of failing at its own short wait. Release now ends the hold, and
  each `AidenChatTests` test starts by resetting the fixture's holds,
  overrides and open stream.

Release workflows, signing/notarization, publication and repository protection
settings remain unchanged. The previous draft's release-admission rewrite has
been removed to keep release hardening separate from this CI rollout.

Shared public Remote DTO, parser and limit modules select both native clients even when edited without a server file, including Bot watches, Open work, routine models and their separately served directory, starter Bot presets, peers and resume contracts. Connection cards, message outcome categories, triage patches, approval controls and custom-model inputs also select native validation. Native source comments naming TypeScript files are not a complete contract inventory. Add newly mirrored public contracts to the inventory and cover their single-file classification. Generic host helpers remain on the desktop/CLI/Linux route.
