import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { buildPlan, executePlan, parseArguments } from "./run-ci-tests.mjs";

// Fixture lanes run small Node scripts instead of tsx so the runner's
// scheduling is observable without the real suites.
function fixturePlan(directory, { failLane } = {}) {
  const log = path.join(directory, "events.log");
  const script = (name, { waitFor, fail } = {}) => [
    process.execPath,
    "-e",
    `const fs = require("node:fs");
     fs.appendFileSync(${JSON.stringify(log)}, "start ${name}\\n");
     const until = Date.now() + 5000;
     const ready = () => ${waitFor ? `fs.readFileSync(${JSON.stringify(log)}, "utf8").includes("start ${waitFor}")` : "true"};
     const finish = () => { fs.appendFileSync(${JSON.stringify(log)}, "end ${name}\\n"); process.exit(${fail ? 1 : 0}); };
     const poll = () => ready() ? finish() : Date.now() > until ? process.exit(2) : setTimeout(poll, 10);
     poll();`,
  ];
  const lane = (name, other) => ({
    id: `${name}:tests`,
    lane: name,
    files: [],
    // Each lane waits until the other has started, so serial execution exits 2.
    command: script(name, { waitFor: other, fail: failLane === name }),
  });
  return {
    log,
    plan: {
      lanes: [],
      prerequisites: [{ id: "helper", command: script("prerequisite") }],
      preserved: [{ id: "browser", kind: "browser", command: script("preserved") }],
      unitCommands: [lane("alpha", "beta"), lane("beta", "alpha")],
    },
  };
}

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-ci-runner-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const events = async (log) => (await readFile(log, "utf8")).trim().split("\n");

test("parallel mode overlaps lanes after prerequisites and before preserved commands", async () => {
  await withDirectory(async (directory) => {
    const { log, plan } = fixturePlan(directory);
    await executePlan(plan, parseArguments(["--parallel"]));
    const order = await events(log);
    assert.equal(order[0], "start prerequisite");
    assert.equal(order[1], "end prerequisite");
    assert.deepEqual(order.slice(-2), ["start preserved", "end preserved"]);
    assert.deepEqual(order.slice(2, -2).filter((event) => event.startsWith("start")).toSorted(), ["start alpha", "start beta"]);
  });
});

test("a failing lane fails the run without skipping its sibling or running preserved commands", async () => {
  await withDirectory(async (directory) => {
    const { log, plan } = fixturePlan(directory, { failLane: "alpha" });
    await assert.rejects(executePlan(plan, parseArguments(["--parallel"])), /alpha:tests exited with status 1/u);
    const order = await events(log);
    assert.ok(order.includes("end beta"), "the sibling lane still finishes");
    assert.ok(!order.includes("start preserved"));
  });
});

test("the default plan runs each unit file once across lanes", () => {
  const registry = {
    lanes: [
      { name: "one", files: ["a.test.ts", "b.test.ts"], prerequisites: ["build"], preserved: ["mode"] },
      { name: "two", files: ["c.test.ts"], prerequisites: ["build"], preserved: [] },
    ],
    prerequisites: [{ id: "build", command: ["node", "build.mjs"] }],
    preserved: [{ id: "mode", command: ["npm", "run", "test:mode"] }],
  };
  const plan = buildPlan(registry, parseArguments(["--parallel"]));
  assert.deepEqual(plan.unitCommands.flatMap((command) => command.files).toSorted(), ["a.test.ts", "b.test.ts", "c.test.ts"]);
  assert.deepEqual(plan.prerequisites.map((entry) => entry.id), ["build"]);
  assert.deepEqual(plan.preserved.map((entry) => entry.id), ["mode"]);
});
