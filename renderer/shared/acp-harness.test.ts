import assert from "node:assert/strict";
import test from "node:test";

import { projectRuntime } from "../../main/services/acp/status.js";
import {
  acpHarnessUnavailableReason,
  formatHarnessBytes,
  harnessSignInHint,
  harnessRuntimeSummary,
  parseAcpHarnessStatus,
  unattendedFallbackProviderId,
} from "./acp-harness.js";

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
  assert.equal(
    harnessRuntimeSummary({ status: "not_installed", downloadBytes: 111_456_962, downloadHost: "dl.google.com" }),
    "Not installed.",
  );
});

test("the publisher and download host reach the renderer only as plain names", () => {
  const parsed = parseAcpHarnessStatus({
    providerId: "antigravity",
    publisher: "Google",
    runtime: projectRuntime({ status: "not_installed", version: "1.3.0", downloadBytes: 1, requiredBytes: 2 }, "dl.google.com"),
    signedIn: false,
    busy: false,
  });
  assert.equal(parsed?.publisher, "Google");
  assert.equal(parsed?.runtime.downloadHost, "dl.google.com");
  // Anything that is not a bare host name (a URL, a path, credentials) is dropped.
  for (const downloadHost of ["https://dl.google.com/x.zip", "user@dl.google.com", "dl.google.com/agy", "", 42]) {
    const rejected = parseAcpHarnessStatus({
      providerId: "antigravity",
      runtime: { status: "not_installed", downloadHost },
      signedIn: false,
      busy: false,
    });
    assert.equal(rejected?.runtime.downloadHost, undefined, String(downloadHost));
  }
  assert.equal(
    parseAcpHarnessStatus({ providerId: "antigravity", publisher: "x".repeat(65), runtime: { status: "installed" }, signedIn: false, busy: false })
      ?.publisher,
    undefined,
  );
});

test("unattended surfaces never inherit an agent-backed last-used provider", () => {
  assert.equal(unattendedFallbackProviderId("antigravity"), undefined);
  assert.equal(unattendedFallbackProviderId("openai"), "openai");
  assert.equal(unattendedFallbackProviderId(undefined), undefined);
  assert.match(acpHarnessUnavailableReason("antigravity") ?? "", /^Google Antigravity runs only in chats/u);
  assert.equal(acpHarnessUnavailableReason("openai"), undefined);
});

test("the sign-in hint tells the user what the runtime still needs, and only that", () => {
  assert.equal(harnessSignInHint({ status: "not_installed" }), "Install the runtime above before signing in.");
  assert.equal(harnessSignInHint({ status: "failed", message: "Disk full." }), "Install the runtime above before signing in.");
  // There is no Install button to point at in these states.
  assert.equal(harnessSignInHint({ status: "update_available" }), "Update the runtime above before signing in.");
  assert.equal(harnessSignInHint({ status: "installing", phase: "extracting" }), "You can sign in when the installation finishes.");
  assert.equal(
    harnessSignInHint({ status: "unsupported", message: "No build for this computer." }),
    "Sign-in needs the runtime, which isn't available for this computer.",
  );
  // Still loading, or ready: no hint.
  assert.equal(harnessSignInHint(null), undefined);
  assert.equal(harnessSignInHint({ status: "installed", version: "1.3.0" }), undefined);
});
