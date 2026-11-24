import assert from "node:assert/strict";
import test from "node:test";
import {
  collectReport,
  extractFirstFailedTest,
  extractPhaseTimings,
  findFirstFailure,
  renderSummary,
  summarizeJobs,
} from "./ci-timings.mjs";

const attemptStart = "2026-11-24T10:00:00Z";

function makeJob(overrides = {}) {
  return {
    id: 1001,
    name: "Electron E2E (1/5)",
    status: "completed",
    conclusion: "success",
    created_at: "2026-11-24T10:00:25Z",
    started_at: "2026-11-24T10:02:25Z",
    completed_at: "2026-11-24T10:05:25Z",
    html_url: "https://github.com/owner/repo/actions/runs/123/job/1001",
    labels: ["macos-26"],
    steps: [],
    ...overrides,
  };
}

test("timings split wait into queue and waiting on jobs alongside execution and platform totals", () => {
  const changes = makeJob({
    id: 1000,
    name: "Detect changed areas",
    created_at: "2026-11-24T10:00:00Z",
    started_at: "2026-11-24T10:00:04Z",
    completed_at: "2026-11-24T10:00:24Z",
    labels: ["ubuntu-24.04"],
    steps: [{ name: "Detect shared and platform changes", conclusion: "success", started_at: "2026-11-24T10:00:05Z", completed_at: "2026-11-24T10:00:20Z" }],
  });
  const build = makeJob({
    id: 1001,
    name: "Desktop production build",
    created_at: "2026-11-24T10:00:25Z",
    started_at: "2026-11-24T10:02:25Z",
    completed_at: "2026-11-24T10:05:25Z",
    labels: ["macos-26"],
  });
  const e2e = makeJob({
    id: 1002,
    name: "Electron E2E (1/5)",
    created_at: "2026-11-24T10:05:26Z",
    started_at: "2026-11-24T10:09:26Z",
    completed_at: "2026-11-24T10:21:26Z",
    labels: ["macos-26"],
  });
  const skipped = makeJob({ id: 1003, name: "Android build and APK", conclusion: "skipped" });
  const running = makeJob({ id: 1004, name: "CI timing report", status: "in_progress", conclusion: null });

  const summary = summarizeJobs([changes, build, e2e, skipped, running], attemptStart);
  assert.equal(summary.elapsed, 1286);
  assert.equal(summary.rows.length, 3);
  assert.equal(summary.firstFailure, null);

  assert.equal(summary.rows[0].seconds, 20);
  assert.equal(summary.rows[0].queueSeconds, 4);
  assert.equal(summary.rows[0].waitSeconds, 0);
  assert.equal(summary.rows[0].startOffset, 4);

  assert.equal(summary.rows[1].seconds, 180);
  assert.equal(summary.rows[1].queueSeconds, 120);
  assert.equal(summary.rows[1].waitSeconds, 25);
  assert.equal(summary.rows[1].startOffset, 145);

  assert.equal(summary.rows[2].seconds, 720);
  assert.equal(summary.rows[2].queueSeconds, 240);
  assert.equal(summary.rows[2].waitSeconds, 326);
  assert.equal(summary.rows[2].startOffset, 566);

  assert.equal(summary.totals["ubuntu-24.04"], 20);
  assert.equal(summary.totals["macos-26"], 900);

  const markdown = renderSummary(summary);
  assert.match(markdown, /\| Job \| Result \| Execution \| Queue \| Waiting on jobs \| Runner \|/u);
  assert.match(markdown, /\| Electron E2E \(1\/5\) \| success \| 720s \| 240s \| 326s \| macos-26 \|/u);
  assert.doesNotMatch(markdown, /### First failure/u);
});

test("invalid or inverted timestamps are unavailable rather than misleading zeros", () => {
  const missing = makeJob({ created_at: null, started_at: null, completed_at: null });
  const inverted = makeJob({
    name: "Inverted",
    created_at: "2026-11-24T10:02:00Z",
    started_at: "2026-11-24T10:01:00Z",
    completed_at: "2026-11-24T10:03:00Z",
  });
  const summary = summarizeJobs([missing, inverted], attemptStart);
  assert.equal(summary.rows[0].seconds, null);
  assert.equal(summary.rows[0].queueSeconds, null);
  assert.equal(summary.rows[0].waitSeconds, null);
  assert.equal(summary.rows[1].queueSeconds, null);
  assert.equal(summary.rows[1].waitSeconds, 120);
  assert.match(renderSummary(summary), /\| Electron E2E \(1\/5\) \| success \| unavailable \| unavailable \| unavailable \| macos-26 \|/u);
});

test("first failure selects the earliest blocking job over non-blocking and aggregate gates", () => {
  const preview = makeJob({
    id: 2001,
    name: "iOS build and simulator tests (Xcode 27, non-blocking)",
    conclusion: "failure",
    completed_at: "2026-11-24T10:03:00Z",
    steps: [{ number: 6, name: "Run Aiden On The Go XCTest on the simulator", conclusion: "failure", completed_at: "2026-11-24T10:02:55Z" }],
  });
  const unitFail = makeJob({
    id: 2002,
    name: "Desktop tests (core-git)",
    conclusion: "failure",
    completed_at: "2026-11-24T10:05:10Z",
    html_url: "https://github.com/owner/repo/actions/runs/456/job/2002",
    labels: ["ubuntu-24.04"],
    steps: [
      { number: 6, name: "Download test selection", conclusion: "success", completed_at: "2026-11-24T10:01:10Z" },
      { number: 7, name: "Run assigned regression tests and prerequisites", conclusion: "failure", completed_at: "2026-11-24T10:05:08Z" },
    ],
  });
  const laterE2e = makeJob({
    id: 2003,
    name: "Electron E2E (2/5)",
    conclusion: "failure",
    completed_at: "2026-11-24T10:12:00Z",
    steps: [{ number: 10, name: "Run deterministic Electron E2E shard", conclusion: "failure", completed_at: "2026-11-24T10:11:58Z" }],
  });
  const required = makeJob({
    id: 2004,
    name: "CI required",
    conclusion: "failure",
    completed_at: "2026-11-24T10:15:00Z",
    steps: [{ number: 3, name: "Require every selected check to pass", conclusion: "failure", completed_at: "2026-11-24T10:14:59Z" }],
  });

  const logsByJobId = {
    2002: [
      "2026-11-24T10:05:06.1000000Z Failed tests in core-git:tests:",
      "2026-11-24T10:05:06.1000000Z ",
      "2026-11-24T10:05:06.1000000Z not ok preserves queue ordering",
      "2026-11-24T10:05:06.1000000Z   at main/services/queue.test.ts:42:3",
    ].join("\n"),
  };

  const first = findFirstFailure([{ attempt: 1, jobs: [preview, laterE2e, unitFail, required] }], { logsByJobId });
  assert.equal(first.job, "Desktop tests (core-git)");
  assert.equal(first.step, "Run assigned regression tests and prerequisites");
  assert.equal(first.url, "https://github.com/owner/repo/actions/runs/456/job/2002#step:7:1");
  assert.equal(first.failedTest, "preserves queue ordering (main/services/queue.test.ts:42:3)");
  assert.equal(first.rerunPassed, false);

  const markdown = renderSummary(summarizeJobs([preview, unitFail, laterE2e, required], attemptStart, { firstFailure: first }));
  assert.ok(markdown.indexOf("### First failure") < markdown.indexOf("Elapsed to last completed validation job"));
  assert.match(markdown, /\*\*Job:\*\* \[Desktop tests \(core-git\)\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/456\/job\/2002#step:7:1\)/u);
  assert.match(markdown, /\*\*Step:\*\* Run assigned regression tests and prerequisites/u);
  assert.match(markdown, /\*\*First failed test:\*\* `preserves queue ordering \(main\/services\/queue\.test\.ts:42:3\)`/u);
});

test("first failure blames a timed-out cancelled job rather than the aggregate CI required gate", () => {
  const timedOut = makeJob({
    id: 3001,
    name: "Electron E2E (1/5)",
    conclusion: "cancelled",
    completed_at: "2026-11-24T10:20:00Z",
    html_url: "https://github.com/owner/repo/actions/runs/789/job/3001",
    steps: [{ number: 10, name: "Run deterministic Electron E2E shard", conclusion: "cancelled", completed_at: "2026-11-24T10:19:59Z" }],
  });
  const required = makeJob({
    id: 3002,
    name: "CI required",
    conclusion: "failure",
    completed_at: "2026-11-24T10:20:05Z",
    steps: [{ number: 3, name: "Require every selected check to pass", conclusion: "failure", completed_at: "2026-11-24T10:20:04Z" }],
  });
  const first = findFirstFailure([{ attempt: 1, jobs: [timedOut, required] }]);
  assert.equal(first.job, "Electron E2E (1/5)");
  assert.equal(first.conclusion, "cancelled");
  assert.equal(first.step, "Run deterministic Electron E2E shard");
});

test("report surfaces attempt 1 first failure even when attempt 2 rerun passed, while keeping attempt 2 timings isolated", () => {
  const attempt1Failed = makeJob({
    id: 4101,
    name: "Electron E2E (4/5)",
    conclusion: "failure",
    created_at: "2026-11-24T10:01:00Z",
    started_at: "2026-11-24T10:02:00Z",
    completed_at: "2026-11-24T10:10:00Z",
    html_url: "https://github.com/owner/repo/actions/runs/900/job/4101",
    steps: [{ number: 9, name: "Run deterministic Electron E2E shard", conclusion: "failure", completed_at: "2026-11-24T10:09:58Z" }],
  });
  const attempt2Passed = makeJob({
    id: 4201,
    name: "Electron E2E (4/5)",
    conclusion: "success",
    created_at: "2026-11-24T10:20:05Z",
    started_at: "2026-11-24T10:21:05Z",
    completed_at: "2026-11-24T10:26:05Z",
    html_url: "https://github.com/owner/repo/actions/runs/900/job/4201",
    steps: [{ number: 9, name: "Run deterministic Electron E2E shard", conclusion: "success", started_at: "2026-11-24T10:21:10Z", completed_at: "2026-11-24T10:26:00Z" }],
  });
  const attempt2Required = makeJob({
    id: 4202,
    name: "CI required",
    conclusion: "success",
    created_at: "2026-11-24T10:26:06Z",
    started_at: "2026-11-24T10:26:10Z",
    completed_at: "2026-11-24T10:26:20Z",
    labels: ["ubuntu-24.04"],
  });

  const calls = [];
  const execute = (command, args) => {
    calls.push([command, args]);
    const endpoint = args.at(-1);
    if (endpoint === "repos/owner/repo/actions/runs/900/attempts/2") {
      return JSON.stringify({ run_started_at: "2026-11-24T10:20:00Z" });
    }
    if (endpoint === "repos/owner/repo/actions/runs/900/attempts/2/jobs?per_page=100") {
      return JSON.stringify([{ jobs: [attempt2Passed] }, { jobs: [attempt2Required] }]);
    }
    if (endpoint === "repos/owner/repo/actions/runs/900/attempts/1/jobs?per_page=100") {
      return JSON.stringify([{ jobs: [attempt1Failed] }]);
    }
    if (endpoint === "repos/owner/repo/actions/jobs/4101/logs") {
      return [
        "2026-11-24T10:09:50.000Z   1) tests/e2e/bot-plans.spec.ts:15:5 › plan review jumps back to top on Home ───",
        "2026-11-24T10:09:51.000Z     Error: expect(locator).toBeInViewport() failed",
      ].join("\n");
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const report = collectReport(
    { GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "2" },
    execute,
  );
  assert.match(report, /### First failure/u);
  assert.match(report, /\[Electron E2E \(4\/5\)\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/900\/job\/4101#step:9:1\) \(`failure`, attempt 1 — rerun passed on attempt 2\)/u);
  assert.match(report, /\*\*Step:\*\* Run deterministic Electron E2E shard/u);
  assert.match(report, /\*\*First failed test:\*\* `tests\/e2e\/bot-plans\.spec\.ts:15:5 › plan review jumps back to top on Home`/u);
  // Attempt 2 timings only: 300s (5.00 runner-minutes), not attempt 1's 480s + 300s.
  assert.match(report, /\| Electron E2E \(4\/5\) \| success \| 300s \| 60s \| 5s \| macos-26 \|/u);
  assert.match(report, /- macos-26: 5\.00 runner-minutes/u);
  assert.equal(calls.filter(([, args]) => args.at(-1).endsWith("/logs")).length, 1);
});

test("blocking failure in a later attempt outranks an earlier non-blocking failure across reruns", () => {
  const attempt1NonBlocking = makeJob({
    id: 4301,
    name: "iOS build and simulator tests (Xcode 27, non-blocking)",
    conclusion: "failure",
    completed_at: "2026-11-24T10:05:00Z",
    html_url: "https://github.com/owner/repo/actions/runs/901/job/4301",
    steps: [{ number: 8, name: "Run Aiden On The Go XCTest on the simulator", conclusion: "failure", completed_at: "2026-11-24T10:04:58Z" }],
  });
  const attempt2Blocking = makeJob({
    id: 4302,
    name: "Desktop tests (core-git)",
    conclusion: "failure",
    completed_at: "2026-11-24T10:15:00Z",
    html_url: "https://github.com/owner/repo/actions/runs/901/job/4302",
    labels: ["ubuntu-24.04"],
    steps: [{ number: 7, name: "Run assigned regression tests and prerequisites", conclusion: "failure", completed_at: "2026-11-24T10:14:58Z" }],
  });
  const attempt3Passed = makeJob({
    id: 4303,
    name: "Desktop tests (core-git)",
    conclusion: "success",
    created_at: "2026-11-24T10:25:05Z",
    started_at: "2026-11-24T10:25:10Z",
    completed_at: "2026-11-24T10:28:10Z",
    labels: ["ubuntu-24.04"],
  });

  // Attempt 1 non-blocking + attempt 2 blocking (current): reports attempt 2 blocking, rerunPassed=false.
  const twoAttempts = findFirstFailure(
    [
      { attempt: 1, jobs: [attempt1NonBlocking] },
      { attempt: 2, jobs: [attempt2Blocking] },
    ],
    { currentAttempt: 2, currentJobs: [attempt2Blocking] },
  );
  assert.equal(twoAttempts.job, "Desktop tests (core-git)");
  assert.equal(twoAttempts.attempt, 2);
  assert.equal(twoAttempts.rerunPassed, false);

  // Across 3 attempts in collectReport, attempt 1's non-blocking failure must not stop scanning attempt 2.
  const execute = (_command, args) => {
    const endpoint = args.at(-1);
    if (endpoint === "repos/owner/repo/actions/runs/901/attempts/3") {
      return JSON.stringify({ run_started_at: "2026-11-24T10:25:00Z" });
    }
    if (endpoint === "repos/owner/repo/actions/runs/901/attempts/3/jobs?per_page=100") {
      return JSON.stringify([{ jobs: [attempt3Passed] }]);
    }
    if (endpoint === "repos/owner/repo/actions/runs/901/attempts/1/jobs?per_page=100") {
      return JSON.stringify([{ jobs: [attempt1NonBlocking] }]);
    }
    if (endpoint === "repos/owner/repo/actions/runs/901/attempts/2/jobs?per_page=100") {
      return JSON.stringify([{ jobs: [attempt2Blocking] }]);
    }
    if (endpoint === "repos/owner/repo/actions/jobs/4302/logs") {
      return "not ok 1 - rejects stale lock\n";
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  const report = collectReport(
    { GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "901", GITHUB_RUN_ATTEMPT: "3" },
    execute,
  );
  assert.match(report, /\[Desktop tests \(core-git\)\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/901\/job\/4302#step:7:1\) \(`failure`, attempt 2 — rerun passed on attempt 3\)/u);
  assert.match(report, /\*\*First failed test:\*\* `rejects stale lock`/u);
});

test("report on green attempt 1 paginates current attempt only and validates coordinates", () => {
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, args]);
    return JSON.stringify(
      args.includes("--paginate")
        ? [{ jobs: [makeJob()] }, { jobs: [makeJob({ id: 1002, name: "Second page" })] }]
        : { run_started_at: attemptStart },
    );
  };
  const report = collectReport({ GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" }, execute);
  assert.match(report, /Second page/u);
  assert.doesNotMatch(report, /### First failure/u);
  assert.ok(calls.every(([, args]) => args.at(-1).includes("/attempts/1")));
  assert.throws(() => collectReport({ GITHUB_REPOSITORY: "--bad" }, execute), /coordinates/u);
});

test("extractFirstFailedTest recognizes unit, Playwright, XCTest, Gradle, Rust and annotation logs", () => {
  const esc = String.fromCharCode(0x1b);
  assert.equal(
    extractFirstFailedTest(`${esc}[31m  1) [chromium] › tests/generative-ui/containment.spec.ts:51:1 › sandbox blocks fetch ───${esc}[0m`),
    "tests/generative-ui/containment.spec.ts:51:1 › sandbox blocks fetch",
  );
  assert.equal(
    extractFirstFailedTest("  1 flaky\n    tests/e2e/usage-data.spec.ts:18:3 › persists opt-out across relaunch\n"),
    "tests/e2e/usage-data.spec.ts:18:3 › persists opt-out across relaunch",
  );
  assert.equal(
    extractFirstFailedTest("2026-11-24T10:05:00Z Test Case '-[AidenChatTests.ForeignRunTests testAttachesLive]' failed (30.012 seconds)."),
    "-[AidenChatTests.ForeignRunTests testAttachesLive]",
  );
  assert.equal(
    extractFirstFailedTest("2026-11-24T10:05:00Z Test case 'AidenChatMarkdownTests.testCopyButton()' failed on 'Clone 1 of iPhone 16' (1.2s)"),
    "AidenChatMarkdownTests.testCopyButton()",
  );
  assert.equal(
    extractFirstFailedTest("com.aiden.app.ChatScreenTest > rendersReply FAILED"),
    "com.aiden.app.ChatScreenTest > rendersReply",
  );
  assert.equal(
    extractFirstFailedTest("test worktree_remover::rejects_symlink ... FAILED"),
    "worktree_remover::rejects_symlink",
  );
  assert.equal(
    extractFirstFailedTest("not ok 1 - skipped todo # TODO\nnot ok 2 - actual failure\n"),
    "actual failure",
  );
  assert.equal(
    extractFirstFailedTest("::error title=Process completed with exit code 1.::\n::error title=AidenShellUITests/testLaunch::Timed out\n"),
    "AidenShellUITests/testLaunch",
  );
  assert.equal(extractFirstFailedTest("npm error code 1\nBuild failed without running tests.\n"), null);
});

test("extractPhaseTimings parses chart test phases and identifies stalled iOS simulator boot", () => {
  const chartLog = [
    "2026-11-24T10:04:01.000Z # [phase] chart test / browser launch: started",
    "2026-11-24T10:04:01.420Z # [phase] chart test / browser launch: 420ms (ok)",
    "2026-11-24T10:04:01.421Z # [phase] chart test / page ready: started",
    "2026-11-24T10:04:16.001Z # [phase] chart test / page ready: 14580ms (failed)",
    "2026-11-24T10:04:16.002Z # [phase] chart test / close: started",
    "2026-11-24T10:04:16.057Z # [phase] chart test / close: 55ms (ok)",
  ].join("\n");
  assert.deepEqual(extractPhaseTimings(chartLog), [
    { scope: "chart test", phase: "browser launch", status: "ok", durationMs: 420 },
    { scope: "chart test", phase: "page ready", status: "failed", durationMs: 14580 },
    { scope: "chart test", phase: "close", status: "ok", durationMs: 55 },
  ]);

  const stalledIosJob = makeJob({
    id: 5001,
    name: "iOS build and simulator tests",
    conclusion: "cancelled",
    completed_at: "2026-11-24T10:50:00Z",
    html_url: "https://github.com/owner/repo/actions/runs/999/job/5001",
    steps: [
      { number: 6, name: "Compile Aiden On The Go tests for generic iOS hardware", conclusion: "success", completed_at: "2026-11-24T10:04:00Z" },
      { number: 8, name: "Build Aiden On The Go tests for the simulator", conclusion: "success", completed_at: "2026-11-24T10:07:00Z" },
      { number: 9, name: "Boot iPhone simulator", conclusion: "cancelled", completed_at: "2026-11-24T10:49:59Z" },
    ],
  });
  const stalledIosLog = [
    "2026-11-24T10:02:25.000Z [phase] ios / build (device): started",
    "2026-11-24T10:04:00.000Z [phase] ios / build (device): 95s (ok)",
    "2026-11-24T10:05:10.000Z [phase] ios / build (simulator): started",
    "2026-11-24T10:07:00.000Z [phase] ios / build (simulator): 110s (ok)",
    "2026-11-24T10:07:01.000Z [phase] ios / simulator boot: started",
  ].join("\n");

  const first = findFirstFailure([{ attempt: 1, jobs: [stalledIosJob] }], { logsByJobId: { 5001: stalledIosLog } });
  assert.equal(first.job, "iOS build and simulator tests");
  assert.equal(first.step, "Boot iPhone simulator");
  assert.deepEqual(first.phases, [
    { scope: "ios", phase: "build (device)", status: "ok", durationMs: 95000 },
    { scope: "ios", phase: "build (simulator)", status: "ok", durationMs: 110000 },
    { scope: "ios", phase: "simulator boot", status: "stalled", durationMs: null },
  ]);

  const markdown = renderSummary(summarizeJobs([stalledIosJob], attemptStart, { firstFailure: first }));
  assert.match(markdown, /\*\*Phases:\*\* ios \/ build \(device\) 95s \(ok\) → ios \/ build \(simulator\) 110s \(ok\) → ios \/ simulator boot \*\*stalled\*\*/u);
});
