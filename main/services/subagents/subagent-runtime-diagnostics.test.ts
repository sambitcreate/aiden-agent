import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BoundedSubagentDiagnosticCapture,
  createSubagentDiagnosticId,
  flushSubagentRuntimeDiagnostics,
  initSubagentRuntimeDiagnostics,
  MAX_SUBAGENT_RUNTIME_LOG_BYTES,
  MAX_SUBAGENT_RUNTIME_LOG_AGE_MS,
  sanitizeSubagentDiagnosticText,
  writeSubagentRuntimeFailure,
} from "./subagent-runtime-diagnostics.js";

test("bounded startup capture retains only the pre-ready tail", () => {
  const capture = new BoundedSubagentDiagnosticCapture(8);
  capture.append("0123456789");
  assert.equal(capture.text(), "23456789");
  capture.stop();
  capture.append("secret-after-ready");
  assert.equal(capture.text(), "23456789");
});

test("runtime diagnostics rotate during a long-running process and preserve owner-only modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-subagent-rotation-"));
  const target = path.join(root, "subagent-runtime.log");
  const previous = path.join(root, "subagent-runtime.prev.log");
  try {
    initSubagentRuntimeDiagnostics(target);
    const detail = "x".repeat(1_024);
    for (let index = 0; index < 2_200; index += 1) {
      writeSubagentRuntimeFailure({
        diagnosticId: `SA-rotation-${index}`,
        providerId: "custom:test",
        modelId: "test-model",
        failure: "inference-startup",
        attempts: 1,
        diagnostics: [{ stage: "bootstrap", code: "pre_ready_exit", detail }],
      });
    }
    await flushSubagentRuntimeDiagnostics();

    const [currentStat, previousStat] = await Promise.all([stat(target), stat(previous)]);
    assert.ok(currentStat.size > 0);
    assert.ok(currentStat.size <= MAX_SUBAGENT_RUNTIME_LOG_BYTES);
    assert.ok(previousStat.size > 0);
    assert.ok(previousStat.size <= MAX_SUBAGENT_RUNTIME_LOG_BYTES);
    assert.equal(currentStat.mode & 0o777, 0o600);
    assert.equal(previousStat.mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent diagnostic text redacts secrets, URLs, paths, and controls", () => {
  const sanitized = sanitizeSubagentDiagnosticText(
    [
      "Bearer hidden-token",
      "Authorization: Basic YWxpY2U6cGFzc3dvcmQ=",
      "password=hunter2",
      "AWS_SECRET_ACCESS_KEY=aws-secret-value",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.signaturevalue",
      "ghp_1234567890abcdefghijklmnopqrst",
      "https://private.example/v1",
      "/Users/alice/private.ts",
      "api_key=secret\u0000",
      "module boom",
    ].join("\n"),
  );
  assert.doesNotMatch(
    sanitized,
    /hidden-token|YWxpY2U6cGFzc3dvcmQ|hunter2|aws-secret-value|eyJhbGci|signaturevalue|ghp_1234567890|private\.example|alice|private\.ts|=secret/u,
  );
  assert.match(sanitized, /REDACTED/u);
  assert.match(sanitized, /boom/u);
});

test("runtime diagnostics are owner-only structured records without raw evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-subagent-diagnostic-"));
  const target = path.join(root, "subagent-runtime.log");
  try {
    initSubagentRuntimeDiagnostics(target);
    const diagnosticId = createSubagentDiagnosticId();
    writeSubagentRuntimeFailure({
      diagnosticId,
      runId: "run-safe",
      generationId: "generation-safe",
      childId: "child-safe",
      providerId: "custom:test",
      modelId: "test-model",
      failure: "inference-startup",
      attempts: 4,
      diagnostics: [
        {
          stage: "bootstrap",
          code: "pre_ready_exit",
          durationMs: 12.6,
          exitCode: 1,
          detail:
            "Error at /Users/alice/project/worker.js https://provider.invalid Bearer hidden-token",
        },
      ],
    });
    await flushSubagentRuntimeDiagnostics();

    const raw = await readFile(target, "utf8");
    const record = JSON.parse(raw.trim()) as Record<string, unknown>;
    assert.equal(record.diagnosticId, diagnosticId);
    assert.equal(record.attempts, 4);
    assert.doesNotMatch(raw, /alice|provider\.invalid|hidden-token/u);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent diagnostics rotate by age and reject a symlinked root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-subagent-age-root-"));
  const originalNow = Date.now;
  let current = Date.parse("2026-08-01T00:00:00.000Z");
  Date.now = () => current;
  try {
    const target = path.join(root, "subagent-runtime.log");
    initSubagentRuntimeDiagnostics(target);
    const record = (diagnosticId: string) => ({
      diagnosticId,
      providerId: "custom:test",
      modelId: "test-model",
      failure: "provider" as const,
      attempts: 1,
      diagnostics: [{ stage: "provider" as const, code: "provider_failure" as const }],
    });
    writeSubagentRuntimeFailure(record("SA-old"));
    await flushSubagentRuntimeDiagnostics();
    current += MAX_SUBAGENT_RUNTIME_LOG_AGE_MS + 1_000;
    writeSubagentRuntimeFailure(record("SA-new"));
    await flushSubagentRuntimeDiagnostics();
    assert.doesNotMatch(await readFile(target, "utf8"), /SA-old/u);
    await assert.rejects(stat(path.join(root, "subagent-runtime.prev.log")), { code: "ENOENT" });

    const outside = path.join(root, "outside");
    const linked = path.join(root, "linked");
    await mkdir(outside);
    await symlink(outside, linked);
    initSubagentRuntimeDiagnostics(path.join(linked, "subagent-runtime.log"));
    writeSubagentRuntimeFailure(record("SA-escape"));
    await flushSubagentRuntimeDiagnostics();
    await assert.rejects(stat(path.join(outside, "subagent-runtime.log")), { code: "ENOENT" });
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized retained subagent rotation is removed at startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-subagent-retained-size-"));
  const target = path.join(root, "subagent-runtime.log");
  const previous = path.join(root, "subagent-runtime.prev.log");
  try {
    await writeFile(previous, "x".repeat(MAX_SUBAGENT_RUNTIME_LOG_BYTES + 1), { mode: 0o600 });
    initSubagentRuntimeDiagnostics(target);
    await assert.rejects(stat(previous), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
