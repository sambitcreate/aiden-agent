import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";
import { discoverSpecs, planShards, shardArguments } from "./ci-e2e-shards.mjs";

test("every deterministic spec belongs to exactly one shard, including unweighted new files", () => {
  const specs = [...discoverSpecs(), "future/new-flow.spec.ts"];
  const expected = specs.filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts").sort();
  const actual = planShards(specs).flatMap((shard) => shard.files);
  assert.equal(actual.length, new Set(actual).size);
  assert.deepEqual(actual.sort(), expected);
  assert.deepEqual(planShards([...specs].reverse()), planShards(specs));
});

test("allocation reduces the slowest runner using an independent completed CI run", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ci-e2e-independent-timings.json", import.meta.url), "utf8"));
  const specs = fixture.previousAllocation.flat();
  const observed = fixture.validationWindowsSeconds;
  const load = (files) => files.reduce((seconds, file) => seconds + (observed[file] ?? 0), 0);
  const before = fixture.previousAllocation.map(load);
  const after = planShards(specs).map((shard) => load(shard.files));
  // Two later specs do not appear in the independent run; they contribute no
  // estimate to either side of this comparison.
  assert.equal(specs.filter((file) => observed[file] === undefined).length, 2);
  assert.ok(Math.max(...after) < Math.max(...before) * 0.8, `before ${before}; after ${after}`);
});

test("four shards retain job-budget headroom across recent slow windows and an independent completed run", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ci-e2e-2026-11-04-timings.json", import.meta.url), "utf8"));
  const specs = fixture.previousAllocation.flat();
  const load = (files, windows) => files.reduce((seconds, file) => seconds + windows[file], 0);
  const shards = planShards(specs);
  assert.equal(shards.length, 4);
  const cold = shards.map((shard) => load(shard.files, fixture.trainingMaxCompleteWindowSeconds));
  const { jobSeconds, setupAndCleanupReserveSeconds, minimumHeadroomSeconds } = fixture.budget;
  // Even a perfectly balanced three-way split of these independently observed
  // complete windows leaves no room for startup/cleanup inside the same budget.
  const bestPossibleThree = Object.values(fixture.trainingMaxCompleteWindowSeconds).reduce((sum, seconds) => sum + seconds, 0) / 3;
  assert.ok(bestPossibleThree + setupAndCleanupReserveSeconds > jobSeconds);
  assert.ok(Math.max(...cold) + setupAndCleanupReserveSeconds <= jobSeconds - minimumHeadroomSeconds, `four-shard windows ${cold}`);
  const before = fixture.previousAllocation.map((files) => load(files, fixture.validationWindowsSeconds));
  const after = shards.map((shard) => load(shard.files, fixture.validationWindowsSeconds));
  assert.ok(Math.max(...after) < Math.max(...before) * 0.8, `independent run before ${before}; after ${after}`);
});

test("actual Playwright collection keeps every deterministic case exactly once across the four CI shards", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
  const collect = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args, "--list", "--reporter=json"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.errors, []);
    const cases = [];
    const visit = (suite) => {
      for (const spec of suite.specs ?? []) for (const project of spec.tests) cases.push({ file: spec.file, id: `${spec.id}:${project.projectName}` });
      for (const child of suite.suites ?? []) visit(child);
    };
    for (const suite of report.suites) visit(suite);
    return cases;
  };
  const expected = collect(["test", "--config=playwright.config.ts"]).filter(({ file }) => file !== "diagnostics-production.spec.ts" && !file.endsWith(".live.spec.ts")).map(({ id }) => id);
  const actual = [1, 2, 3, 4].flatMap((index) => collect(shardArguments(discoverSpecs(), `${index}/4`).args).map(({ id }) => id));
  assert.ok(expected.length > 0);
  assert.equal(new Set(actual).size, actual.length, "no case may run in two shards");
  assert.deepEqual(actual.sort(), expected.sort(), "no case may be skipped by the scheduling change");
});

test("shards preserve one worker, fail on flakes, and select only exact spec paths", () => {
  for (let index = 1; index <= 4; index++) {
    const { shard, args } = shardArguments(discoverSpecs(), `${index}/4`);
    assert.ok(args.includes("--workers=1"));
    assert.ok(args.includes("--fail-on-flaky-tests"));
    const patterns = args.slice(4).map((pattern) => new RegExp(pattern));
    for (const spec of discoverSpecs()) {
      const selected = patterns.some((pattern) => pattern.test(`/checkout/tests/e2e/${spec}`));
      assert.equal(selected, shard.files.includes(spec), spec);
    }
  }
});

test("invalid, duplicate, or empty shard selections fail instead of silently skipping tests", () => {
  for (const value of ["0/3", "4/3", "1/0", "1/17", "1/3 --pass-with-no-tests", ""]) {
    assert.throws(() => shardArguments(discoverSpecs(), value));
  }
  assert.throws(() => shardArguments([], "1/3"));
  assert.throws(() => planShards(["a.spec.ts", "a.spec.ts"]));
  assert.throws(() => planShards(["../a.spec.ts"]));
});
