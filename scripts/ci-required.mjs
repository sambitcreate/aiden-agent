import { appendFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const REQUIRED_JOB_RULES = Object.freeze({
  changes: Object.freeze({ always: true }),
  policy: Object.freeze({ always: true }),
  static: Object.freeze({ area: "desktop" }),
  verify: Object.freeze({ area: "desktop" }),
  unit: Object.freeze({ area: "desktop" }),
  e2e: Object.freeze({ area: "desktop" }),
  apple: Object.freeze({ area: "apple" }),
  ios: Object.freeze({ area: "ios" }),
  android: Object.freeze({ area: "android" }),
  "cli-linux": Object.freeze({ area: "desktop" }),
  "cli-playground": Object.freeze({ area: "desktop" }),
});

const REQUIRED_JOB_NAMES = Object.freeze(Object.keys(REQUIRED_JOB_RULES));
const AREAS = Object.freeze(["desktop", "apple", "ios", "android"]);
const ACCEPTED_RESULTS = Object.freeze(new Set(["success", "skipped"]));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}-missing`);
  }
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new Error("not-object");
    }
    return parsed;
  } catch {
    throw new Error(`${label}-malformed`);
  }
}

function normalizeDecision(value) {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

export function parseChangedAreaDecisions(value) {
  const source = typeof value === "string" ? parseJson(value, "changes") : value;
  const outputs = isRecord(source?.outputs) ? source.outputs : isRecord(source?.areas) ? source.areas : source;
  if (!isRecord(outputs)) {
    throw new Error("changes-malformed");
  }

  const decisions = {};
  for (const area of AREAS) {
    const decision = normalizeDecision(outputs[area]);
    if (decision === null) {
      throw new Error("changes-invalid");
    }
    decisions[area] = decision;
  }
  return decisions;
}

function resultForJob(value) {
  if (
    !isRecord(value) ||
    !Object.prototype.hasOwnProperty.call(value, "result") ||
    typeof value.result !== "string" ||
    value.result.length === 0
  ) {
    return null;
  }
  return value.result;
}

function failure(job, reason) {
  return { job, reason };
}

export function evaluateRequiredGate(needs, changes) {
  const failures = [];
  let decisions;
  if (typeof changes === "string") {
    try {
      decisions = parseChangedAreaDecisions(changes);
    } catch (error) {
      failures.push(failure("changes", error instanceof Error ? error.message : "changes-invalid"));
      decisions = null;
    }
  } else {
    try {
      decisions = parseChangedAreaDecisions(changes);
    } catch (error) {
      failures.push(failure("changes", error instanceof Error ? error.message : "changes-invalid"));
      decisions = null;
    }
  }

  if (!isRecord(needs)) {
    failures.push(failure("needs", "needs-malformed"));
  } else {
    for (const job of REQUIRED_JOB_NAMES) {
      const rule = REQUIRED_JOB_RULES[job];
      const entry = needs[job];
      if (entry === undefined) {
        failures.push(failure(job, "missing-result"));
        continue;
      }
      const result = resultForJob(entry);
      if (result === null) {
        failures.push(failure(job, "missing-result"));
        continue;
      }
      if (result === "success") {
        continue;
      }
      if (result === "skipped" && rule.area && decisions?.[rule.area] === false) {
        continue;
      }
      if (!ACCEPTED_RESULTS.has(result)) {
        failures.push(failure(job, result === "skipped" ? "unexpected-skip" : `result-${result}`));
      } else {
        failures.push(failure(job, "unexpected-skip"));
      }
    }
  }

  return {
    checkedCount: REQUIRED_JOB_NAMES.length,
    failures,
    ok: failures.length === 0,
  };
}

export const aggregateRequiredGate = evaluateRequiredGate;

function outputLines(result) {
  const status = result.ok ? "success" : "failure";
  const summary = `CI required gate ${status} (${result.failures.length} failing checks; ${result.checkedCount} required jobs checked).`;
  return [`ok=${result.ok ? "true" : "false"}`, `status=${status}`, `failed_count=${result.failures.length}`, `summary=${summary}`];
}

export function writeRequiredOutputs(result, outputPath) {
  if (!outputPath) {
    return;
  }
  appendFileSync(outputPath, `${outputLines(result).join("\n")}\n`, "utf8");
}

export function writeRequiredSummary(result, summaryPath) {
  if (!summaryPath) {
    return;
  }
  const summary = outputLines(result).at(-1);
  appendFileSync(summaryPath, `${summary.slice("summary=".length)}\n`, "utf8");
}

export function evaluateRequiredEnvironment(environment = process.env) {
  let needs;
  let changes;
  const parsingFailures = [];
  try {
    needs = parseJson(environment.CI_NEEDS_JSON, "needs");
  } catch (error) {
    parsingFailures.push(failure("needs", error instanceof Error ? error.message : "needs-malformed"));
  }
  try {
    changes = parseJson(environment.CI_CHANGES_JSON, "changes");
  } catch (error) {
    parsingFailures.push(failure("changes", error instanceof Error ? error.message : "changes-malformed"));
  }

  const result = evaluateRequiredGate(needs, changes);
  if (parsingFailures.length > 0) {
    return {
      ...result,
      failures: [...parsingFailures, ...result.failures],
      ok: false,
    };
  }
  return result;
}

function main() {
  const result = evaluateRequiredEnvironment();
  writeRequiredOutputs(result, process.env.GITHUB_OUTPUT);
  writeRequiredSummary(result, process.env.GITHUB_STEP_SUMMARY);
  process.stdout.write(`CI required gate ${result.ok ? "passed" : "failed"} after ${result.checkedCount} required jobs.\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
