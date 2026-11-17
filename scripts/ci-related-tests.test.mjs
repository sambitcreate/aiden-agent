import assert from "node:assert/strict";
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
  "renderer/components/settings/about-settings.tsx": "export const About = 1;\n",
};

const testFiles = [
  "main/services/x.test.ts",
  "main/services/importer.test.ts",
  "main/services/unrelated.test.ts",
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
