import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRendererReadinessGate } from "./renderer-readiness-core";

test("a waiter follows reload generations instead of escaping on the obsolete document", async () => {
  const gate = createRendererReadinessGate();
  gate.reset();
  let delivered = false;
  const waiting = gate.wait().then(() => {
    delivered = true;
  });

  gate.reset();
  await Promise.resolve();
  assert.equal(delivered, false);

  gate.markReady();
  await waiting;
  assert.equal(delivered, true);
});

test("disposal releases a waiter so window teardown cannot hang it", async () => {
  const gate = createRendererReadinessGate();
  gate.reset();
  const waiting = gate.wait();
  gate.dispose();
  await waiting;
});

test("main invalidates readiness and reloads after the renderer process exits", () => {
  const main = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  // Keep recovery checks inside the crash callback, allowing diagnostics before
  // reset and a backoff promise around the tracked reload.
  const crashHandler = main.match(
    /createdWindow\.webContents\.on\(\s*"render-process-gone",[\s\S]*?^ {2}\}\);/mu,
  )?.[0];
  assert.ok(crashHandler, "main must register a renderer crash handler");
  assert.match(
    crashHandler,
    /rendererReadiness\.reset\(\);[\s\S]*const recovery = mainWindowLoads\.replace\(/u,
  );
  assert.match(
    crashHandler,
    /const recovery = mainWindowLoads\.replace\([\s\S]*await createdWindow\.loadURL\(mainWindowUrl\)/u,
  );
});
