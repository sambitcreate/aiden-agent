/* global structuredClone */

import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSourceTests,
  discoverCliTestFiles,
  discoverIosUiTests,
  discoverSwiftPackages,
  discoverTestFiles,
  parseIosUiTestSource,
  parseSwiftPackageManifest,
  readCliPackageManifest,
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
    "macos",
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

test("Bot lease consumers stage the native guard before their CI lanes", () => {
  const lanes = new Map(readRegistry().lanes.map((lane) => [lane.name, lane]));
  for (const [name, consumer] of [
    ["runtime-subagents", "main/services/bot-runtime/harness-host.test.ts"],
    ["renderer-other", "main/services/telegram/bot-reply-outbox.test.ts"],
  ]) {
    const lane = lanes.get(name);
    assert.ok(lane?.files.includes(consumer), `${consumer} must be assigned to ${name}`);
    assert.ok(lane.prerequisites.includes("lease-flock-build"), `${name} must stage the guard helper`);
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
  withoutPerf.manual = withoutPerf.manual.filter((entry) => entry.file !== "main/services/create-images/run-ledger.perf.test.ts");
  assert.throws(() => validateRegistry({ registry: withoutPerf }), /never run in CI: \["main\/services\/create-images\/run-ledger\.perf\.test\.ts"\]/u);

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

test("Swift package manifests are statically inventoried and fail closed on unwired targets or stale allowlists", () => {
  const discoveredPackages = discoverSwiftPackages();
  assert.deepEqual(
    discoveredPackages.map((pkg) => pkg.packagePath),
    ["native/apple-foundation-models", "native/cua-s1-forms"],
  );
  const validation = validateRegistry();
  assert.deepEqual(validation.swiftTargets, [
    "native/apple-foundation-models:AidenFoundationModelsCore",
    "native/apple-foundation-models:AidenFoundationModelsCoreTests",
    "native/apple-foundation-models:AidenFoundationModelsHelper",
    "native/cua-s1-forms:AidenCuaS1FormsCore",
    "native/cua-s1-forms:AidenCuaS1FormsCoreTests",
    "native/cua-s1-forms:AidenCuaS1FormsHelper",
  ]);

  // Lexical parser strips comments, multiline strings, and raw strings while reading products/targets.
  const fixtureManifest = parseSwiftPackageManifest(
    `
      // .executableTarget(name: "CommentedOut")
      /* nested /* .testTarget(name: "NestedComment") */ still comment */
      let ignored = """
      .target(name: "InsideMultiline")
      """
      let rawIgnored = #".executableTarget(name: "InsideRaw")"#
      let package = Package(
        name: "FixturePkg",
        products: [
          .executable(name: "fixture-bin", targets: ["FixtureExec"])
        ],
        targets: [
          .target(name: "FixtureLib"),
          .executableTarget(name: "FixtureExec", dependencies: [.target(name: "FixtureLib")]),
          .testTarget(name: "FixtureLibTests", dependencies: ["FixtureLib"])
        ]
      )
    `,
    "native/fixture-pkg",
  );
  assert.deepEqual(fixtureManifest.productTargets, { "fixture-bin": ["FixtureExec"] });
  assert.deepEqual(fixtureManifest.targets, [
    { kind: "target", name: "FixtureLib", dependencies: [] },
    { kind: "executableTarget", name: "FixtureExec", dependencies: ["FixtureLib"] },
    { kind: "testTarget", name: "FixtureLibTests", dependencies: ["FixtureLib"] },
  ]);
  assert.throws(
    () =>
      parseSwiftPackageManifest(
        'let package = Package(targets: [.plugin(name: "GenPlugin")])',
        "native/plugin-pkg",
      ),
    /Unsupported Swift target kind '\.plugin'/u,
  );

  // Adding an unwired Swift package or target fails closed until wired or allowlisted.
  assert.throws(
    () => validateRegistry({ swiftPackages: [...discoveredPackages, fixtureManifest] }),
    /Swift package targets never run in CI: \["native\/fixture-pkg:FixtureExec","native\/fixture-pkg:FixtureLib","native\/fixture-pkg:FixtureLibTests"\]/u,
  );

  // Dropping build:native --required helper compilation orphans the Swift executable targets.
  const optionalBuildManifest = structuredClone(readPackageManifest());
  optionalBuildManifest.scripts["build:native"] =
    "node scripts/build-foundation-models-helper.mjs --optional && node scripts/build-cua-s1-forms-helper.mjs --optional";
  assert.throws(
    () => validateRegistry({ packageManifest: optionalBuildManifest }),
    /Swift package targets never run in CI: \["native\/apple-foundation-models:AidenFoundationModelsHelper","native\/cua-s1-forms:AidenCuaS1FormsHelper"\]/u,
  );

  // Dropping test:form-fill:native from workflows orphans AidenCuaS1FormsCore and AidenCuaS1FormsCoreTests? Note AidenCuaS1FormsHelper depends on AidenCuaS1FormsCore, so AidenCuaS1FormsCoreTests is orphaned.
  const withoutFormFillRegistry = structuredClone(readRegistry());
  withoutFormFillRegistry.workflowScripts = withoutFormFillRegistry.workflowScripts.filter(
    (entry) => entry.script !== "test:form-fill:native",
  );
  withoutFormFillRegistry.manualScripts.push({
    script: "test:form-fill:native",
    reason: "temporarily unhooked in fixture",
  });
  const withoutFormFillWorkflows = readWorkflows().replaceAll(
    "npm run test:form-fill:native",
    "echo skipped",
  );
  assert.throws(
    () =>
      validateRegistry({
        registry: withoutFormFillRegistry,
        workflows: withoutFormFillWorkflows,
      }),
    /Swift package targets never run in CI: \["native\/cua-s1-forms:AidenCuaS1FormsCoreTests"\]/u,
  );

  // Leaving a wired Swift target in manualSwiftTargets fails closed as stale.
  const staleSwiftRegistry = structuredClone(readRegistry());
  staleSwiftRegistry.manualSwiftTargets = [
    {
      target: "native/cua-s1-forms:AidenCuaS1FormsCoreTests",
      reason: "already runs via test:form-fill:native",
    },
  ];
  assert.throws(
    () => validateRegistry({ registry: staleSwiftRegistry }),
    /Manual Swift target allowlist names targets CI already runs: \["native\/cua-s1-forms:AidenCuaS1FormsCoreTests"\]/u,
  );

  const unknownSwiftRegistry = structuredClone(readRegistry());
  unknownSwiftRegistry.manualSwiftTargets = [
    { target: "native/cua-s1-forms:DeletedTests", reason: "gone" },
  ];
  assert.throws(
    () => validateRegistry({ registry: unknownSwiftRegistry }),
    /Manual Swift target allowlist references an unknown target: native\/cua-s1-forms:DeletedTests/u,
  );
});

test("iOS UI XCTest classes and methods are statically inventoried against -only-testing flags and manualIosUiTests", () => {
  const discoveredIos = discoverIosUiTests();
  assert.deepEqual(discoveredIos.classes, [
    "AidenAgentSliderUITests",
    "AidenBotUXUITests",
    "AidenSandboxedHTMLUITests",
    "AidenShellUITests",
    "AidenWorkspaceHTMLUITests",
  ]);
  const validation = validateRegistry();
  assert.deepEqual(validation.workflowIosUiTests, [
    "AidenAgentSliderUITests/testANewChatStaysOnTheStopItStartedOn",
    "AidenAgentSliderUITests/testAStopChosenOnTheSliderIsTheModelTheTurnRunsOn",
    "AidenSandboxedHTMLUITests/testATapOnAPreviewLinkAsksFirstAndAScrollNeverDoes",
    "AidenShellUITests/testShellLaunchesForEveryScenario",
    "AidenShellUITests/testUnpairedSearchOffersPairingAndExplainsInvalidManualInput",
    "AidenWorkspaceHTMLUITests/testATruncatedHtmlFileStaysOnSourceWithANote",
    "AidenWorkspaceHTMLUITests/testAnHtmlFileOpensOnPreviewSwitchesToSourceAndAsksBeforeALink",
    "AidenWorkspaceHTMLUITests/testFileWrittenOpensTheFileInAWorkspaceChatOnly",
  ]);
  assert.equal(validation.manualIosUiTests.length, 61);
  assert.ok(discoveredIos.tests.some((testId) => testId.startsWith("AidenBotUXUITests/")));
  assert.ok(validation.manualIosUiTests.some((testId) => testId.startsWith("AidenBotUXUITests/")));

  // Parser ignores non-XCTestCase classes, parameterized helpers, and comments/strings.
  const parsedUi = parseIosUiTestSource(`
    import XCTest
    final class HelperObject {
      func testNotAnXCTestCase() {}
    }
    // final class CommentedUITests: XCTestCase { func testIgnored() {} }
    final class SamplePreviewUITests: XCTestCase {
      let note = "func testInsideString() {}"
      func helperSetUp() {}
      func testParameterized(_ flag: Bool) {}
      @MainActor func testRendersOfflinePreview() async throws {}
    }
    extension SamplePreviewUITests {
      func testSupportsAccessibilityRotor() {}
    }
  `);
  assert.deepEqual(parsedUi, {
    classes: ["SamplePreviewUITests"],
    tests: [
      "SamplePreviewUITests/testRendersOfflinePreview",
      "SamplePreviewUITests/testSupportsAccessibilityRotor",
    ],
  });

  // Adding a new UI test class or method without -only-testing or manualIosUiTests fails closed.
  assert.throws(
    () =>
      validateRegistry({
        discoveredIosUi: {
          classes: [...discoveredIos.classes, "AidenNewFeatureUITests"],
          tests: [...discoveredIos.tests, "AidenNewFeatureUITests/testOfflineBanner"],
        },
      }),
    /iOS UI tests on disk never run in CI: \["AidenNewFeatureUITests\/testOfflineBanner"\]/u,
  );

  // Removing -only-testing for AidenWorkspaceHTMLUITests from workflows fails closed.
  const withoutHtmlWorkflows = readWorkflows().replaceAll(
    "-only-testing:AidenOnTheGoUITests/AidenWorkspaceHTMLUITests",
    "-only-testing:AidenOnTheGoUITests/AidenSandboxedHTMLUITests",
  );
  assert.throws(
    () => validateRegistry({ workflows: withoutHtmlWorkflows }),
    /iOS UI tests on disk never run in CI: \["AidenWorkspaceHTMLUITests\/testATruncatedHtmlFileStaysOnSourceWithANote"/u,
  );

  // Leaving a CI-wired class or method in manualIosUiTests fails closed as stale.
  const staleClassRegistry = structuredClone(readRegistry());
  staleClassRegistry.manualIosUiTests.push({
    test: "AidenWorkspaceHTMLUITests",
    reason: "already runs in jobs.ios",
  });
  assert.throws(
    () => validateRegistry({ registry: staleClassRegistry }),
    /Manual iOS UI test allowlist names tests CI already runs: \["AidenWorkspaceHTMLUITests"\]/u,
  );

  const staleMethodRegistry = structuredClone(readRegistry());
  staleMethodRegistry.manualIosUiTests.push({
    test: "AidenShellUITests/testShellLaunchesForEveryScenario",
    reason: "already runs as shell smoke",
  });
  assert.throws(
    () => validateRegistry({ registry: staleMethodRegistry }),
    /Manual iOS UI test allowlist names tests CI already runs: \["AidenShellUITests\/testShellLaunchesForEveryScenario"\]/u,
  );

  const missingIosRegistry = structuredClone(readRegistry());
  missingIosRegistry.manualIosUiTests.push({
    test: "AidenShellUITests/testDeletedScenario",
    reason: "deleted",
  });
  assert.throws(
    () => validateRegistry({ registry: missingIosRegistry }),
    /Manual iOS UI test allowlist references a missing test method: AidenShellUITests\/testDeletedScenario/u,
  );
});

test("CLI test files and server-bundle packaging workflows fail closed when CLI tests are omitted or keyed", () => {
  const discoveredCli = discoverCliTestFiles();
  assert.equal(discoveredCli.length, 14);
  assert.ok(discoveredCli.includes("packages/cli/tests/bundle.test.mjs"));
  assert.ok(discoveredCli.every((file) => !file.includes("/fixtures/")));

  // New CLI test file on disk omitted from packages/cli/package.json scripts.test fails closed.
  assert.throws(
    () =>
      validateRegistry({
        discoveredCliFiles: [...discoveredCli, "packages/cli/tests/unwired-route.test.mjs"],
      }),
    /CLI test files on disk never run in packages\/cli test script: \["packages\/cli\/tests\/unwired-route\.test\.mjs"\]/u,
  );

  // Referencing a deleted test file in packages/cli/package.json fails closed.
  const brokenCliManifest = structuredClone(readCliPackageManifest());
  brokenCliManifest.scripts.test += " tests/deleted.test.mjs";
  assert.throws(
    () => validateRegistry({ cliManifest: brokenCliManifest }),
    /packages\/cli test script references a missing or unsupported test file: tests\/deleted\.test\.mjs/u,
  );

  // Any workflow that packs ./packages/cli without running keyless CLI tests before cli:dist fails closed.
  const withoutCliTestsWorkflow = readWorkflows().replace(
    "      - name: Build and test the keyless server bundle\n        run: |\n          npm run cli:build\n          npm --prefix packages/cli test\n\n",
    "",
  );
  assert.throws(
    () => validateRegistry({ workflows: withoutCliTestsWorkflow }),
    /Workflow "Build keyed server bundle" job "bundle" packs packages\/cli without building a keyless bundle and running CLI tests before cli:dist and npm pack/u,
  );

  // Running CLI tests with AIDEN_POSTHOG_PROJECT_KEY set fails closed because bundle/analytics tests require keyless builds.
  const keyedCliTestsWorkflow = readWorkflows().replace(
    "      - name: Build and test the keyless server bundle\n        run: |",
    "      - name: Build and test the keyless server bundle\n        env:\n          AIDEN_POSTHOG_PROJECT_KEY: ${{ secrets.AIDEN_POSTHOG_PROJECT_KEY }}\n        run: |",
  );
  assert.throws(
    () => validateRegistry({ workflows: keyedCliTestsWorkflow }),
    /must run CLI tests without AIDEN_POSTHOG_PROJECT_KEY before packing packages\/cli/u,
  );

  // Running CLI tests only after cli:dist fails closed.
  const lateCliTestsWorkflow = readWorkflows()
    .replace(
      "      - name: Build and test the keyless server bundle\n        run: |\n          npm run cli:build\n          npm --prefix packages/cli test\n\n",
      "",
    )
    .replace(
      "      - name: Pack the server\n",
      "      - name: Test too late\n        run: |\n          npm run cli:build\n          npm --prefix packages/cli test\n\n      - name: Pack the server\n",
    );
  assert.throws(
    () => validateRegistry({ workflows: lateCliTestsWorkflow }),
    /packs packages\/cli without building a keyless bundle and running CLI tests before cli:dist and npm pack/u,
  );
});

test("root package.json test:* scripts and build:native fail closed when unwired or left in manualScripts", () => {
  const validation = validateRegistry();
  assert.ok(!validation.manualScripts.includes("test:subagent-worker-smoke"));
  assert.ok(!validation.manualScripts.includes("test:subagent-worker-smoke:run"));

  // Adding a new unwired root test:* script fails closed.
  const unwiredManifest = structuredClone(readPackageManifest());
  unwiredManifest.scripts["test:forgotten-smoke"] = "node scripts/run-forgotten-smoke.mjs";
  assert.throws(
    () => validateRegistry({ packageManifest: unwiredManifest }),
    /Package scripts never run in CI: \["test:forgotten-smoke"\]/u,
  );

  // Leaving a serial, workflow-invoked, or covered-alias script in manualScripts fails closed as stale.
  for (const staleScript of [
    "test:telegram",
    "test:subagent-worker-smoke:run",
    "test:subagent-worker-smoke",
    "test:coverage",
  ]) {
    const staleRegistry = structuredClone(readRegistry());
    staleRegistry.manualScripts.push({
      script: staleScript,
      reason: "stale allowlist entry",
    });
    assert.throws(
      () => validateRegistry({ registry: staleRegistry }),
      new RegExp(
        `Manual script allowlist names scripts CI already runs: \\["${staleScript}"\\]`,
        "u",
      ),
    );
  }

  // Referencing a deleted script in manualScripts fails closed.
  const missingManualScript = structuredClone(readRegistry());
  missingManualScript.manualScripts.push({
    script: "test:deleted-packaged-check",
    reason: "removed",
  });
  assert.throws(
    () => validateRegistry({ registry: missingManualScript }),
    /Manual script allowlist references a missing or unsupported package script: test:deleted-packaged-check/u,
  );
});
