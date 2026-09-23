/* global structuredClone */

import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSourceTests,
  readPackageManifest,
  readRegistry,
  validateRegistry,
} from "./ci-test-registry.mjs";

test("CI registry assigns the complete deduplicated pretest/test union", () => {
  const registry = readRegistry();
  const validation = validateRegistry({ registry });

  assert.equal(
    validation.sourceFiles.length,
    validation.unitFiles.length + validation.preservedFiles.length,
  );
  assert.deepEqual(Object.keys(validation.laneCounts).toSorted(), [
    "core-git",
    "renderer-other",
    "runtime-subagents",
  ]);
  const laneSizes = Object.values(validation.laneCounts);
  assert.ok(laneSizes.every((size) => size > 0));

  const telegram = collectSourceTests({ sourceScripts: ["test:telegram"] });
  assert.ok(telegram.files.size > 0);
  for (const file of telegram.files.keys()) {
    assert.ok(validation.sourceFiles.includes(file), `Telegram file is missing: ${file}`);
  }
});

test("malformed npm multi-script invocations fail closed", () => {
  const packageManifest = structuredClone(readPackageManifest());
  packageManifest.scripts.test = packageManifest.scripts.test.replace(
    "npm run test:telegram",
    "npm run test:custom-model-options test:telegram",
  );

  assert.throws(
    () => collectSourceTests({ packageManifest }),
    /malformed npm invocation/u,
  );
});

test("new test environment and flags fail closed until explicitly audited", () => {
  const packageManifest = structuredClone(readPackageManifest());
  packageManifest.scripts.pretest +=
    " && FOO=bar tsx --test main/services/custom-model-options.test.ts";
  assert.throws(
    () => collectSourceTests({ packageManifest }),
    /unregistered environment assignments/u,
  );

  const flaggedManifest = structuredClone(readPackageManifest());
  flaggedManifest.scripts.pretest +=
    " && tsx --test --test-name-pattern=slow main/services/custom-model-options.test.ts";
  assert.throws(
    () => collectSourceTests({ packageManifest: flaggedManifest }),
    /unregistered test flag/u,
  );
});

test("a newly registered source test cannot bypass lane assignment", () => {
  const packageManifest = structuredClone(readPackageManifest());
  packageManifest.scripts.pretest +=
    " && tsx --test main/services/diagnostics-contract.test.ts";

  assert.throws(
    () => validateRegistry({ registry: readRegistry(), packageManifest }),
    /CI registry\/source mismatch.*unassigned/u,
  );
});

test("new npm post-test lifecycle coverage also requires a lane assignment", () => {
  for (const script of ["posttest", "posttest:telegram"]) {
    const packageManifest = structuredClone(readPackageManifest());
    packageManifest.scripts[script] = "tsx --test main/services/diagnostics-contract.test.ts";
    assert.throws(() => validateRegistry({ registry: readRegistry(), packageManifest }), /unassigned/u);
  }
});

test("unit lanes cannot overlap and preserved modes stay explicit", () => {
  const registry = structuredClone(readRegistry());
  registry.lanes[1].files.push(registry.lanes[0].files[0]);
  assert.throws(
    () => validateRegistry({ registry }),
    /assigned to multiple lanes/u,
  );

  const preserved = new Map(readRegistry().preserved.map((entry) => [entry.id, entry]));
  assert.deepEqual(preserved.get("terminal-coverage").command, ["npm", "run", "test:terminal:coverage"]);
  assert.deepEqual(preserved.get("generative-ui-chromium").command, ["npm", "run", "test:generative-ui"]);
  assert.deepEqual(preserved.get("computer-use-rust-native").command, ["npm", "run", "test:computer-use:native"]);
  assert.ok(preserved.get("generative-ui-chromium").kind === "chromium");
  assert.ok(preserved.get("terminal-coverage").kind === "coverage");

  const lanePreserved = readRegistry().lanes.flatMap((lane) => lane.preserved ?? []);
  assert.equal(lanePreserved.length, preserved.size);
  assert.equal(new Set(lanePreserved).size, preserved.size);
});

test("native helper regression files run in a lane that builds their binaries", () => {
  const registry = readRegistry();
  for (const [file, required] of [
    ["scripts/worktree-file-io.test.mjs", ["worktree-file-io-build", "worktree-file-io-test-build"]],
    ["main/services/managed-worktree-lifecycle.test.ts", ["worktree-file-io-build", "worktree-remover-build"]],
    ["scripts/bot-inbox-writer.test.mjs", ["bot-inbox-writer-build", "bot-inbox-writer-test-build"]],
    ["scripts/subagent-run-store.test.mjs", ["subagent-run-store-build", "subagent-run-store-test-build"]],
    ["main/services/subagents/subagent-shell-runner-io.test.ts", ["subagent-shell-runner-build", "subagent-shell-runner-test-build"]],
  ]) {
    const lane = registry.lanes.find((candidate) => candidate.files.includes(file));
    assert.ok(lane, file);
    for (const prerequisite of required) assert.ok(lane.prerequisites.includes(prerequisite), `${file}: ${prerequisite}`);
  }
});

test("non-file execution modes and native prerequisites cannot disappear behind a green inventory", () => {
  const registry = structuredClone(readRegistry());
  registry.preserved = registry.preserved.filter((entry) => entry.kind !== "rust");
  assert.throws(() => validateRegistry({ registry }), /Missing preserved execution mode/u);
  const missingBuild = structuredClone(readRegistry());
  missingBuild.prerequisites = missingBuild.prerequisites.filter((entry) => entry.id !== "worktree-file-io-build");
  assert.throws(() => validateRegistry({ registry: missingBuild }), /Unknown build prerequisite|Missing build prerequisite/u);
  const unassigned = structuredClone(readRegistry());
  for (const lane of unassigned.lanes) lane.prerequisites = lane.prerequisites.filter((id) => id !== "worktree-file-io-build");
  assert.throws(() => validateRegistry({ registry: unassigned }), /Unassigned build prerequisite/u);
});
