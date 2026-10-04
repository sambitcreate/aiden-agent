import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { budgetViolations, measureInitialJavaScript } from "./check-renderer-bundle-budget.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-bundle-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "assets"));
  const files = {
    "entry.js": "export const value = 1;\n".repeat(400),
    "runtime.js": "export {};\n",
    "vendor.js": randomBytes(2048).toString("base64"),
    "lazy-settings.js": "x".repeat(50_000),
    "styles.css": "body { color: red; }\n",
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(root, "assets", name), contents);
  const html = path.join(root, "main-window.html");
  await writeFile(html, `<!doctype html><html><head>
    <script type="module" crossorigin src="./assets/entry.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/runtime.js">
    <link rel="modulepreload" href="./assets/vendor.js">
    <link rel="modulepreload" href="./assets/vendor.js">
    <link rel="prefetch" href="./assets/lazy-settings.js">
    <link rel="stylesheet" href="./assets/styles.css">
    <script src="https://cdn.example.test/remote.js"></script>
  </head></html>`);
  return { html, files };
}

test("initial JS counts the entry and each modulepreload once, but not lazy chunks, styles, or remote URLs", async (t) => {
  const { html, files } = await fixture(t);
  const measurement = await measureInitialJavaScript(html);
  const eager = ["entry.js", "runtime.js", "vendor.js"];
  assert.deepEqual(measurement.files.map((file) => path.basename(file.source)), eager);
  assert.equal(measurement.raw, eager.reduce((total, name) => total + Buffer.byteLength(files[name]), 0));
  assert.ok(measurement.gzip > 0 && measurement.gzip < measurement.raw, "repetitive code compresses");
});

test("the budget fails on either raw or gzip growth and passes at the limit", async (t) => {
  const measurement = await measureInitialJavaScript((await fixture(t)).html);
  const exact = { raw: measurement.raw, gzip: measurement.gzip };
  assert.deepEqual(budgetViolations(measurement, exact), []);
  assert.equal(budgetViolations(measurement, { ...exact, raw: exact.raw - 1 }).length, 1);
  assert.match(budgetViolations(measurement, { ...exact, gzip: exact.gzip - 1 })[0], /^gzip /u);
});
