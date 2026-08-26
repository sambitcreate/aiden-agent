import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

/* global process */

const helperPath = process.env.AIDEN_AMBIENT_MUSIC_TEST_HELPER;

function runProtocol(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`helper exited with ${code ?? signal}: ${stderr}`));
        return;
      }
      resolve(stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
    for (const line of lines) child.stdin.write(`${line}\n`);
  });
}

function runSelfTest() {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, ["--self-test"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`self-test exited with ${code ?? signal}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test("Ambient Music reserves stdout exclusively for protocol JSON", async () => {
  const { stdout, stderr } = await runSelfTest();
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.ok, true);
  assert.equal(result.controlContracts, "verified");
  assert.match(stderr, /simulated third-party diagnostic/);
});

test("Ambient Music helper enforces its bounded protocol contract", async () => {
  assert.ok(helperPath, "AIDEN_AMBIENT_MUSIC_TEST_HELPER is required");
  const oversized = JSON.stringify({
    version: 1,
    requestId: "oversized-1",
    method: "hello",
    params: { padding: "x".repeat(66_000) },
  });
  const messages = await runProtocol([
    oversized,
    JSON.stringify({ version: true, requestId: "version-1", method: "hello", params: {} }),
    JSON.stringify({ version: 1, requestId: "hello-1", method: "hello", params: {} }),
    JSON.stringify({ version: 1, requestId: "hello-1", method: "hello", params: {} }),
    JSON.stringify({ version: 1, requestId: "weights-1", method: "setWeights", params: { weights: [0.6, 0.4] } }),
    JSON.stringify({ version: 1, requestId: "drums-1", method: "setDrumless", params: { enabled: 1 } }),
    JSON.stringify({ version: 1, requestId: "play-1", method: "play", params: {} }),
    JSON.stringify({ version: 1, requestId: "shutdown-1", method: "shutdown", params: {} }),
  ]);

  const ready = messages.find((message) => message.type === "event" && message.event === "ready");
  assert.equal(ready.sequence, 1);
  assert.equal(ready.detail.modelRootApproved, false);
  assert.equal(messages.find((message) => message.error?.code === "unsupported_protocol")?.requestId, "version-1");
  assert.equal(messages.find((message) => message.error?.code === "duplicate_request")?.requestId, "hello-1");
  assert.deepEqual(messages.find((message) => message.requestId === "weights-1")?.result.weights, [0.6, 0.4]);
  assert.equal(messages.find((message) => message.requestId === "drums-1")?.error.code, "invalid_request");
  assert.equal(messages.find((message) => message.requestId === "play-1")?.error.code, "model_not_loaded");
  assert.equal(messages.find((message) => message.requestId === "shutdown-1")?.ok, true);
  assert.ok(messages.some((message) => message.error?.message === "Helper request is too large."));
});
