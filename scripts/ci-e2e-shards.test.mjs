import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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

test("shards preserve one worker, fail on flakes, and select only exact spec paths", () => {
  for (let index = 1; index <= 3; index++) {
    const { shard, args } = shardArguments(discoverSpecs(), `${index}/3`);
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
