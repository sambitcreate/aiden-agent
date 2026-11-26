import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "cancelled"]);
const STEP_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"]);
const MAX_PRIOR_ATTEMPTS = 5;
const COLLECT_BUDGET_MS = 180_000;
const MAX_CLOCK_SKEW_SECONDS = 5;
const MAX_LOG_LINE_LENGTH = 4096;
const MAX_FAILED_TEST_LENGTH = 200;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");
const GENERIC_ANNOTATION = /^(?:Process completed with exit code\b|Error$)/iu;

function seconds(start, end) {
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function secondsAllowingSmallSkew(start, end, maxSkewSeconds = MAX_CLOCK_SKEW_SECONDS) {
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  if (!Number.isFinite(value)) return null;
  if (value >= 0) return value;
  return value >= -maxSkewSeconds ? 0 : null;
}

function timestampMs(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function belongsToAttempt(job, attemptNumber, attemptStart = null) {
  if (attemptNumber !== null && job.run_attempt !== undefined && job.run_attempt !== attemptNumber) {
    return false;
  }
  const attemptStartMs = Date.parse(attemptStart ?? "");
  if (!Number.isFinite(attemptStartMs)) return true;
  // GitHub rewrites run_attempt and created_at on copied jobs during partial reruns,
  // while leaving completed_at at the earlier attempt's completion time.
  const completedMs = Date.parse(job.completed_at ?? "");
  if (Number.isFinite(completedMs) && completedMs < attemptStartMs) {
    return false;
  }
  return true;
}

function cleanLogLine(line) {
  return line
    .replace(/\r$/u, "")
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /u, "")
    .replace(ANSI_ESCAPE, "");
}

function sanitizeInline(value) {
  const collapsed = String(value).replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_FAILED_TEST_LENGTH ? `${collapsed.slice(0, MAX_FAILED_TEST_LENGTH - 1)}…` : collapsed;
}

function failureTier(jobName) {
  const name = String(jobName ?? "");
  if (/\bnon-blocking\b|^CI timing report$/iu.test(name)) return 2;
  if (/^(?:CI required|Linux (?:x64|arm64))$/u.test(name)) return 1;
  return 0;
}

function stepUrl(jobUrl, step) {
  if (typeof jobUrl !== "string" || !/^https:\/\//u.test(jobUrl)) return null;
  if (Number.isInteger(step?.number) && step.number > 0 && /^https:\/\/[^#]+\/job\/\d+$/u.test(jobUrl)) {
    return `${jobUrl}#step:${step.number}:1`;
  }
  return jobUrl;
}

function stripPlaywrightSuffixes(value) {
  let text = String(value).trimEnd();
  // Strip trailing duration (e.g. "(2.3s)", "(450ms)") and/or "(retry #N)" in either order.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text
      .replace(/\s+\(\d+(?:\.\d+)?\s*(?:ms|s|m)\)$/iu, "")
      .replace(/\s+\(retry #\d+\)$/iu, "")
      .trimEnd();
    if (next === text) break;
    text = next;
  }
  return text;
}

function unescapeAnnotationProperty(value) {
  return String(value).replace(/%(3A|2C|0D|0A|25)/giu, (match, hex) => {
    switch (hex.toUpperCase()) {
      case "3A": return ":";
      case "2C": return ",";
      case "0D": return "\r";
      case "0A": return "\n";
      case "25": return "%";
      default: return match;
    }
  });
}

function extractAnnotationFallback(line) {
  const runnerError = /^##\[error\](.+)$/u.exec(line);
  if (runnerError) {
    const text = runnerError[1].trim();
    return text && !GENERIC_ANNOTATION.test(text) ? sanitizeInline(text) : null;
  }
  if (line.startsWith("::error::") || /^::error\s/u.test(line)) {
    const sep = line.indexOf("::", 7);
    if (sep >= 7) {
      const props = line.slice(7, sep).trim();
      const message = unescapeAnnotationProperty(line.slice(sep + 2)).trim();
      const titleMatch = /(?:^|,)title=([^,]*)/u.exec(props);
      const title = titleMatch ? unescapeAnnotationProperty(titleMatch[1]).trim() : "";
      if (title && !GENERIC_ANNOTATION.test(title)) return sanitizeInline(title);
      if (message && !GENERIC_ANNOTATION.test(message)) return sanitizeInline(message);
    }
  }
  return null;
}

export function extractFirstFailedTest(log) {
  if (typeof log !== "string" || !log) return null;
  const rawLines = log.split(/\r?\n/u);
  const lines = [];
  for (const rawLine of rawLines) {
    if (rawLine.length > MAX_LOG_LINE_LENGTH) {
      lines.push(null);
      continue;
    }
    const cleaned = cleanLogLine(rawLine);
    lines.push(cleaned.length > MAX_LOG_LINE_LENGTH ? null : cleaned);
  }

  // Prefer Aiden's unit failure digest when present: it skips parent suite wrappers and includes file:line.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === null || !/^Failed tests in .+:/u.test(line)) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate === null) continue;
      const match = /^not ok (.+)$/u.exec(candidate);
      if (!match) continue;
      const nextLine = lines[cursor + 1];
      const where = typeof nextLine === "string" ? /^\s+at (.+)$/u.exec(nextLine) : null;
      return sanitizeInline(where ? `${match[1]} (${where[1]})` : match[1]);
    }
  }

  let inPlaywrightSummary = false;
  let afterRubyFailure = false;
  let annotationFallback = null;

  for (const line of lines) {
    if (line === null) {
      afterRubyFailure = false;
      continue;
    }
    if (/^\s*\d+\s+(?:failed|flaky|timed out)\b/iu.test(line)) {
      inPlaywrightSummary = true;
      continue;
    }
    if (inPlaywrightSummary && line.trim() !== "" && !/^\s+/u.test(line)) {
      inPlaywrightSummary = false;
    }

    if (afterRubyFailure) {
      const rubyName = /^([A-Za-z0-9_:]+#[A-Za-z0-9_?!]+)/u.exec(line.trim());
      afterRubyFailure = false;
      if (rubyName) return sanitizeInline(rubyName[1]);
    }
    if (/^\s*\d+\)\s+(?:Failure|Error):\s*$/u.test(line)) {
      afterRubyFailure = true;
      continue;
    }

    const playwrightNumbered = /^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(\S+\.(?:spec|test)\.[cm]?[jt]sx?:\d+(?::\d+)?\s+›\s+.+?)(?:\s+─+)?\s*$/u.exec(line);
    if (playwrightNumbered) return sanitizeInline(stripPlaywrightSuffixes(playwrightNumbered[1]));

    const playwrightMark = /^\s*[✘×]\s+(?:\d+\s+)?(?:\[[^\]]+\]\s+›\s+)?(\S+\.(?:spec|test)\.[cm]?[jt]sx?:\d+(?::\d+)?\s+›\s+.+?)\s*$/u.exec(line);
    if (playwrightMark) return sanitizeInline(stripPlaywrightSuffixes(playwrightMark[1]));

    if (inPlaywrightSummary) {
      const playwrightSummary = /^\s+(?:\[[^\]]+\]\s+›\s+)?(\S+\.(?:spec|test)\.[cm]?[jt]sx?:\d+(?::\d+)?\s+›\s+.+?)\s*$/u.exec(line);
      if (playwrightSummary) return sanitizeInline(stripPlaywrightSuffixes(playwrightSummary[1]));
    }

    const xctest = /Test [Cc]ase '([^']+)' failed\b/u.exec(line);
    if (xctest) return sanitizeInline(xctest[1]);

    const swiftTesting = /^\s*[✘×]\s+Test "([^"]+)" failed\b/u.exec(line);
    if (swiftTesting) return sanitizeInline(swiftTesting[1]);

    const trimmedEnd = line.trimEnd();
    if (trimmedEnd.endsWith(" FAILED")) {
      const beforeFailed = trimmedEnd.slice(0, -" FAILED".length).trimEnd();
      const gradle = /^\s*([A-Za-z0-9_.$]+\s+>\s+.+)$/u.exec(beforeFailed);
      if (gradle) return sanitizeInline(gradle[1]);
    }

    const cargo = /^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/u.exec(line);
    if (cargo) return sanitizeInline(cargo[1]);

    const rubyInline = /^Failure:\s*([^\s(]+\([^)]+\))/u.exec(line);
    if (rubyInline) return sanitizeInline(rubyInline[1]);

    const tap = /^\s*not ok \d+ - (.+)$/u.exec(line);
    if (tap && !/#\s*(?:TODO|SKIP)\b/iu.test(tap[1])) return sanitizeInline(tap[1]);

    const nodeSpec = /^\s*[✖×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?\s*$/u.exec(line);
    if (nodeSpec && !/^(?:failing tests:?|cancelled\b)/iu.test(nodeSpec[1].trim())) {
      return sanitizeInline(nodeSpec[1]);
    }

    if (!annotationFallback) {
      annotationFallback = extractAnnotationFallback(line);
    }
  }

  return annotationFallback;
}

export function extractPhaseTimings(log) {
  if (typeof log !== "string" || !log) return [];
  const entries = [];
  for (const rawLine of log.split(/\r?\n/u)) {
    if (rawLine.length > MAX_LOG_LINE_LENGTH) continue;
    const line = cleanLogLine(rawLine).trim().replace(/^(?:(?!\[phase\])\[[\w-]+\]\s+|#\s+)/u, "");
    const started = /^\[phase\]\s+(.+?)\s*\/\s*(.+?):\s+started$/u.exec(line);
    if (started) {
      entries.push({ scope: started[1].trim(), phase: started[2].trim(), status: "stalled", durationMs: null });
      continue;
    }
    const finished = /^\[phase\]\s+(.+?)\s*\/\s*(.+?):\s+(\d+(?:\.\d+)?)(ms|s)\s+\((ok|failed)\)$/u.exec(line);
    if (finished) {
      const scope = finished[1].trim();
      const phase = finished[2].trim();
      const rawValue = Number(finished[3]);
      const durationMs = Number.isFinite(rawValue) && rawValue >= 0
        ? Math.round(finished[4] === "s" ? rawValue * 1000 : rawValue)
        : null;
      const status = finished[5];
      let target = null;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].scope === scope && entries[index].phase === phase && entries[index].status === "stalled") {
          target = entries[index];
          break;
        }
      }
      if (target) {
        target.status = status;
        target.durationMs = durationMs;
      } else {
        entries.push({ scope, phase, status, durationMs });
      }
    }
  }
  return entries;
}

export function findFirstFailure(attempts, options = {}) {
  const ordered = [...attempts].sort((a, b) => a.attempt - b.attempt);
  const currentAttempt = options.currentAttempt ?? (ordered.at(-1)?.attempt ?? 1);
  const rawCurrentJobs = options.currentJobs ?? (ordered.find((entry) => entry.attempt === currentAttempt)?.jobs ?? []);
  const currentJobs = rawCurrentJobs.filter((job) => belongsToAttempt(job, currentAttempt, options.currentAttemptStart ?? null));
  const getLog = typeof options.logsByJobId === "function"
    ? options.logsByJobId
    : (job) => (options.logsByJobId && job?.id !== undefined ? options.logsByJobId[job.id] ?? null : null);

  const candidates = [];
  for (const entry of ordered) {
    const attemptStart = entry.runStartedAt ?? (entry.attempt === currentAttempt ? options.currentAttemptStart ?? null : null);
    const failedJobs = (entry.jobs ?? [])
      .filter((job) => belongsToAttempt(job, entry.attempt, attemptStart) && job.status === "completed" && FAILURE_CONCLUSIONS.has(job.conclusion));
    for (const [index, job] of failedJobs.entries()) {
      const step = (job.steps ?? []).find((candidate) => STEP_FAILURE_CONCLUSIONS.has(candidate.conclusion)) ?? null;
      const failedAt = timestampMs(step?.completed_at ?? step?.started_at ?? job.completed_at ?? job.started_at);
      candidates.push({
        attempt: entry.attempt,
        tier: failureTier(job.name),
        job,
        step,
        failedAt,
        index,
      });
    }
  }
  if (candidates.length === 0) return null;

  const currentBlocking = candidates.filter((candidate) => candidate.attempt === currentAttempt && candidate.tier < 2);
  const priorBlocking = candidates.filter((candidate) => candidate.attempt < currentAttempt && candidate.tier < 2);
  const currentNonBlocking = candidates.filter((candidate) => candidate.attempt === currentAttempt && candidate.tier >= 2);
  const priorNonBlocking = candidates.filter((candidate) => candidate.attempt < currentAttempt && candidate.tier >= 2);

  const pool = currentBlocking.length > 0
    ? currentBlocking
    : priorBlocking.length > 0
      ? priorBlocking
      : currentNonBlocking.length > 0
        ? currentNonBlocking
        : priorNonBlocking;

  pool.sort(
    (a, b) => a.tier - b.tier || a.attempt - b.attempt || a.failedAt - b.failedAt || a.index - b.index,
  );
  const { attempt, tier, job, step } = pool[0];
  const nonBlocking = tier >= 2;
  const log = getLog(job);
  const currentBlockingFailures = currentBlocking.length > 0;
  const sameJobFailedAgain = currentJobs.some(
    (candidate) => candidate.status === "completed"
      && candidate.name === job.name
      && FAILURE_CONCLUSIONS.has(candidate.conclusion),
  );
  const currentHasSuccess = currentJobs.some(
    (candidate) => candidate.status === "completed" && candidate.conclusion === "success",
  );
  const rerunPassed = attempt < currentAttempt && !currentBlockingFailures && !sameJobFailedAgain && currentHasSuccess;

  return {
    attempt,
    currentAttempt,
    rerunPassed,
    nonBlocking,
    job: job.name,
    jobId: job.id ?? null,
    conclusion: job.conclusion,
    step: step?.name ?? null,
    stepNumber: step?.number ?? null,
    failedTest: extractFirstFailedTest(log),
    url: stepUrl(job.html_url, step),
    phases: extractPhaseTimings(log),
  };
}

export function summarizeJobs(jobs, createdAt, options = {}) {
  const currentAttempt = Number.isInteger(options.currentAttempt) ? options.currentAttempt : null;
  const attemptJobs = jobs.filter((job) => belongsToAttempt(job, currentAttempt, createdAt));
  const completed = attemptJobs.filter((job) => job.status === "completed" && job.conclusion !== "skipped");
  const rows = completed.map((job) => ({
    name: job.name,
    result: job.conclusion,
    seconds: seconds(job.started_at, job.completed_at),
    queueSeconds: seconds(job.created_at, job.started_at),
    waitSeconds: secondsAllowingSmallSkew(createdAt, job.created_at),
    // Total wait before execution (waiting on jobs + runner queue).
    startOffset: secondsAllowingSmallSkew(createdAt, job.started_at),
    platform: (job.labels ?? []).find((label) => /^(macos|ubuntu|windows)-/u.test(label)) ?? "unknown",
    steps: (job.steps ?? []).filter((step) => step.conclusion !== "skipped").map((step) => ({
      name: step.name,
      seconds: seconds(step.started_at, step.completed_at),
    })),
  }));
  const totals = {};
  for (const row of rows) if (row.seconds !== null) totals[row.platform] = (totals[row.platform] ?? 0) + row.seconds;
  const elapsed = completed.map((job) => secondsAllowingSmallSkew(createdAt, job.completed_at)).filter((value) => value !== null);
  const firstFailure = options.firstFailure !== undefined
    ? options.firstFailure
    : findFirstFailure(
        [{ attempt: currentAttempt ?? 1, jobs: attemptJobs, runStartedAt: createdAt }],
        { currentAttempt: currentAttempt ?? 1, currentJobs: attemptJobs, currentAttemptStart: createdAt },
      );
  const phaseTimings = options.phaseTimings ?? [];
  return {
    rows,
    totals,
    elapsed: elapsed.length ? Math.max(...elapsed) : null,
    firstFailure,
    phaseTimings,
  };
}

const cell = (value) => String(value).replaceAll("|", "\\|").replace(/[\r\n]/gu, " ");
const inlineCode = (value) => {
  const text = String(value).replace(/[\r\n]/gu, " ");
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
};
const safeLink = (label, url) => (
  typeof url === "string" && /^https:\/\/[^\s)]+$/u.test(url)
    ? `[${cell(label)}](${url})`
    : cell(label)
);
const duration = (value) => (value === null ? "unavailable" : `${Math.round(value)}s`);

function formatPhaseDuration(durationMs) {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "unavailable";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return durationMs % 1000 === 0 ? `${Math.round(durationMs / 1000)}s` : `${(durationMs / 1000).toFixed(2)}s`;
}

function formatPhaseEntry(entry) {
  const label = `${cell(entry.scope)} / ${cell(entry.phase)}`;
  if (entry.status === "stalled") return `${label} **stalled**`;
  return `${label} ${formatPhaseDuration(entry.durationMs)} (${cell(entry.status)})`;
}

function renderFirstFailure(failure) {
  if (!failure) return [];
  const heading = failure.nonBlocking ? "### Non-blocking failure" : "### First failure";
  const attemptNote = failure.rerunPassed
    ? `attempt ${failure.attempt} — rerun passed on attempt ${failure.currentAttempt}`
    : failure.currentAttempt > 1
      ? `attempt ${failure.attempt} of ${failure.currentAttempt}`
      : `attempt ${failure.attempt}`;
  const lines = [
    heading,
    "",
    `- **Job:** ${safeLink(failure.job, failure.url)} (${inlineCode(failure.conclusion)}, ${attemptNote})`,
    `- **Step:** ${failure.step ? cell(failure.step) : "unavailable"}`,
    `- **First failed test:** ${failure.failedTest ? inlineCode(failure.failedTest) : "unavailable"}`,
  ];
  if (failure.phases?.length) {
    lines.push(`- **Phases:** ${failure.phases.map(formatPhaseEntry).join(" → ")}`);
  }
  lines.push("");
  return lines;
}

export function renderSummary(summary) {
  const lines = [
    "## CI execution timings",
    "",
    ...renderFirstFailure(summary.firstFailure),
    `Elapsed to last completed validation job: **${duration(summary.elapsed)}**.`,
    "Queue is runner wait (job created to started); waiting on jobs is time from attempt start until the job was created. Runner totals are execution time, not billing estimates.",
    "",
    "| Job | Result | Execution | Queue | Waiting on jobs | Runner |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...summary.rows.map((row) => `| ${cell(row.name)} | ${cell(row.result)} | ${duration(row.seconds)} | ${duration(row.queueSeconds)} | ${duration(row.waitSeconds)} | ${cell(row.platform)} |`),
    "",
    ...Object.entries(summary.totals).map(([platform, total]) => `- ${cell(platform)}: ${(total / 60).toFixed(2)} runner-minutes`),
    "",
    ...(summary.phaseTimings?.length
      ? [
          "### Phase timings",
          "",
          ...summary.phaseTimings.map((entry) => `- ${formatPhaseEntry(entry)}`),
          "",
        ]
      : []),
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

export function collectReport(env = process.env, execute = execFileSync, options = {}) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !/^\d+$/u.test(run ?? "") || !/^[1-9]\d*$/u.test(attempt ?? "")) {
    throw new Error("Invalid timing API coordinates");
  }
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? COLLECT_BUDGET_MS);
  const remainingTimeout = () => Math.max(0, Math.min(60_000, deadline - now()));
  const api = (endpoint, paginate = false) => {
    const timeout = remainingTimeout();
    if (timeout <= 0) throw new Error("CI timing API budget exhausted");
    return JSON.parse(execute("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint], {
      encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
    }));
  };
  const fetchLog = (jobId) => {
    if (!Number.isInteger(jobId) || jobId <= 0) return null;
    const timeout = remainingTimeout();
    if (timeout <= 0) return null;
    try {
      return execute("gh", ["api", `repos/${repository}/actions/jobs/${jobId}/logs`], {
        encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
  const attemptNumber = Number(attempt);
  const runPrefix = `repos/${repository}/actions/runs/${run}`;
  const prefix = `${runPrefix}/attempts/${attempt}`;
  const metadata = api(prefix);
  const attemptStart = metadata.run_started_at ?? metadata.created_at;
  const pages = api(`${prefix}/jobs?per_page=100`, true);
  const jobs = pages.flatMap((page) => page.jobs);
  const currentAttemptJobs = jobs.filter((job) => belongsToAttempt(job, attemptNumber, attemptStart));

  const hasCurrentBlockingFailure = currentAttemptJobs.some(
    (job) => job.status === "completed"
      && FAILURE_CONCLUSIONS.has(job.conclusion)
      && failureTier(job.name) < 2,
  );
  const attempts = [];
  if (!hasCurrentBlockingFailure) {
    const maxPrior = Math.min(attemptNumber - 1, MAX_PRIOR_ATTEMPTS);
    for (let prior = 1; prior <= maxPrior; prior += 1) {
      if (remainingTimeout() <= 0) break;
      try {
        const priorPages = api(`${runPrefix}/attempts/${prior}/jobs?per_page=100`, true);
        const priorJobs = priorPages.flatMap((page) => page.jobs);
        attempts.push({ attempt: prior, jobs: priorJobs });
        if (priorJobs.some((job) => job.status === "completed" && FAILURE_CONCLUSIONS.has(job.conclusion) && failureTier(job.name) === 0)) {
          break;
        }
      } catch {
        // Keep generating the report even if an earlier attempt's jobs cannot be read.
      }
    }
  }
  attempts.push({ attempt: attemptNumber, jobs: currentAttemptJobs, runStartedAt: attemptStart });

  const firstFailure = findFirstFailure(attempts, {
    currentAttempt: attemptNumber,
    currentJobs: currentAttemptJobs,
    currentAttemptStart: attemptStart,
    logsByJobId: (job) => fetchLog(job.id),
  });

  return renderSummary(
    summarizeJobs(jobs, attemptStart, {
      firstFailure,
      currentAttempt: attemptNumber,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Observability must never turn passing validation red.
  let report;
  try { report = collectReport(); } catch { report = "CI timing report unavailable: GitHub API request failed.\n"; }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  process.stdout.write(report);
}
