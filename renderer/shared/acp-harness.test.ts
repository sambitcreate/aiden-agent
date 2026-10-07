import assert from "node:assert/strict";
import test from "node:test";

import { projectRuntime } from "../../main/services/acp/status.js";
import { formatHarnessBytes, harnessRuntimeSummary, parseAcpHarnessStatus } from "./acp-harness.js";

test("main's projection of every install state survives the renderer parser", () => {
  const states = [
    { status: "unsupported", reason: "No build for this computer." },
    { status: "not_installed", version: "1.3.0", downloadBytes: 111_456_962, requiredBytes: 900_000_000 },
    { status: "installing", version: "1.3.0", progress: { phase: "downloading", receivedBytes: 10, totalBytes: 20 } },
    { status: "installed", version: "1.3.0", runtimeDir: "/private/path" },
    { status: "update_available", installedVersion: "1.2.1", version: "1.3.0", downloadBytes: 1, requiredBytes: 2 },
    { status: "failed", version: "1.3.0", message: "Disk full.", downloadBytes: 1, requiredBytes: 2 },
  ] as const;
  for (const state of states) {
    const parsed = parseAcpHarnessStatus({ providerId: "antigravity", runtime: projectRuntime(state), signedIn: false, busy: false });
    assert.equal(parsed?.runtime.status, state.status);
    assert.equal(JSON.stringify(parsed).includes("/private/path"), false, "local paths never reach the renderer");
  }
});

test("the parser rejects malformed or unknown status", () => {
  assert.equal(parseAcpHarnessStatus(null), undefined);
  assert.equal(parseAcpHarnessStatus({ providerId: "Antigravity!", runtime: { status: "installed" }, signedIn: true, busy: false }), undefined);
  assert.equal(parseAcpHarnessStatus({ providerId: "antigravity", runtime: { status: "exploded" }, signedIn: true, busy: false }), undefined);
  assert.equal(parseAcpHarnessStatus({ providerId: "antigravity", runtime: { status: "installed" }, signedIn: "yes", busy: false }), undefined);
  const parsed = parseAcpHarnessStatus({
    providerId: "antigravity",
    runtime: { status: "installing", phase: "teleporting", receivedBytes: -1 },
    signedIn: true,
    busy: false,
  });
  assert.deepEqual(parsed?.runtime, { status: "installing" });
});

test("summaries describe sizes and progress in plain terms", () => {
  assert.equal(formatHarnessBytes(111_456_962), "111 MB");
  assert.equal(formatHarnessBytes(1_234_000_000), "1.2 GB");
  assert.equal(
    harnessRuntimeSummary({ status: "installing", phase: "downloading", receivedBytes: 50_000_000, totalBytes: 111_000_000 }),
    "Downloading 50 MB of 111 MB…",
  );
  assert.equal(harnessRuntimeSummary({ status: "installing", phase: "validating" }), "Starting it once to confirm it works…");
  assert.equal(harnessRuntimeSummary({ status: "not_installed", downloadBytes: 111_456_962 }), "Not installed. 111 MB download from Google.");
});
