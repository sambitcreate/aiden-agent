import process from "node:process";
import assert from "node:assert/strict";
import test from "node:test";
import { safeTestResult, sanitizeTestDetails } from "./safe-test-reporter.mjs";

test("safe reporter retains useful timing/identity without assertion content or paths", () => {
  const result = safeTestResult({ location: { file: "/repo/tests/e2e/chat.spec.ts" }, titlePath: () => ["chat", "fails safely"] }, { status: "timedOut", retry: 1, duration: 700, errors: [{ message: "secret user content" }] }, "/repo");
  assert.equal(result.category, "timeout");
  assert.equal(result.retry, 1);
  assert.equal(result.durationMs, 700);
  assert.match(result.testId, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("/repo"));
  assert.deepEqual(sanitizeTestDetails([{ ...result, stdout: "private", path: "/home/private" }]), [result]);
});

test("unsafe identities and fields never become uploadable records", () => {
  assert.equal(safeTestResult({ location: { file: "/private/chat.spec.ts" }, titlePath: () => [] }, { status: "failed" }, "/repo"), undefined);
  assert.deepEqual(sanitizeTestDetails([{ testId: "user@example.com", category: "test-failed", phase: "test", retry: 0, durationMs: 1 }]), []);
  assert.deepEqual(sanitizeTestDetails([{ category: "setup-failed", phase: "setup", retry: 0, durationMs: 0, error: "secret" }]), [{ category: "setup-failed", phase: "setup", retry: 0, durationMs: 0 }]);
  assert.deepEqual(sanitizeTestDetails([{ category: "timeout", phase: "test", retry: 9, durationMs: 0 }]), []);
});

test("reporter lifecycle and receipt command emit only safe fields and tolerate missing details", async (t) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { default: Reporter } = await import("./safe-test-reporter.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-reporter-"));
  const original = process.cwd();
  t.after(async () => { process.chdir(original); await fs.rm(root, { recursive: true, force: true }); });
  const command = path.join(original, "scripts/write-diagnostic-failure-receipt.mjs");
  process.chdir(root);
  const reporter = new Reporter();
  reporter.onError(new Error("secret setup credential"));
  reporter.onTestEnd({ location: { file: path.join(process.cwd(), "tests/e2e/chat.spec.ts") }, titlePath: () => ["fixture"] }, { status: "failed", retry: 0, duration: 42, error: "private assertion" });
  reporter.onEnd();
  const details = path.join(root, "test-results/safe-test-details.json");
  for (const kind of ["valid", "missing", "malformed", "oversized"]) {
    const input = kind === "valid" ? details : path.join(root, kind);
    if (kind === "malformed") await fs.writeFile(input, "not json secret");
    if (kind === "oversized") await fs.writeFile(input, "x".repeat(65537));
    const output = path.join(root, `receipt-${kind}.json`);
    const child = spawnSync(process.execPath, [command, output, "electron-e2e", "test-failed", input], { env: { ...process.env, GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "private-credential", GITHUB_RUN_ATTEMPT: "2" } });
    assert.equal(child.status, 0, child.stderr.toString());
    const raw = await fs.readFile(output, "utf8"); const receipt = JSON.parse(raw);
    assert.deepEqual(receipt.identity, { commit: "a".repeat(40), runAttempt: 2 });
    assert.equal(receipt.tests.length, kind === "valid" ? 2 : 0);
    assert.ok(!raw.includes("private") && !raw.includes("secret") && !raw.includes(root));
  }
});
