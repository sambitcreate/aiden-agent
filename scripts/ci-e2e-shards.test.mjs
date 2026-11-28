import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";
import { E2E_SHARD_COUNT, FILE_SECONDS, discoverSpecs, planShards, shardArguments, specsForRunner } from "./ci-e2e-shards.mjs";
import { readE2ESpecMap } from "./ci-related-tests.mjs";

test("every deterministic spec belongs to exactly one shard, including unweighted new files", () => {
  const specs = [...discoverSpecs(), "future/new-flow.spec.ts"];
  const expected = specs.filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts").sort();
  const actual = planShards(specs).flatMap((shard) => shard.files);
  assert.equal(actual.length, new Set(actual).size);
  assert.deepEqual(actual.sort(), expected);
  assert.deepEqual(planShards([...specs].reverse()), planShards(specs));
});

test("every runnable spec on disk has a fallback weight in FILE_SECONDS and cold shards retain headroom", () => {
  const specs = discoverSpecs();
  const runnable = specs.filter((file) => !file.endsWith(".live.spec.ts") && file !== "diagnostics-production.spec.ts");
  assert.ok(runnable.length >= 85, `expected at least 85 runnable specs, found ${runnable.length}`);
  assert.deepEqual(Object.keys(FILE_SECONDS).toSorted(), runnable.toSorted());
  for (const [file, seconds] of Object.entries(FILE_SECONDS)) {
    assert.ok(Number.isInteger(seconds) && seconds > 0, `${file}: expected positive integer weight, got ${seconds}`);
  }
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ci-e2e-2026-11-04-timings.json", import.meta.url), "utf8"));
  const { jobSeconds, setupAndCleanupReserveSeconds, minimumHeadroomSeconds } = fixture.budget;
  const macShards = planShards(specs, E2E_SHARD_COUNT);
  const macLoads = macShards.map((shard) => shard.seconds);
  assert.ok(
    Math.max(...macLoads) + setupAndCleanupReserveSeconds <= jobSeconds - minimumHeadroomSeconds,
    `cold ${E2E_SHARD_COUNT}-shard fallback windows ${macLoads}`,
  );
  const linuxJobSeconds = 30 * 60;
  const linuxShards = planShards(specs, 3);
  const linuxLoads = linuxShards.map((shard) => shard.seconds);
  assert.ok(
    Math.max(...linuxLoads) + setupAndCleanupReserveSeconds <= linuxJobSeconds - minimumHeadroomSeconds,
    `cold 3-shard Linux fallback windows ${linuxLoads}`,
  );
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

test("the CI shards retain job-budget headroom across recent slow windows and an independent completed run", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ci-e2e-2026-11-04-timings.json", import.meta.url), "utf8"));
  const specs = fixture.previousAllocation.flat();
  const load = (files, windows) => files.reduce((seconds, file) => seconds + windows[file], 0);
  const shards = planShards(specs);
  assert.equal(shards.length, E2E_SHARD_COUNT);
  const cold = shards.map((shard) => load(shard.files, fixture.trainingMaxCompleteWindowSeconds));
  const { jobSeconds, setupAndCleanupReserveSeconds, minimumHeadroomSeconds } = fixture.budget;
  // Even a perfectly balanced three-way split of these independently observed
  // complete windows leaves no room for startup/cleanup inside the same budget.
  const bestPossibleThree = Object.values(fixture.trainingMaxCompleteWindowSeconds).reduce((sum, seconds) => sum + seconds, 0) / 3;
  assert.ok(bestPossibleThree + setupAndCleanupReserveSeconds > jobSeconds);
  assert.ok(Math.max(...cold) + setupAndCleanupReserveSeconds <= jobSeconds - minimumHeadroomSeconds, `${E2E_SHARD_COUNT}-shard windows ${cold}`);
  const before = fixture.previousAllocation.map((files) => load(files, fixture.validationWindowsSeconds));
  const after = shards.map((shard) => load(shard.files, fixture.validationWindowsSeconds));
  assert.ok(Math.max(...after) < Math.max(...before) * 0.8, `independent run before ${before}; after ${after}`);
});

test("actual Playwright collection keeps every deterministic case exactly once across the CI shards", () => {
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
  const indexes = Array.from({ length: E2E_SHARD_COUNT }, (_, index) => index + 1);
  const actual = indexes.flatMap((index) => collect(shardArguments(discoverSpecs(), `${index}/${E2E_SHARD_COUNT}`).args).map(({ id }) => id));
  assert.ok(expected.length > 0);
  assert.equal(new Set(actual).size, actual.length, "no case may run in two shards");
  assert.deepEqual(actual.sort(), expected.sort(), "no case may be skipped by the scheduling change");
});

test("shards preserve one worker, fail on flakes, and select only exact spec paths", () => {
  for (let index = 1; index <= E2E_SHARD_COUNT; index++) {
    const { shard, args } = shardArguments(discoverSpecs(), `${index}/${E2E_SHARD_COUNT}`);
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

test("related E2E selection may leave unused shards empty without dropping the selected spec", () => {
  const specs = ["settings-unification.spec.ts"];
  const first = shardArguments(specs, "1/4", { allowEmpty: true, recorded: { "settings-unification.spec.ts": 90 } });
  const unused = shardArguments(specs, "4/4", { allowEmpty: true, recorded: { "settings-unification.spec.ts": 90 } });
  assert.deepEqual(first.shard.files, specs);
  assert.equal(first.empty, undefined);
  assert.deepEqual(unused.shard.files, []);
  assert.equal(unused.empty, true);
  assert.deepEqual(unused.args, []);
});

test("a pull request's macOS runner runs only its planned macOS-only specs", () => {
  const discovered = ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"];
  const selection = {
    e2e: { mode: "related", specs: ["a.spec.ts", "b.spec.ts", "c.spec.ts"] },
    macE2E: { scope: "macos", shards: [1], specs: ["b.spec.ts"] },
  };
  assert.deepEqual(specsForRunner(discovered, selection, "macos"), ["b.spec.ts"]);
  assert.deepEqual(specsForRunner(discovered, selection, undefined), ["a.spec.ts", "b.spec.ts", "c.spec.ts"]);
  // Main's full plan, a missing plan, or one naming an unknown spec keeps the ordinary selection.
  const full = { ...selection, macE2E: { scope: "all", shards: [1, 2, 3, 4, 5], specs: [] } };
  assert.deepEqual(specsForRunner(discovered, full, "macos"), ["a.spec.ts", "b.spec.ts", "c.spec.ts"]);
  assert.deepEqual(specsForRunner(discovered, { e2e: selection.e2e }, "macos"), ["a.spec.ts", "b.spec.ts", "c.spec.ts"]);
  const unknown = { ...selection, macE2E: { scope: "macos", shards: [1], specs: ["gone.spec.ts"] } };
  assert.deepEqual(specsForRunner(discovered, unknown, "macos"), ["a.spec.ts", "b.spec.ts", "c.spec.ts"]);
});

test("every macOS-only spec fits one pull-request runner inside the E2E job budget", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ci-e2e-2026-11-04-timings.json", import.meta.url), "utf8"));
  const { jobSeconds, setupAndCleanupReserveSeconds, minimumHeadroomSeconds } = fixture.budget;
  const [shard] = planShards(readE2ESpecMap().macos, 1);
  assert.equal(shard.files.length, readE2ESpecMap().macos.length);
  assert.ok(shard.seconds + setupAndCleanupReserveSeconds <= jobSeconds - minimumHeadroomSeconds, `${shard.seconds}s`);
});
