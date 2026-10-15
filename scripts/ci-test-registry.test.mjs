/* global structuredClone */

import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSourceTests,
  discoverTestFiles,
  readPackageManifest,
  readRegistry,
  readWorkflows,
  validateRegistry,
} from "./ci-test-registry.mjs";

test("CI registry assigns the complete deduplicated serial test union", () => {
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
  packageManifest.scripts["test:serial"] = packageManifest.scripts["test:serial"].replace(
    "npm run test:telegram",
    "npm run test:custom-model-options test:telegram",
  );

  assert.throws(
    () => collectSourceTests({ packageManifest }),
    /malformed npm invocation/u,
  );
});

test("npm package commands are accepted only for the audited standalone CLI suite", () => {
  const { visited } = collectSourceTests();
  assert.ok(visited.includes("test:cli"));
  assert.ok(visited.includes("cli:build"));

  const packageManifest = structuredClone(readPackageManifest());
  packageManifest.scripts["test:cli"] += " && npm --prefix packages/cli run lint";
  assert.throws(
    () => collectSourceTests({ packageManifest }),
    /test:cli uses an unregistered npm command: npm --prefix packages\/cli run lint/u,
  );

  const elsewhere = structuredClone(readPackageManifest());
  elsewhere.scripts["pretest:serial"] += " && npm --prefix packages/cli test";
  assert.throws(
    () => collectSourceTests({ packageManifest: elsewhere }),
    /pretest:serial uses an unregistered npm command/u,
  );
});

test("new test environment and flags fail closed until explicitly audited", () => {
  const packageManifest = structuredClone(readPackageManifest());
  packageManifest.scripts["pretest:serial"] +=
    " && FOO=bar tsx --test main/services/custom-model-options.test.ts";
  assert.throws(
    () => collectSourceTests({ packageManifest }),
    /unregistered environment assignments/u,
  );

  const flaggedManifest = structuredClone(readPackageManifest());
  flaggedManifest.scripts["pretest:serial"] +=
    " && tsx --test --test-name-pattern=slow main/services/custom-model-options.test.ts";
  assert.throws(
    () => collectSourceTests({ packageManifest: flaggedManifest }),
    /unregistered test flag/u,
  );
});

test("a newly registered source test cannot bypass lane assignment", () => {
  const packageManifest = structuredClone(readPackageManifest());
  packageManifest.scripts["pretest:serial"] +=
    " && tsx --test main/services/diagnostics-contract.test.ts";

  assert.throws(
    () => validateRegistry({ registry: readRegistry(), packageManifest }),
    /CI registry\/source mismatch.*unassigned/u,
  );
});

test("new npm post-test lifecycle coverage also requires a lane assignment", () => {
  for (const script of ["posttest:serial", "posttest:telegram"]) {
    const packageManifest = structuredClone(readPackageManifest());
    packageManifest.scripts[script] = "tsx --test main/services/diagnostics-contract.test.ts";
    assert.throws(() => validateRegistry({ registry: readRegistry(), packageManifest }), /unassigned/u);
  }
});

test("npm test hooks cannot run tests outside the registry runner", () => {
  // npm runs pretest and posttest around `npm test`, which the lanes never see.
  for (const hook of ["pretest", "posttest"]) {
    const packageManifest = structuredClone(readPackageManifest());
    packageManifest.scripts[hook] = "tsx --test main/services/diagnostics-contract.test.ts";
    assert.throws(() => validateRegistry({ registry: readRegistry(), packageManifest }), /would bypass the CI registry/u);
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

test("native helper and compaction regression files run in a lane that builds their workers", () => {
  const registry = readRegistry();
  for (const [file, required] of [
    ["main/services/subagents/agent-compatibility.test.ts", ["vcc-build"]],
    ["scripts/worktree-file-io.test.mjs", ["worktree-file-io-build", "worktree-file-io-test-build"]],
    ["main/services/managed-worktree-lifecycle.test.ts", ["worktree-file-io-build", "worktree-remover-build"]],
    ["scripts/bot-inbox-writer.test.mjs", ["bot-inbox-writer-build", "bot-inbox-writer-test-build"]],
    ["scripts/subagent-run-store.test.mjs", ["subagent-run-store-build", "subagent-run-store-test-build"]],
    ["main/services/subagents/subagent-shell-runner-io.test.ts", ["subagent-shell-runner-build", "subagent-shell-runner-test-build"]],
  ]) {
    const lane = registry.lanes.find((candidate) => candidate.files.includes(file));
    assert.ok(lane, file);
    for (const prerequisite of required) {
      assert.ok(lane.prerequisites.includes(prerequisite), `${file}: ${prerequisite}`);
      const build = registry.prerequisites.find((entry) => entry.id === prerequisite);
      assert.ok(build, prerequisite);
      if (build.for) assert.ok(build.for.includes(lane.name), `${prerequisite} must support ${lane.name}`);
    }
  }
});

test("non-file execution modes and native prerequisites cannot disappear behind a green inventory", () => {
  const registry = structuredClone(readRegistry());
  registry.preserved = registry.preserved.filter((entry) => entry.kind !== "rust");
  assert.throws(() => validateRegistry({ registry }), /Missing preserved execution mode/u);
  const withoutCli = structuredClone(readRegistry());
  withoutCli.preserved = withoutCli.preserved.filter((entry) => entry.kind !== "cli");
  for (const lane of withoutCli.lanes) lane.preserved = (lane.preserved ?? []).filter((id) => id !== "cli-package");
  assert.throws(() => validateRegistry({ registry: withoutCli }), /Missing preserved execution mode: test:cli/u);
  const missingBuild = structuredClone(readRegistry());
  missingBuild.prerequisites = missingBuild.prerequisites.filter((entry) => entry.id !== "worktree-file-io-build");
  assert.throws(() => validateRegistry({ registry: missingBuild }), /Unknown build prerequisite|Missing build prerequisite/u);
  const unassigned = structuredClone(readRegistry());
  for (const lane of unassigned.lanes) lane.prerequisites = lane.prerequisites.filter((id) => id !== "worktree-file-io-build");
  assert.throws(() => validateRegistry({ registry: unassigned }), /Unassigned build prerequisite/u);
});

test("every test file on disk runs in CI or is allowlisted as manual", () => {
  const validation = validateRegistry();
  const accounted = new Set([...validation.sourceFiles, ...validation.workflowFiles, ...validation.manualFiles]);
  const discovered = discoverTestFiles();
  assert.ok(discovered.includes("main/services/concentrate-provider.test.ts"));
  assert.deepEqual(discovered.filter((file) => !accounted.has(file)), []);

  // Unregistering a script orphans its files even when the serial graph and
  // lanes stay consistent with each other.
  const packageManifest = structuredClone(readPackageManifest());
  packageManifest.scripts["test:serial"] = packageManifest.scripts["test:serial"].replace(" && npm run test:concentrate", "");
  const registry = structuredClone(readRegistry());
  for (const lane of registry.lanes) lane.files = lane.files.filter((file) => file !== "main/services/concentrate-provider.test.ts");
  assert.throws(
    () => validateRegistry({ registry, packageManifest }),
    /never run in CI: \["main\/services\/concentrate-provider\.test\.ts"\]/u,
  );

  assert.throws(
    () => validateRegistry({ discoveredFiles: [...discovered, "renderer/lib/new-feature.test.ts"] }),
    /never run in CI: \["renderer\/lib\/new-feature\.test\.ts"\]/u,
  );
});

test("manual allowlist entries are required for intentionally manual suites and cannot go stale", () => {
  const withoutPerf = structuredClone(readRegistry());
  withoutPerf.manual = withoutPerf.manual.filter((entry) => entry.file !== "main/services/design/store.perf.test.ts");
  assert.throws(() => validateRegistry({ registry: withoutPerf }), /never run in CI: \["main\/services\/design\/store\.perf\.test\.ts"\]/u);

  const stale = structuredClone(readRegistry());
  stale.manual.push({ file: "main/services/concentrate-provider.test.ts", reason: "already in a lane" });
  assert.throws(() => validateRegistry({ registry: stale }), /allowlist names files CI already runs/u);

  const missing = structuredClone(readRegistry());
  missing.manual.push({ file: "main/services/deleted.perf.test.ts", reason: "gone" });
  assert.throws(() => validateRegistry({ registry: missing }), /missing or unsupported test file/u);
});

test("workflow-owned scripts count only while a workflow still invokes them", () => {
  const workflows = readWorkflows().replaceAll("npm run test:linux-native", "npm run test:linux-native-removed");
  assert.throws(() => validateRegistry({ workflows }), /not invoked by any workflow: test:linux-native/u);
});

test("duplicate prerequisite and preserved ids are rejected", () => {
  const prerequisites = structuredClone(readRegistry());
  prerequisites.prerequisites.push(structuredClone(prerequisites.prerequisites.find((entry) => entry.id === "vcc-build")));
  assert.throws(() => validateRegistry({ registry: prerequisites }), /Duplicate prerequisite ids: vcc-build/u);

  const preserved = structuredClone(readRegistry());
  preserved.preserved.push(structuredClone(preserved.preserved[0]));
  assert.throws(() => validateRegistry({ registry: preserved }), new RegExp(`Duplicate preserved ids: ${preserved.preserved[0].id}`, "u"));
});
