/* global structuredClone, URL */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { discoverSpecs } from "./ci-e2e-shards.mjs";
import {
  parseImportSpecifiers,
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
