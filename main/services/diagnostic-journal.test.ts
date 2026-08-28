import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  deleteDiagnosticJournalFiles,
  diagnosticJournalStatus,
  flushDiagnosticJournal,
  initDiagnosticJournal,
  listDiagnosticJournalFiles,
  MAX_DIAGNOSTIC_LOG_AGE_MS,
  MAX_DIAGNOSTIC_LOG_BYTES,
  MAX_DIAGNOSTIC_LOG_FILES,
  pruneDiagnosticJournalRetention,
  writeDiagnosticEvent,
  writeDiagnosticEventSync,
  writeLegacyDiagnostic,
} from "./diagnostic-journal.js";

async function withJournal(
  profile: "development" | "production",
  run: (target: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-journal-"));
  const target = path.join(dir, profile === "development" ? "aiden-dev.log" : "aiden.log");
  try {
    initDiagnosticJournal({ targetPath: target, profile, sessionId: "session-test" });
    await run(target, dir);
  } finally {
    await flushDiagnosticJournal();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("production legacy adapter omits arbitrary messages and secrets", async () => {
  await withJournal("production", async (target) => {
    writeLegacyDiagnostic("error", "providers", [
      "provider failed Authorization: Bearer live-secret at /workspace/private/file.ts",
      new Error("raw provider response"),
    ]);
    await flushDiagnosticJournal();
    const contents = await fs.readFile(target, "utf8");
    assert.doesNotMatch(contents, /provider failed|live-secret|workspace|private|raw provider response/u);
    const record = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> })
      .find((candidate) => candidate.event === "providers-failed");
    assert.deepEqual(Object.keys(record?.fields ?? {}).sort(), [
      "errorType",
      "fingerprint",
    ]);
  });
});

test("production journal strips development-only fields from typed callers", async () => {
  await withJournal("production", async (target) => {
    const event = writeDiagnosticEvent({
      level: "error",
      area: "providers",
      event: "provider-failed",
      outcome: "failed",
      fields: {
        legacyScope: "providers",
        message: "Authorization: Bearer raw-secret at /private/workspace/file.ts",
        errorType: "TypeError",
      },
    });
    await flushDiagnosticJournal();
    assert.deepEqual(event.fields, { errorType: "TypeError" });
    const contents = await fs.readFile(target, "utf8");
    assert.doesNotMatch(contents, /legacyScope|message|raw-secret|workspace/u);
  });
});

test("journal enforces owner-only modes", async () => {
  await withJournal("production", async (target, dir) => {
    await flushDiagnosticJournal();
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  });
});

test("rollback mode preserves fatal tombstones while disabling general writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-rollback-"));
  const target = path.join(dir, "aiden.log");
  try {
    initDiagnosticJournal({
      targetPath: target,
      profile: "production",
      sessionId: "session-rollback",
      writeMode: "fatal-only",
    });
    writeDiagnosticEvent({
      level: "error",
      area: "app",
      event: "app-failed",
      outcome: "failed",
    });
    writeDiagnosticEventSync({
      level: "fatal",
      area: "app",
      event: "bootstrap-import-failed",
      outcome: "failed",
    });
    await flushDiagnosticJournal();
    const contents = await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8");
    assert.doesNotMatch(contents, /app-failed/u);
    assert.match(contents, /bootstrap-import-failed/u);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("active writes rotate before the cap and remove stale artifacts", async () => {
  await withJournal("production", async (target) => {
    await fs.writeFile(`${target}.4`, "stale", { mode: 0o600 });
    await fs.writeFile(`${target}.tmp`, "stale", { mode: 0o600 });
    initDiagnosticJournal({ targetPath: target, profile: "production", sessionId: "session-rotate" });
    await flushDiagnosticJournal();
    const currentBytes = (await fs.stat(target)).size;
    await fs.appendFile(target, "x".repeat(MAX_DIAGNOSTIC_LOG_BYTES - currentBytes - 64));
    writeDiagnosticEvent({
      level: "warn",
      area: "diagnostics",
      event: "rotation-fixture",
      fields: { sequence: 1 },
    });
    await flushDiagnosticJournal();
    const files = await listDiagnosticJournalFiles();
    assert.ok(files.length >= 3 && files.length <= MAX_DIAGNOSTIC_LOG_FILES + 1);
    for (const file of files) {
      assert.ok((await fs.stat(file)).size <= MAX_DIAGNOSTIC_LOG_BYTES);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
    await assert.rejects(fs.stat(`${target}.4`), { code: "ENOENT" });
    await assert.rejects(fs.stat(`${target}.tmp`), { code: "ENOENT" });
  });
});

test("expired rotations are pruned on the next append", async () => {
  const current = new Date("2026-08-27T12:00:00.000Z");
  await withJournal("production", async (target) => {
    await flushDiagnosticJournal();
    const oldRotation = `${target}.1`;
    await fs.writeFile(oldRotation, "old", { mode: 0o600 });
    const old = new Date(current.getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS - 1_000);
    await fs.utimes(oldRotation, old, old);
    initDiagnosticJournal({
      targetPath: target,
      profile: "production",
      sessionId: "session-retention",
      now: () => current,
    });
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check" });
    await flushDiagnosticJournal();
    await assert.rejects(fs.stat(`${target}.2`), { code: "ENOENT" });
  });
});

test("oversized retained rotations are removed at startup", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-retained-size-"));
  const target = path.join(dir, "aiden.log");
  try {
    await fs.writeFile(`${target}.1`, "x".repeat(MAX_DIAGNOSTIC_LOG_BYTES + 1), { mode: 0o600 });
    initDiagnosticJournal({ targetPath: target, profile: "production" });
    await flushDiagnosticJournal();
    await assert.rejects(fs.stat(`${target}.1`), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an expired active journal is segmented at startup and removed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-active-age-"));
  const target = path.join(dir, "aiden.log");
  const current = new Date("2026-08-27T12:00:00.000Z");
  try {
    await fs.writeFile(target, `${JSON.stringify({ version: 1, at: "2025-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
    const old = new Date(current.getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS - 1_000);
    await fs.utimes(target, old, old);
    initDiagnosticJournal({ targetPath: target, profile: "production", now: () => current });
    await flushDiagnosticJournal();
    assert.doesNotMatch(await fs.readFile(target, "utf8"), /2025-01-01/u);
    await assert.rejects(fs.stat(`${target}.1`), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("legacy development logs are preserved owner-only but excluded from the structured journal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-legacy-"));
  const target = path.join(dir, "aiden-dev.log");
  try {
    await fs.writeFile(target, "=== Aiden dev session ===\npassword=legacy-secret\n", { mode: 0o600 });
    await fs.writeFile(path.join(dir, "aiden-dev.prev.log"), "legacy", { mode: 0o600 });
    initDiagnosticJournal({ targetPath: target, profile: "development" });
    await flushDiagnosticJournal();
    assert.doesNotMatch(await fs.readFile(target, "utf8"), /legacy-secret|Aiden dev session/u);
    await assert.rejects(fs.stat(path.join(dir, "aiden-dev.prev.log")), { code: "ENOENT" });
    assert.match(await fs.readFile(path.join(dir, "aiden-dev.legacy.log"), "utf8"), /legacy-secret/u);
    assert.equal((await fs.stat(path.join(dir, "aiden-dev.legacy.log"))).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(path.join(dir, "aiden-dev.legacy.prev.log"), "utf8"), "legacy");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("active and fatal segments rotate by age without a restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-live-age-"));
  const target = path.join(dir, "aiden.log");
  let current = new Date("2026-08-01T00:00:00.000Z");
  try {
    initDiagnosticJournal({ targetPath: target, profile: "production", now: () => current });
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 1 } });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
    await flushDiagnosticJournal();
    current = new Date(current.getTime() + MAX_DIAGNOSTIC_LOG_AGE_MS + 1_000);
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 2 } });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    await flushDiagnosticJournal();
    assert.doesNotMatch(await fs.readFile(target, "utf8"), /"sequence":1/u);
    await assert.rejects(fs.stat(`${target}.1`), { code: "ENOENT" });
    assert.doesNotMatch(await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8"), /"sequence":1/u);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fatal retention age survives restarts and expired legacy archives are pruned", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-restart-age-"));
  const target = path.join(dir, "aiden-dev.log");
  let current = new Date("2026-08-01T00:00:00.000Z");
  try {
    initDiagnosticJournal({ targetPath: target, profile: "development", now: () => current });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
    await flushDiagnosticJournal();

    current = new Date(current.getTime() + 6 * 24 * 60 * 60 * 1_000);
    initDiagnosticJournal({ targetPath: target, profile: "development", now: () => current });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    await flushDiagnosticJournal();

    const legacy = path.join(dir, "aiden-dev.legacy.log");
    const legacyPrevious = path.join(dir, "aiden-dev.legacy.prev.log");
    await fs.writeFile(legacy, "legacy", { mode: 0o600 });
    await fs.writeFile(legacyPrevious, "legacy", { mode: 0o600 });
    const expired = new Date(current.getTime() - MAX_DIAGNOSTIC_LOG_AGE_MS - 1_000);
    await fs.utimes(legacy, expired, expired);
    await fs.utimes(legacyPrevious, expired, expired);

    current = new Date(current.getTime() + 2 * 24 * 60 * 60 * 1_000);
    initDiagnosticJournal({ targetPath: target, profile: "development", now: () => current });
    await flushDiagnosticJournal();
    assert.doesNotMatch(await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8"), /"sequence":1/u);
    await assert.rejects(fs.stat(legacy), { code: "ENOENT" });
    await assert.rejects(fs.stat(legacyPrevious), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a retention sweep cannot erase a synchronous fatal written at its boundary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-fatal-sweep-"));
  const target = path.join(dir, "aiden.log");
  let current = new Date("2026-08-01T00:00:00.000Z");
  try {
    initDiagnosticJournal({ targetPath: target, profile: "production", now: () => current });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
    await flushDiagnosticJournal();
    current = new Date(current.getTime() + MAX_DIAGNOSTIC_LOG_AGE_MS + 1_000);
    const sweep = pruneDiagnosticJournalRetention(current);
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    await sweep;
    const fatal = await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8");
    assert.match(fatal, /"sequence":2/u);
    assert.doesNotMatch(fatal, /"sequence":1/u);

    const source = await fs.readFile(new URL("./diagnostic-journal.ts", import.meta.url), "utf8");
    const start = source.indexOf("function pruneFatalRetentionSync");
    const end = source.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(source.slice(start, end), /\bawait\b/u);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a symlinked log root disables the journal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-root-link-"));
  const outside = path.join(dir, "outside");
  const root = path.join(dir, "logs");
  try {
    await fs.mkdir(outside);
    await fs.symlink(outside, root);
    initDiagnosticJournal({ targetPath: path.join(root, "aiden.log"), profile: "production" });
    writeDiagnosticEvent({ level: "error", area: "app", event: "app-failed" });
    await flushDiagnosticJournal();
    assert.equal(diagnosticJournalStatus().enabled, false);
    await assert.rejects(fs.stat(path.join(outside, "aiden.log")), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a symlinked journal cannot modify its target", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-symlink-"));
  try {
    const victim = path.join(dir, "victim.txt");
    const target = path.join(dir, "aiden.log");
    await fs.writeFile(victim, "keep", { mode: 0o644 });
    await fs.symlink(victim, target);
    initDiagnosticJournal({ targetPath: target, profile: "production" });
    writeDiagnosticEvent({ level: "error", area: "app", event: "app-failed" });
    await flushDiagnosticJournal();
    assert.equal(await fs.readFile(victim, "utf8"), "keep");
    assert.equal((await fs.stat(victim)).mode & 0o777, 0o644);
    assert.equal(diagnosticJournalStatus().writeFailed, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("queue overflow is bounded and reported without throwing", async () => {
  await withJournal("production", async () => {
    for (let index = 0; index < 2_000; index += 1) {
      writeDiagnosticEvent({
        level: "warn",
        area: "diagnostics",
        event: "backpressure-fixture",
        fields: { sequence: index },
      });
    }
    assert.ok(diagnosticJournalStatus().droppedWrites > 0);
    await flushDiagnosticJournal();
    assert.equal(diagnosticJournalStatus().pendingWrites, 0);
  });
});

test("list and delete are exhaustive without touching neighboring state", async () => {
  await withJournal("production", async (target, dir) => {
    const authoritative = path.join(dir, "settings.json");
    await fs.writeFile(authoritative, "keep", "utf8");
    await fs.writeFile(`${target}.1`, "{}\n", { mode: 0o600 });
    assert.equal((await listDiagnosticJournalFiles()).length, 3);
    await deleteDiagnosticJournalFiles();
    assert.deepEqual((await listDiagnosticJournalFiles()).sort(), [target, path.join(dir, "aiden-fatal.log")].sort());
    assert.equal(await fs.readFile(target, "utf8"), "");
    assert.equal(await fs.readFile(authoritative, "utf8"), "keep");
  });
});

test("unusable paths never throw and expose an in-memory failure status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-failure-"));
  try {
    const blocker = path.join(dir, "blocker");
    await fs.writeFile(blocker, "file", "utf8");
    initDiagnosticJournal({ targetPath: path.join(blocker, "aiden.log"), profile: "production" });
    writeDiagnosticEvent({ level: "error", area: "diagnostics", event: "write-failure" });
    assert.equal(await flushDiagnosticJournal(), true);
    assert.equal(diagnosticJournalStatus().writeFailed, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
