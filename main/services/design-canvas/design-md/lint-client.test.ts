import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  runDesignMdWorker,
  type DesignMdLintResult,
} from "./lint-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const support = path.join(here, "test-support");
const fixture = (name: string) => readFileSync(path.join(fixtures, name), "utf8");
const supportUrl = (name: string) => pathToFileURL(path.join(support, name));
const runFile = promisify(execFile);

/** 64 KiB of emphasis runs: 0.4.0's parser is quadratic on these (about 14 s). */
const pathological = () => "*a_".repeat(Math.floor(65_536 / 3));

async function lintFixture(name: string): Promise<DesignMdLintResult> {
  const outcome = await runDesignMdWorker({ op: "lint", content: fixture(name) });
  assert.equal(outcome.ok, true, `${name}: ${JSON.stringify(outcome)}`);
  return (outcome as { ok: true; result: DesignMdLintResult }).result;
}

test("the worker reports what the fixtures hold", async () => {
  const valid = await lintFixture("valid.md");
  assert.equal(valid.summary.errors, 0);
  assert.deepEqual(valid.sections.slice(0, 2), ["Overview", "Colors"]);
  assert.ok(valid.symbols.some(([key, value]) => key === "colors.primary" && "text" in value && value.text === "#1a1c1e"));

  const broken = await lintFixture("broken-ref.md");
  const brokenRefs = broken.findings.filter((finding) => finding.rule === "broken-ref");
  assert.equal(brokenRefs.length, 1);
  assert.equal(brokenRefs[0]!.severity, "error");
  assert.equal(brokenRefs[0]!.path, "components.button-primary");
  // 0.4.0 leaves a broken token-group reference unreported, as a raw string.
  assert.deepEqual(
    broken.symbols.find(([key]) => key === "colors.ghost"),
    ["colors.ghost", { unresolved: "{colors.nope}" }],
  );

  const contrast = await lintFixture("low-contrast.md");
  assert.ok(contrast.findings.some((finding) => finding.rule === "contrast-ratio" && finding.severity === "warning"));

  const badYaml = await lintFixture("bad-yaml.md");
  assert.ok(badYaml.summary.warnings >= 1);
  assert.equal(badYaml.summary.errors, 0);

  const motion = await lintFixture("motion.md");
  assert.ok(motion.findings.some((finding) => finding.rule === "token-like-ignored" && finding.path === "motion"));
  assert.ok(!motion.symbols.some(([key]) => key.startsWith("motion.")));
});

test("a pathological file comes back timed-out within the deadline", async () => {
  let readyAt = 0;
  const outcome = await runDesignMdWorker(
    { op: "lint", content: pathological() },
    { onReady: () => (readyAt = performance.now()) },
  );
  const elapsed = performance.now() - readyAt;
  assert.deepEqual(outcome, { ok: false, status: "timed-out" });
  assert.ok(readyAt > 0, "the worker became ready");
  assert.ok(elapsed < 2_500, `took ${elapsed} ms after ready`);
});

test("a worker that never posts ready gives linter-unavailable after the load timeout", async () => {
  const started = performance.now();
  const outcome = await runDesignMdWorker(
    { op: "lint", content: "# x" },
    { workerUrl: supportUrl("never-ready.mjs"), loadTimeoutMs: 300 },
  );
  assert.deepEqual(outcome, { ok: false, status: "linter-unavailable", cause: "load-timeout" });
  assert.ok(performance.now() - started < 1_000);
});

test("the worker's environment has no debug switches", async () => {
  const saved = { DEBUG: process.env.DEBUG, LOG_STREAM: process.env.LOG_STREAM, LOG_TOKENS: process.env.LOG_TOKENS };
  process.env.DEBUG = "*";
  process.env.LOG_STREAM = "1";
  process.env.LOG_TOKENS = "1";
  let output = "";
  try {
    const outcome = await runDesignMdWorker(
      { op: "lint", content: fixture("valid.md") },
      { onOutput: (text) => (output += text) },
    );
    assert.equal(outcome.ok, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(output, "");
});

test("the export shapes are right", async () => {
  const content = fixture("valid.md");
  const text = async (format: "css-tailwind" | "css-vars" | "dtcg" | "json-tailwind") => {
    const outcome = await runDesignMdWorker({ op: "export", content, format });
    assert.equal(outcome.ok, true, format);
    const result = (outcome as { ok: true; result: { success: boolean; text?: string } }).result;
    assert.equal(result.success, true, format);
    return result.text!;
  };
  const tailwind = await text("css-tailwind");
  assert.match(tailwind, /@theme \{/);
  assert.match(tailwind, /--color-primary:/);
  const vars = await text("css-vars");
  assert.match(vars, /:root \{/);
  assert.match(vars, /--color-primary:/);
  const dtcg = JSON.parse(await text("dtcg")) as Record<string, unknown>;
  assert.equal(typeof dtcg.$schema, "string");
  const config = JSON.parse(await text("json-tailwind")) as { theme: { extend: { colors: Record<string, string> } } };
  assert.equal(config.theme.extend.colors.primary, "#1a1c1e");
});

async function runTrapped(mode: "inherit" | "explicit-execargv" | "calls-network") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-design-md-trap-"));
  const logFile = path.join(dir, "trap.log");
  try {
    const { stdout } = await runFile(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        supportUrl("trap-network.mjs").href,
        path.join(support, "run-lint-fixtures.ts"),
        mode,
        path.join(fixtures, "valid.md"),
        path.join(fixtures, "broken-ref.md"),
        path.join(fixtures, "low-contrast.md"),
      ],
      { env: { ...process.env, AIDEN_TEST_TRAP_LOG: logFile }, timeout: 60_000 },
    );
    const log = (await readFile(logFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
    return { outcomes: JSON.parse(stdout) as Array<{ ok: boolean; summary?: { errors: number } }>, log };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const workerLines = (log: string[], kind: string) =>
  log.filter((line) => line.startsWith(`${kind} `) && line.split(" ")[1] !== "0");

test("the worker lints with no network and no subprocess, and only the linter entry point loads", async () => {
  const { outcomes, log } = await runTrapped("inherit");
  // Positive control: the trap ran inside a worker thread.
  assert.ok(workerLines(log, "installed").length >= 3, log.join("\n"));
  assert.deepEqual(
    outcomes.map((outcome) => outcome.ok && outcome.summary?.errors),
    [0, 1, 0],
  );
  assert.deepEqual(log.filter((line) => line.startsWith("call ")), []);

  const resolved = workerLines(log, "resolve").map((line) => line.split(" ").slice(2).join(" "));
  // Positive control: the resolve hook saw the linter load in the worker.
  assert.ok(resolved.some((url) => url.endsWith("@google/design.md/dist/linter/index.js")), resolved.join("\n"));
  assert.ok(!resolved.some((url) => url.endsWith("@google/design.md/dist/index.js")));
  for (const banned of ["node_modules/citty/", "node_modules/remark-mdx/", "node_modules/remark-frontmatter/", "@google/design.md/node_modules/"]) {
    assert.ok(!resolved.some((url) => url.includes(banned)), banned);
  }
});

test("the trap catches a worker that calls http.request", async () => {
  const { outcomes, log } = await runTrapped("calls-network");
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true, true]);
  const calls = log.filter((line) => line.startsWith("call "));
  assert.equal(calls.length, 3, log.join("\n"));
  for (const line of calls) {
    const [, thread, what] = line.split(" ");
    assert.notEqual(thread, "0", line);
    assert.equal(what, "http.request", line);
  }
});

test("an explicit execArgv option replaces the inherited one", async () => {
  const { outcomes, log } = await runTrapped("explicit-execargv");
  assert.deepEqual(
    outcomes.map((outcome) => outcome.ok),
    [true, true, true],
  );
  assert.deepEqual(workerLines(log, "installed"), []);
  assert.ok(log.some((line) => line === "installed 0"), "the main thread still installed the trap");
});

test("a worker that can't load gives linter-unavailable", async () => {
  const outcome = await runDesignMdWorker(
    { op: "lint", content: "# x" },
    { workerUrl: supportUrl("throws-on-import.mjs") },
  );
  assert.deepEqual(outcome, { ok: false, status: "linter-unavailable" });
});

test("with two running and sixteen waiting, the nineteenth request is busy", async () => {
  const outcomes = await Promise.all(
    Array.from({ length: 19 }, () =>
      runDesignMdWorker({ op: "lint", content: "# x" }, { workerUrl: supportUrl("sleepy-worker.mjs") }),
    ),
  );
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 18);
  assert.deepEqual(
    outcomes.filter((outcome) => !outcome.ok),
    [{ ok: false, status: "busy" }],
  );
});

test("an aborted signal terminates the worker", async () => {
  const controller = new AbortController();
  const started = performance.now();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    runDesignMdWorker({ op: "lint", content: pathological() }, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.ok(performance.now() - started < 600, `${performance.now() - started} ms`);
});
