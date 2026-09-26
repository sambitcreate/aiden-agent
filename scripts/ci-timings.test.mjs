import assert from "node:assert/strict";
import test from "node:test";
import { collectReport, renderSummary, summarizeJobs } from "./ci-timings.mjs";

const start = "2026-09-21T10:00:00Z";
const job = { name: "Electron", status: "completed", conclusion: "success", started_at: "2026-09-21T10:01:00Z", completed_at: "2026-09-21T10:03:00Z", labels: ["macos-26"], steps: [] };

test("timings separate elapsed time, start offset and summed platform execution", () => {
  const summary = summarizeJobs([job, { ...job, name: "Other" }, { ...job, conclusion: "skipped" }, { ...job, status: "in_progress" }], start);
  assert.equal(summary.elapsed, 180);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows[0].startOffset, 60);
  assert.equal(summary.totals["macos-26"], 240);
});

test("invalid timestamps are unavailable rather than misleading zeros", () => {
  const summary = summarizeJobs([{ ...job, started_at: null, completed_at: null }], start);
  assert.equal(summary.elapsed, null);
  assert.equal(summary.rows[0].seconds, null);
  assert.deepEqual(summary.totals, {});
  assert.match(renderSummary(summary), /unavailable/u);
});

test("report fetches every job page from the current attempt only", () => {
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, args]);
    return JSON.stringify(args.includes("--paginate") ? [{ jobs: [job] }, { jobs: [{ ...job, name: "Second page" }] }] : { run_started_at: start });
  };
  const report = collectReport({ GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }, execute);
  assert.match(report, /Second page/u);
  assert.ok(calls.every(([, args]) => args.at(-1).includes("/attempts/2")));
  assert.throws(() => collectReport({ GITHUB_REPOSITORY: "--bad" }, execute), /coordinates/u);
});
