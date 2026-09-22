/* global process */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import electron from "electron";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "subagent-inference-worker-smoke.cjs",
);
const worker = path.join(repositoryRoot, "build", "main", "subagent-inference-worker.js");
const runtime = path.join(repositoryRoot, "build", "main", "subagent-inference-worker-runtime.js");

function runSmoke(entry = worker) {
  return new Promise((resolve) => {
    execFile(
      electron,
      [fixture],
      {
        cwd: repositoryRoot,
        timeout: 15_000,
        env: {
          ...process.env,
          AIDEN_SUBAGENT_WORKER_SMOKE_ENTRY: entry,
        },
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      },
    );
  });
}

test("built Electron subagent worker completes a custom OpenAI-compatible request", async () => {
  assert.equal(existsSync(worker), true, "worker bootstrap artifact is missing");
  assert.equal(existsSync(runtime), true, "worker runtime artifact is missing");
  const result = await runSmoke();
  assert.equal(result.error, null, result.stderr);
  assert.match(result.stdout, /AIDEN_SUBAGENT_WORKER_READY/u);
  assert.match(result.stdout, /AIDEN_SUBAGENT_WORKER_COMPLETED/u);
  assert.equal(result.stderr, "");
});

test("built worker reports a missing runtime before readiness", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-subagent-worker-bootstrap-"));
  const isolatedBootstrap = path.join(root, "subagent-inference-worker.js");
  try {
    await copyFile(worker, isolatedBootstrap);
    const result = await runSmoke(isolatedBootstrap);
    assert.notEqual(result.error, null);
    assert.match(result.stderr, /AIDEN_SUBAGENT_BOOTSTRAP_FAILURE/u);
    assert.doesNotMatch(result.stdout, /AIDEN_SUBAGENT_WORKER_READY/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
