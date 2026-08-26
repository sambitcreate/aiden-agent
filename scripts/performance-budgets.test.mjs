import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  verifyPackagePerformanceBudget,
  verifyPerformanceBudgets,
} from "./performance-budgets.mjs";

test("performance budgets report the bounded Phase 0 source-map baseline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-budget-test-"));
  await mkdir(path.join(root, "renderer"));
  await writeFile(path.join(root, "renderer", "main.js"), "export {};\n");
  assert.deepEqual(await verifyPerformanceBudgets(root), {
    rendererJavaScriptBytes: 11,
    largestRendererChunkBytes: 11,
    sourceMapBytes: 0,
  });
  await writeFile(path.join(root, "renderer", "main.js.map"), "{}");
  assert.equal((await verifyPerformanceBudgets(root)).sourceMapBytes, 2);
});

test("package budget measures the unpacked file payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-package-budget-test-"));
  await mkdir(path.join(root, "Contents", "Resources"), { recursive: true });
  await writeFile(path.join(root, "Contents", "Resources", "app.asar"), "bounded");
  assert.deepEqual(await verifyPackagePerformanceBudget(root), {
    packageBytes: 7,
    packageFiles: 1,
  });
});
