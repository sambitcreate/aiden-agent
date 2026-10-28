import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

function seconds(start, end) {
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function summarizeJobs(jobs, createdAt) {
  const completed = jobs.filter((job) => job.status === "completed" && job.conclusion !== "skipped");
  const rows = completed.map((job) => ({
    name: job.name,
    result: job.conclusion,
    seconds: seconds(job.started_at, job.completed_at),
    // Includes dependency waits; this is not pure runner queue time.
    startOffset: seconds(createdAt, job.started_at),
    platform: (job.labels ?? []).find((label) => /^(macos|ubuntu|windows)-/u.test(label)) ?? "unknown",
    steps: (job.steps ?? []).filter((step) => step.conclusion !== "skipped").map((step) => ({
      name: step.name,
      seconds: seconds(step.started_at, step.completed_at),
    })),
  }));
  const totals = {};
  for (const row of rows) if (row.seconds !== null) totals[row.platform] = (totals[row.platform] ?? 0) + row.seconds;
  const elapsed = completed.map((job) => seconds(createdAt, job.completed_at)).filter((value) => value !== null);
  return { rows, totals, elapsed: elapsed.length ? Math.max(...elapsed) : null };
}

const cell = (value) => String(value).replaceAll("|", "\\|").replace(/[\r\n]/gu, " ");
const duration = (value) => value === null ? "unavailable" : `${Math.round(value)}s`;

export function renderSummary(summary) {
  const lines = [
    "## CI execution timings",
    "",
    `Elapsed to last completed validation job: **${duration(summary.elapsed)}**.`,
    "Start offsets include dependency and runner waits. Runner totals are execution time, not billing estimates.",
    "",
    "| Job | Result | Execution | Start offset | Runner |",
    "| --- | --- | ---: | ---: | --- |",
    ...summary.rows.map((row) => `| ${cell(row.name)} | ${cell(row.result)} | ${duration(row.seconds)} | ${duration(row.startOffset)} | ${cell(row.platform)} |`),
    "",
    ...Object.entries(summary.totals).map(([platform, total]) => `- ${cell(platform)}: ${(total / 60).toFixed(2)} runner-minutes`),
    "",
    "### Slowest completed steps",
    "",
    ...summary.rows.flatMap((row) => row.steps.map((step) => ({ ...step, job: row.name })))
      .filter((step) => step.seconds !== null)
      .sort((a, b) => b.seconds - a.seconds).slice(0, 15)
      .map((step) => `- ${cell(step.job)} / ${cell(step.name)}: ${duration(step.seconds)}`),
    "",
  ];
  return lines.join("\n");
}

export function collectReport(env = process.env, execute = execFileSync) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !/^\d+$/u.test(run ?? "") || !/^[1-9]\d*$/u.test(attempt ?? "")) {
    throw new Error("Invalid timing API coordinates");
  }
  const api = (endpoint, paginate = false) => JSON.parse(execute("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  }));
  const prefix = `repos/${repository}/actions/runs/${run}/attempts/${attempt}`;
  const metadata = api(prefix);
  const pages = api(`${prefix}/jobs?per_page=100`, true);
  const jobs = pages.flatMap((page) => page.jobs);
  return renderSummary(summarizeJobs(jobs, metadata.run_started_at ?? metadata.created_at));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Observability must never turn passing validation red.
  let report;
  try { report = collectReport(); } catch { report = "CI timing report unavailable: GitHub API request failed.\n"; }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.stdout.write(report);
}
