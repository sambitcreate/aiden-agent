/* global structuredClone, URL */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { discoverSpecs } from "./ci-e2e-shards.mjs";
import {
  parseImportSpecifiers,
  planMacE2E,
  readE2ESpecMap,
  selectReachableTests,
  selectRelatedE2ESpecs,
  selectRelatedUnitFiles,
  validateE2ESpecMap,
} from "./ci-related-tests.mjs";

const files = {
  "main/services/x.ts": 'import { helper } from "./helper.js";\nexport const x = helper;\n',
  "main/services/helper.ts": "export const helper = 1;\n",
  "main/services/x.test.ts": 'import { x } from "./x.js";\nimport test from "node:test";\ntest("x", () => x);\n',
  "main/services/importer.test.ts": 'import { x } from "./x.js";\n',
  "main/services/unrelated.test.ts": 'import { helper } from "./helper.js";\n',
  "main/services/acp/test-support.ts": "export const FAKE_FLASH = 1;\n",
  "main/services/acp/runtime.test.ts":
    'import {\n  FAKE_FLASH,\n  FakeLauncher,\n} from "./test-support.js";\n',
  "renderer/components/settings/about-settings.tsx": "export const About = 1;\n",
};

const testFiles = [
  "main/services/x.test.ts",
  "main/services/importer.test.ts",
  "main/services/unrelated.test.ts",
  "main/services/acp/runtime.test.ts",
];

function readFile(file) {
  if (!(file in files)) throw new Error(`missing ${file}`);
  return files[file];
}

test("import specifiers include static, export-from, and require forms", () => {
  assert.deepEqual(
    parseImportSpecifiers('import { a } from "./a.ts"; export { b } from "../b.js"; require("./c"); import("./d");'),
    ["./a.ts", "../b.js", "./c", "./d"],
  );
});

test("import specifiers keep multiline named imports and ignore comment delimiters in line comments", () => {
  assert.deepEqual(
    parseImportSpecifiers('import {\n  parseRemoteFrame,\n} from "./aiden-remote-parse.js";\n'),
    ["./aiden-remote-parse.js"],
  );
  assert.deepEqual(
    parseImportSpecifiers('// keep /* inside this line\nimport helper from "./helper.js";\n'),
    ["./helper.js"],
  );
});

test("a changed module reaches a differently named test through a multiline import", () => {
  const selected = selectRelatedUnitFiles({
    changedPaths: ["main/services/acp/test-support.ts"],
    testFiles,
    sourceFiles: Object.keys(files),
    readFile,
  });
  assert.equal(selected.mode, "related");
  assert.deepEqual(selected.files, ["main/services/acp/runtime.test.ts"]);
});

test("a source change selects its test file and importers, not an unrelated test", () => {
  const selected = selectRelatedUnitFiles({
    changedPaths: ["main/services/x.ts"],
    testFiles,
    sourceFiles: Object.keys(files),
    readFile,
  });
  assert.equal(selected.mode, "related");
  assert.deepEqual(selected.files, ["main/services/importer.test.ts", "main/services/x.test.ts"]);
});

test("a test that reads a component's source as text is selected when that component changes", () => {
  const sourceReaders = {
    "renderer/components/panel.tsx": "export const Panel = 1;\n",
    "renderer/components/panel-contract.test.ts":
      'import { readFileSync } from "node:fs";\nconst source = readFileSync(new URL("./panel.tsx", import.meta.url), "utf8");\n',
    "main/services/store.ts": "export const store = 1;\n",
    "main/services/store-contract.test.ts":
      'import { readFileSync } from "node:fs";\nimport path from "node:path";\nreadFileSync(path.resolve("main/services/store.ts"), "utf8");\n',
    "main/services/other.test.ts": 'import test from "node:test";\n',
  };
  const readerTests = [
    "main/services/other.test.ts",
    "main/services/store-contract.test.ts",
    "renderer/components/panel-contract.test.ts",
  ];
  const read = (file) => sourceReaders[file];
  for (const [changed, expected] of [
    ["renderer/components/panel.tsx", "renderer/components/panel-contract.test.ts"],
    ["main/services/store.ts", "main/services/store-contract.test.ts"],
  ]) {
    const selected = selectRelatedUnitFiles({
      changedPaths: [changed],
      testFiles: readerTests,
      sourceFiles: Object.keys(sourceReaders),
      readFile: read,
    });
    assert.equal(selected.mode, "related", changed);
    assert.deepEqual(selected.files, [expected], changed);
  }
});

test("a test that joins production path segments is selected when that file changes", () => {
  const sources = {
    "renderer/preload.ts": "export const preload = 1;\n",
    "main/handlers/chats.ts": "export const chats = 1;\n",
    "main/handlers/ipc-walk.test.ts": `
      import * as fs from "node:fs/promises";
      import * as path from "node:path";
      import { fileURLToPath } from "node:url";
      const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      const MAIN_ROOT = path.join(REPO_ROOT, "main");
      const PRELOAD_PATH = path.join(REPO_ROOT, "renderer", "preload.ts");
      await fs.readdir(MAIN_ROOT, { withFileTypes: true });
      await fs.readFile(PRELOAD_PATH, "utf8");
    `,
    "main/handlers/other.test.ts": 'import test from "node:test";\n',
  };
  const tests = ["main/handlers/ipc-walk.test.ts", "main/handlers/other.test.ts"];
  const read = (file) => sources[file];
  for (const [changed, expected] of [
    ["main/handlers/chats.ts", "main/handlers/ipc-walk.test.ts"],
    ["renderer/preload.ts", "main/handlers/ipc-walk.test.ts"],
  ]) {
    const selected = selectRelatedUnitFiles({
      changedPaths: [changed],
      testFiles: tests,
      sourceFiles: Object.keys(sources),
      readFile: read,
    });
    assert.equal(selected.mode, "related", changed);
    assert.deepEqual(selected.files, [expected], changed);
  }
});

test("a handler change selects the registered IPC contract inventory test", () => {
  const contract = "main/handlers/ipc-contract.test.ts";
  const sources = {
    [contract]: readFileSync(new URL("../main/handlers/ipc-contract.test.ts", import.meta.url), "utf8"),
    "main/handlers/chats.ts": "export const chats = 1;\n",
    "main/handlers/index.ts": "export const handlers = 1;\n",
    "main/handlers/attachments.ts": "export const attachments = 1;\n",
    "renderer/preload.ts": "export const preload = 1;\n",
    "renderer/lib/ipc.ts": "export const ipc = 1;\n",
    "renderer/lib/bot-peers-api.ts": "export const peers = 1;\n",
    "renderer/shared/attachment-contract.ts": "export const limits = 1;\n",
    "main/services/attachments.ts": "export const bytes = 1;\n",
    "main/handlers/other.test.ts": 'import test from "node:test";\n',
  };
  const selected = selectRelatedUnitFiles({
    changedPaths: ["main/handlers/chats.ts"],
    testFiles: [contract, "main/handlers/other.test.ts"],
    sourceFiles: Object.keys(sources),
    readFile: (file) => sources[file],
  });
  assert.equal(selected.mode, "related");
  assert.deepEqual(selected.files, [contract]);
});

test("package locks, CI scripts, and unknown paths keep the full unit suite", () => {
  for (const changedPaths of [
    ["package-lock.json"],
    ["scripts/ci-related-tests.mjs"],
    ["scripts/patch-electron-builder-keychain.mjs"],
    ["renderer/styles.css"],
    ["resources/generative-ui/runtime.js"],
  ]) {
    const selected = selectRelatedUnitFiles({
      changedPaths,
      testFiles,
      sourceFiles: Object.keys(files),
      readFile,
    });
    assert.equal(selected.mode, "all", changedPaths[0]);
    assert.deepEqual(selected.files, testFiles);
  }
});

test("main pushes and merge groups keep every test", () => {
  for (const eventName of ["push", "merge_group", "workflow_dispatch"]) {
    const selected = selectReachableTests({
      eventName,
      changedPaths: ["main/services/x.ts"],
      testFiles,
      specs: ["settings-unification.spec.ts", "chat-fork.spec.ts"],
      sourceFiles: Object.keys(files),
      readFile,
      map: {
        version: 1,
        full: [],
        specs: {
          "settings-unification.spec.ts": ["renderer/components/settings/"],
          "chat-fork.spec.ts": ["main/services/chat-fork"],
        },
      },
    });
    assert.equal(selected.unit.mode, "all", eventName);
    assert.equal(selected.e2e.mode, "all", eventName);
  }
});

test("a settings-only renderer diff selects the settings E2E specs", () => {
  const selected = selectRelatedE2ESpecs({
    changedPaths: ["renderer/components/settings/about-settings.tsx"],
    specs: discoverSpecs(),
  });
  assert.equal(selected.mode, "related");
  assert.ok(selected.specs.includes("settings-unification.spec.ts"));
  assert.ok(selected.specs.includes("settings-connectors.spec.ts"));
  assert.ok(!selected.specs.includes("browser-lifecycle.spec.ts"));
  assert.ok(!selected.specs.includes("design-canvas.spec.ts"));
});

test("an unmapped desktop path or shared fixture keeps every E2E spec", () => {
  const specs = discoverSpecs();
  const unmapped = selectRelatedE2ESpecs({
    changedPaths: ["renderer/components/not-in-the-map.tsx"],
    specs,
  });
  assert.equal(unmapped.mode, "all");
  assert.equal(unmapped.reason, "unmapped-path");
  const fixtures = selectRelatedE2ESpecs({
    changedPaths: ["tests/e2e/fixtures.ts"],
    specs,
  });
  assert.equal(fixtures.mode, "all");
});

test("every deterministic spec has a source map entry, and dropping one fails", () => {
  const specs = discoverSpecs();
  const map = validateE2ESpecMap(specs, readE2ESpecMap(), { requireMatchingFiles: true });
  assert.ok(Object.keys(map.specs).length > 0);
  const copy = structuredClone(map);
  delete copy.specs["settings-unification.spec.ts"];
  assert.throws(() => validateE2ESpecMap(specs, copy), /settings-unification\.spec\.ts/u);
});

test("a chat-fork service change selects the fork spec rather than falling through to chat-shell only", () => {
  const selected = selectRelatedE2ESpecs({
    changedPaths: ["main/services/chat-fork-service.ts"],
    specs: discoverSpecs(),
  });
  assert.equal(selected.mode, "related");
  assert.ok(selected.specs.includes("chat-fork.spec.ts"));
});

test("pull requests send only their selected macOS-only specs to a Mac; other events keep the full macOS suite", () => {
  const specs = discoverSpecs();
  const map = readE2ESpecMap();
  const plan = (eventName, changedPaths, desktop = true) => planMacE2E({
    eventName,
    desktop,
    e2e: selectRelatedE2ESpecs({ changedPaths, specs, map }),
    map,
    shardCount: 5,
  });

  for (const eventName of ["push", "merge_group", "workflow_dispatch"]) {
    assert.deepEqual(plan(eventName, ["main/services/chat-fork-service.ts"]), {
      run: true, scope: "all", shards: [1, 2, 3, 4, 5], specs: [],
    }, eventName);
  }
  assert.equal(plan("push", ["main/services/chat-fork-service.ts"], false).run, false);

  // A chat change still has E2E specs to run, but none of them needs a Mac.
  const chat = selectRelatedE2ESpecs({ changedPaths: ["main/services/chat-fork-service.ts"], specs, map });
  assert.ok(chat.specs.length > 0);
  assert.deepEqual(plan("pull_request", ["main/services/chat-fork-service.ts"]), { run: false, scope: "none", shards: [], specs: [] });

  // A devices change keeps the iOS Simulator specs, which skip off macOS, on one Mac.
  const devices = plan("pull_request", ["main/services/devices/device-hub.ts"]);
  assert.equal(devices.run, true);
  assert.equal(devices.scope, "macos");
  assert.deepEqual(devices.shards, [1]);
  assert.ok(devices.specs.includes("environment-devices-tab.spec.ts"));
  assert.ok(!devices.specs.includes("bots-persistence.spec.ts"));
  assert.ok(devices.specs.every((file) => map.macos.includes(file)));

  // A shared-harness change selects every hosted spec; the Mac still runs only the macOS-only ones.
  const harness = plan("pull_request", ["tests/e2e/fixtures.ts"]);
  assert.equal(harness.scope, "macos");
  assert.deepEqual(harness.shards, [1]);
  assert.deepEqual(harness.specs.toSorted(), map.macos.toSorted());
  assert.deepEqual(plan("pull_request", ["tests/e2e/fixtures.ts"], false), { run: false, scope: "none", shards: [], specs: [] });
});

test("the macOS-only and host-only spec lists name distinct runnable specs once", () => {
  const specs = discoverSpecs();
  const map = validateE2ESpecMap(specs, readE2ESpecMap());
  assert.equal(map.macos.length, 11);
  assert.deepEqual(map.hostOnly, ["keep-going-goals-computer-use.spec.ts"]);
  assert.throws(() => validateE2ESpecMap(specs, { ...map, macos: [...map.macos, "not-a-spec.spec.ts"] }), /not-a-spec\.spec\.ts/u);
  assert.throws(() => validateE2ESpecMap(specs, { ...map, macos: [map.macos[0], map.macos[0]] }), /macos list is malformed/u);
  assert.throws(() => validateE2ESpecMap(specs, { ...map, hostOnly: ["not-a-spec.spec.ts"] }), /not-a-spec\.spec\.ts/u);
  assert.throws(() => validateE2ESpecMap(specs, { ...map, hostOnly: [map.hostOnly[0], map.hostOnly[0]] }), /hostOnly list is malformed/u);
  assert.throws(() => validateE2ESpecMap(specs, { ...map, hostOnly: null }), /hostOnly list is malformed/u);
  assert.throws(
    () => validateE2ESpecMap(specs, { ...map, macos: [...map.macos, map.hostOnly[0]] }),
    /both macos and hostOnly/u,
  );
});

test("high-fanout shared modules escalate pull-request E2E selection to all hosted specs", () => {
  const specs = discoverSpecs();
  const map = readE2ESpecMap();
  for (const file of [
    "renderer/components/ui.tsx",
    "renderer/shared/bots.ts",
    "renderer/shared/assistant.ts",
    "renderer/shared/browser-element-grab.ts",
    "main/services/generation-runtime.ts",
  ]) {
    const selected = selectRelatedE2ESpecs({ changedPaths: [file], specs, map });
    assert.equal(selected.mode, "all", file);
    assert.equal(selected.reason, "high-fanout", file);
    assert.ok(!selected.specs.includes("keep-going-goals-computer-use.spec.ts"), file);
    assert.equal(selected.specs.length, 85, file);
  }
});

test("reverse-import fanout escalates at 8 direct importers or 25 matched specs", () => {
  const makeImporterGraph = (importerCount) => {
    const sourceMap = { "renderer/shared/token.ts": "export const token = 1;\n" };
    for (let index = 0; index < importerCount; index += 1) {
      sourceMap[`renderer/components/feature-${index}.tsx`] = 'import { token } from "../shared/token.js";\nexport const v = token;\n';
    }
    return sourceMap;
  };
  const specs = ["alpha.spec.ts", "beta.spec.ts"];
  const baseMap = {
    version: 1,
    macos: [],
    hostOnly: [],
    full: [],
    specs: {
      "alpha.spec.ts": ["renderer/components/feature-"],
      "beta.spec.ts": ["renderer/components/other"],
    },
  };

  const seven = makeImporterGraph(7);
  const belowImporterLimit = selectRelatedE2ESpecs({
    changedPaths: ["renderer/shared/token.ts"],
    specs,
    sourceFiles: Object.keys(seven),
    readFile: (file) => seven[file],
    map: baseMap,
  });
  assert.equal(belowImporterLimit.mode, "related");
  assert.deepEqual(belowImporterLimit.specs, ["alpha.spec.ts"]);

  const eight = makeImporterGraph(8);
  const atImporterLimit = selectRelatedE2ESpecs({
    changedPaths: ["renderer/shared/token.ts"],
    specs,
    sourceFiles: Object.keys(eight),
    readFile: (file) => eight[file],
    map: baseMap,
  });
  assert.equal(atImporterLimit.mode, "all");
  assert.equal(atImporterLimit.reason, "high-fanout");

  const manySpecs = Array.from({ length: 26 }, (_, index) => `spec-${index}.spec.ts`);
  const specEntriesFor = (matchedCount) =>
    Object.fromEntries(
      manySpecs.map((spec, index) => [
        spec,
        [index < matchedCount ? "renderer/components/target" : "renderer/components/untouched"],
      ]),
    );
  const specGraph = {
    "renderer/lib/leaf-helper.ts": "export const leaf = 1;\n",
    "renderer/components/target.tsx": 'import { leaf } from "../lib/leaf-helper.js";\nexport const view = leaf;\n',
  };
  const twentyFour = selectRelatedE2ESpecs({
    changedPaths: ["renderer/lib/leaf-helper.ts"],
    specs: manySpecs,
    sourceFiles: Object.keys(specGraph),
    readFile: (file) => specGraph[file],
    map: { version: 1, macos: [], hostOnly: [], full: [], specs: specEntriesFor(24) },
  });
  assert.equal(twentyFour.mode, "related");
  assert.equal(twentyFour.specs.length, 24);

  const twentyFive = selectRelatedE2ESpecs({
    changedPaths: ["renderer/lib/leaf-helper.ts"],
    specs: manySpecs,
    sourceFiles: Object.keys(specGraph),
    readFile: (file) => specGraph[file],
    map: { version: 1, macos: [], hostOnly: [], full: [], specs: specEntriesFor(25) },
  });
  assert.equal(twentyFive.mode, "all");
  assert.equal(twentyFive.reason, "high-fanout");
});

test("reverse-import walks expand through importers but stop at full-suite paths, wiring hubs, and 40-import aggregators", () => {
  const deps = Array.from({ length: 40 }, (_, index) => `main/services/dep-${index}.ts`);
  const fixtureSources = {
    "main/services/leaf-logic.ts": "export const leaf = 1;\n",
    "main/services/mapped-feature.ts": 'import { leaf } from "./leaf-logic.js";\nexport const feature = leaf;\n',
    "main/handlers/index.ts": 'import { feature } from "../services/mapped-feature.js";\nexport const h = feature;\n',
    "renderer/lib/ipc.ts": 'import { leaf } from "../../main/services/leaf-logic.js";\nexport const ipc = leaf;\n',
    "renderer/main/app-shell.tsx": 'import { leaf } from "../../main/services/leaf-logic.js";\nexport const shell = leaf;\n',
    "main/services/mega-aggregator.ts": [
      'import { leaf } from "./leaf-logic.js";',
      ...deps.map((dep, index) => `import { d${index} } from "./dep-${index}.js";`),
      "export const all = leaf;",
    ].join("\n"),
    "main/services/behind-hub.ts":
      'import { h } from "../handlers/index.js";\nimport { ipc } from "../../renderer/lib/ipc.js";\nimport { shell } from "../../renderer/main/app-shell.tsx";\nimport { all } from "./mega-aggregator.js";\nexport const behind = [h, ipc, shell, all];\n',
  };
  for (const [index, dep] of deps.entries()) {
    fixtureSources[dep] = `export const d${index} = ${index};\n`;
  }
  const map = {
    version: 1,
    macos: [],
    hostOnly: [],
    full: ["renderer/main/"],
    specs: {
      "feature.spec.ts": ["main/services/mapped-feature"],
      "unrelated.spec.ts": ["main/services/behind-hub"],
    },
  };
  const specs = ["feature.spec.ts", "unrelated.spec.ts"];
  const selected = selectRelatedE2ESpecs({
    changedPaths: ["main/services/leaf-logic.ts"],
    specs,
    sourceFiles: Object.keys(fixtureSources),
    readFile: (file) => fixtureSources[file],
    map,
  });
  assert.equal(selected.mode, "related");
  assert.deepEqual(selected.specs, ["feature.spec.ts"]);

  // Direct edits to map.full still escalate to the full suite.
  const directFull = selectRelatedE2ESpecs({
    changedPaths: ["renderer/main/app-shell.tsx"],
    specs,
    sourceFiles: Object.keys(fixtureSources),
    readFile: (file) => fixtureSources[file],
    map,
  });
  assert.equal(directFull.mode, "all");
  assert.equal(directFull.reason, "infrastructure");

  // Real leaf edits remain scoped and exclude unrelated browser or studio specs.
  const realSpecs = discoverSpecs();
  for (const leaf of ["renderer/components/settings/about-settings.tsx", "main/services/chat-fork-service.ts"]) {
    const leafSelected = selectRelatedE2ESpecs({ changedPaths: [leaf], specs: realSpecs });
    assert.equal(leafSelected.mode, "related", leaf);
    assert.ok(!leafSelected.specs.includes("browser.spec.ts"), leaf);
    assert.ok(!leafSelected.specs.includes("browser-lifecycle.spec.ts"), leaf);
    assert.ok(!leafSelected.specs.includes("studio-foundation.spec.ts"), leaf);
    assert.ok(!leafSelected.specs.includes("design-canvas.spec.ts"), leaf);
  }
});

test("every Computer Use service file selects active hosted specs and ignores hostOnly", async () => {
  const { listSourceFiles } = await import("./ci-related-tests.mjs");
  const specs = discoverSpecs();
  const map = readE2ESpecMap();
  const computerUseFiles = listSourceFiles().filter(
    (file) => file.startsWith("main/services/computer-use/") && !file.endsWith(".test.ts"),
  );
  assert.equal(computerUseFiles.length, 20);
  for (const file of computerUseFiles) {
    const selected = selectRelatedE2ESpecs({ changedPaths: [file], specs, map });
    assert.ok(selected.specs.includes("guided-setup.spec.ts"), file);
    assert.ok(selected.specs.includes("keep-going-goals.spec.ts"), file);
    assert.ok(!selected.specs.includes("keep-going-goals-computer-use.spec.ts"), file);
  }
  const directHostOnly = selectRelatedE2ESpecs({
    changedPaths: ["tests/e2e/keep-going-goals-computer-use.spec.ts"],
    specs,
    map,
  });
  assert.equal(directHostOnly.mode, "all");
  assert.ok(!directHostOnly.specs.includes("keep-going-goals-computer-use.spec.ts"));
});

test("bot-store pairs with bots-starter and related selection falls back to all when Linux has zero active specs", () => {
  const specs = discoverSpecs();
  const map = readE2ESpecMap();
  const botStore = selectRelatedE2ESpecs({
    changedPaths: ["main/services/bot-store-leaf.ts"],
    specs,
    sourceFiles: ["main/services/bot-store-leaf.ts"],
    readFile: () => "export const leaf = 1;\n",
    map,
  });
  assert.equal(botStore.mode, "related");
  assert.ok(botStore.specs.includes("bots-persistence.spec.ts"));
  assert.ok(botStore.specs.includes("bots-starter.spec.ts"));

  const darwinOnlyFixture = {
    "main/services/darwin-only.ts": "export const onlyMac = true;\n",
    "tests/e2e/mac-only.spec.ts":
      'import { test } from "./fixtures";\ntest.skip(process.platform !== "darwin", "macOS only");\ntest("mac", async () => {});\n',
    "tests/e2e/linux-active.spec.ts":
      'import { test } from "./fixtures";\ntest("cross-platform", async () => {});\n',
  };
  const fallback = selectRelatedE2ESpecs({
    changedPaths: ["main/services/darwin-only.ts"],
    specs: ["mac-only.spec.ts", "linux-active.spec.ts"],
    sourceFiles: ["main/services/darwin-only.ts"],
    readFile: (file) => darwinOnlyFixture[file],
    map: {
      version: 1,
      macos: ["mac-only.spec.ts"],
      hostOnly: [],
      full: [],
      specs: {
        "mac-only.spec.ts": ["main/services/darwin-only"],
        "linux-active.spec.ts": ["main/services/other"],
      },
    },
  });
  assert.equal(fallback.mode, "all");
  assert.equal(fallback.reason, "no-active-linux-specs");
  assert.deepEqual(fallback.specs, ["mac-only.spec.ts", "linux-active.spec.ts"]);
});

test("planMacE2E covers Picture in Picture, Settings model picker, and Live surfaces and scales shards past 900s", async () => {
  const { buildTestSelection, formatMacE2ESummary } = await import("./ci-select-tests.mjs");
  const specs = discoverSpecs();
  const map = readE2ESpecMap();

  for (const [changed, expectedSpec] of [
    ["main/services/browser/pip-feed.ts", "browser-throttling.spec.ts"],
    ["renderer/components/model-picker.tsx", "settings-model-picker.spec.ts"],
    ["renderer/shared/assistant.ts", "assistant-scheduled-profile.spec.ts"],
  ]) {
    const e2e = selectRelatedE2ESpecs({ changedPaths: [changed], specs, map });
    const planned = planMacE2E({ eventName: "pull_request", desktop: true, e2e, map, shardCount: 5 });
    assert.equal(planned.run, true, changed);
    assert.equal(planned.scope, "macos", changed);
    assert.deepEqual(planned.shards, [1], changed);
    assert.ok(planned.specs.includes(expectedSpec), `${changed} -> ${expectedSpec}`);
  }

  // At 900s total, one macOS shard still suffices; 901s scales to two; heavy weights cap at shardCount.
  const twoSpecMap = {
    version: 1,
    macos: ["assistant-scheduled-profile.spec.ts", "guided-setup.spec.ts"],
    hostOnly: [],
    full: [],
    specs: {
      "assistant-scheduled-profile.spec.ts": ["renderer/components/assistant"],
      "guided-setup.spec.ts": ["renderer/components/onboarding"],
    },
  };
  const e2eBoth = { mode: "all", reason: "high-fanout", specs: twoSpecMap.macos };
  const atBudget = planMacE2E({
    eventName: "pull_request",
    desktop: true,
    e2e: e2eBoth,
    map: twoSpecMap,
    shardCount: 5,
    weights: { "assistant-scheduled-profile.spec.ts": 450, "guided-setup.spec.ts": 450 },
  });
  assert.deepEqual(atBudget.shards, [1]);
  assert.equal(
    formatMacE2ESummary(atBudget),
    "macOS E2E: 2 macOS-only specs on 1 runner; Linux runs the rest.",
  );

  const overBudget = planMacE2E({
    eventName: "pull_request",
    desktop: true,
    e2e: e2eBoth,
    map: twoSpecMap,
    shardCount: 5,
    weights: { "assistant-scheduled-profile.spec.ts": 451, "guided-setup.spec.ts": 450 },
  });
  assert.deepEqual(overBudget.shards, [1, 2]);
  assert.equal(
    formatMacE2ESummary(overBudget),
    "macOS E2E: 2 macOS-only specs on 2 runners; Linux runs the rest.",
  );

  const capped = buildTestSelection({
    eventName: "pull_request",
    detection: { desktop: true, changedPaths: ["tests/e2e/fixtures.ts"], changedCount: 1, reason: "pull-request-diff" },
    registry: { lanes: [] },
    specs: twoSpecMap.macos,
    map: { ...twoSpecMap, full: ["tests/e2e/fixtures.ts"] },
    shardCount: 3,
    weights: { "assistant-scheduled-profile.spec.ts": 2_000, "guided-setup.spec.ts": 2_000 },
  });
  assert.deepEqual(capped.macE2E.shards, [1, 2, 3]);
});
