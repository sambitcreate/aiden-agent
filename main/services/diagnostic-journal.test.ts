import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
  snapshotDiagnosticJournalFiles,
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

test("legacy logging safely classifies cancellation and ignores hostile proxy errors", async () => {
  for (const profile of ["production", "development"] as const) await withJournal(profile, async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.doesNotThrow(() => writeLegacyDiagnostic("error", "pi", [revoked.proxy]));
    const inheritsProxy = Object.create(revoked.proxy);
    assert.doesNotThrow(() => writeLegacyDiagnostic("error", "pi", [inheritsProxy]));
    assert.doesNotThrow(() => writeLegacyDiagnostic("error", "pi", [{
      toJSON() { throw new Error("private"); },
      toString() { throw new Error("private"); },
    }]));
    const event = writeLegacyDiagnostic("error", "pi", [new DOMException("private", "AbortError")]);
    assert.equal(event.code, "cancelled");
    assert.equal(event.outcome, "cancelled");
    assert.equal(writeLegacyDiagnostic("warn", "pi", [{ status: 503 }]).code, undefined);
    assert.equal(writeLegacyDiagnostic("warn", "pi", [{ name: "AbortError" }]).code, undefined);
  });
});

test("production legacy adapter retains structural SDK causes without serializing envelopes", async () => {
  await withJournal("production", async (target) => {
    const event = writeLegacyDiagnostic("warn", "mcp", [
      "Skipping private server", { cause: { code: "ECONNREFUSED", status: 503 },
        message: "private-prompt", headers: { authorization: "private-auth" }, url: "https://private-endpoint", task: "private-task" },
    ]);
    assert.equal(event.event, "mcp-degraded");
    assert.equal(event.code, "network-failed");
    assert.equal(event.fields?.causeCode, "network-failed");
    assert.equal(event.fields?.httpStatus, 503);
    await flushDiagnosticJournal();
    assert.doesNotMatch(await fs.readFile(target, "utf8"), /private-/);
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withHeldDeletion(
  context: test.TestContext,
  target: string,
  run: () => Promise<void>,
): Promise<void> {
  const remove = fsPromises.rm;
  const started = deferred();
  const held = deferred();
  const removeMock = context.mock.method(fsPromises, "rm", async (...args: Parameters<typeof remove>) => {
    if (args[0] === target) {
      started.resolve();
      await held.promise;
    }
    return remove(...args);
  });
  syncBuiltinESMExports();
  const deletion = deleteDiagnosticJournalFiles();
  // Production flush deadlines are unref'd; keep blocked synthetic I/O alive.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await started.promise;
    await run();
  } finally {
    held.resolve();
    await deletion;
    await flushDiagnosticJournal();
    clearInterval(keepAlive);
    removeMock.mock.restore();
    syncBuiltinESMExports();
  }
}

test("flush waits for an in-flight journal deletion", async (context) => {
  await withJournal("production", async (target) => {
    await flushDiagnosticJournal();
    await withHeldDeletion(context, target, async () => {
      assert.equal(await flushDiagnosticJournal(0), false);
    });
    assert.equal(await flushDiagnosticJournal(), true);
  });
});

test("journal deletion preserves later accepted writes even when they would rotate old logs", async (context) => {
  await withJournal("production", async (target) => {
    await flushDiagnosticJournal();
    const currentBytes = (await fs.stat(target)).size;
    await fs.appendFile(target, "x".repeat(MAX_DIAGNOSTIC_LOG_BYTES - currentBytes - 64));
    await withHeldDeletion(context, target, async () => {
      writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "rotation-fixture", fields: { sequence: 27 } });
      // A broken queue can drain the new append while removal is held, erasing it
      // when deletion resumes. A correct queue remains blocked behind deletion.
      await flushDiagnosticJournal(100);
    });
    assert.match(await fs.readFile(target, "utf8"), /"sequence":27/u);
    assert.doesNotMatch(await fs.readFile(target, "utf8"), /session-started|xxx/u);
    for (let index = 1; index < MAX_DIAGNOSTIC_LOG_FILES; index += 1) {
      await assert.rejects(fs.stat(`${target}.${index}`), { code: "ENOENT" });
    }
    assert.equal(diagnosticJournalStatus().pendingWrites, 0);
    assert.equal(diagnosticJournalStatus().writeFailed, false);
  });
});

test("snapshots admitted during journal deletion exclude deleted records", async (context) => {
  await withJournal("production", async (target, dir) => {
    await flushDiagnosticJournal();
    let snapshot: Promise<string[]> | undefined;
    await withHeldDeletion(context, target, async () => {
      snapshot = snapshotDiagnosticJournalFiles(path.join(dir, "snapshot"));
      await Promise.race([snapshot, new Promise((resolve) => setTimeout(resolve, 100))]);
    });
    assert.ok(snapshot);
    const files = await snapshot;
    for (const file of files) assert.equal(await fs.readFile(file, "utf8"), "");
  });
});

test("deletion preserves synchronous fatal records accepted after its request", async () => {
  await withJournal("production", async (_target, dir) => {
    await flushDiagnosticJournal();
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
    const deletion = deleteDiagnosticJournalFiles();
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    await deletion;
    const contents = await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8");
    assert.doesNotMatch(contents, /"sequence":1/u);
    assert.match(contents, /"sequence":2/u);
  });
});

test("failed journal deletion rejects, reports failure, and leaves the queue usable", async (context) => {
  await withJournal("production", async (target) => {
    await flushDiagnosticJournal();
    const remove = fsPromises.rm;
    const removeMock = context.mock.method(fsPromises, "rm", async (...args: Parameters<typeof remove>) => {
      if (args[0] === target) throw Object.assign(new Error("Synthetic removal failure"), { code: "EACCES" });
      return remove(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(deleteDiagnosticJournalFiles(), { code: "EACCES" });
      assert.equal(diagnosticJournalStatus().writeFailed, true);
    } finally {
      removeMock.mock.restore();
      syncBuiltinESMExports();
    }
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 27 } });
    await flushDiagnosticJournal();
    assert.match(await fs.readFile(target, "utf8"), /"sequence":27/u);
    await deleteDiagnosticJournalFiles();
    assert.equal(await fs.readFile(target, "utf8"), "");
  });
});


test("successive journal deletions retain only writes admitted after the last request", async () => {
  await withJournal("production", async (target, dir) => {
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 1 } });
    const first = deleteDiagnosticJournalFiles();
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 2 } });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    const second = deleteDiagnosticJournalFiles();
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 3 } });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 3 } });
    await Promise.all([first, second, flushDiagnosticJournal()]);
    for (const file of [target, path.join(dir, "aiden-fatal.log")]) {
      const contents = await fs.readFile(file, "utf8");
      assert.match(contents, /"sequence":3/u);
      assert.doesNotMatch(contents, /"sequence":[12]|session-started/u);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
  });
});

test("fatal deletion failure is reported without poisoning later journal operations", async () => {
  await withJournal("production", async (target, dir) => {
    await flushDiagnosticJournal();
    const fatal = path.join(dir, "aiden-fatal.log");
    await fs.rm(fatal);
    await fs.mkdir(fatal);
    await assert.rejects(deleteDiagnosticJournalFiles());
    assert.equal(diagnosticJournalStatus().writeFailed, true);
    await fs.rmdir(fatal);
    await deleteDiagnosticJournalFiles();
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 27 } });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 27 } });
    await flushDiagnosticJournal();
    for (const file of [target, fatal]) assert.match(await fs.readFile(file, "utf8"), /"sequence":27/u);
  });
});

test("a pre-deletion snapshot retains its fatal evidence across a later fatal reset", async (context) => {
  await withJournal("production", async (_target, dir) => {
    await flushDiagnosticJournal();
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
    const destination = path.join(dir, "before-delete");
    const mkdir = fsPromises.mkdir;
    const started = deferred();
    const held = deferred();
    const mkdirMock = context.mock.method(fsPromises, "mkdir", async (...args: Parameters<typeof mkdir>) => {
      if (args[0] === destination) { started.resolve(); await held.promise; }
      return mkdir(...args);
    });
    syncBuiltinESMExports();
    const snapshot = snapshotDiagnosticJournalFiles(destination);
    let deletion: Promise<void> | undefined;
    try {
      await started.promise;
      deletion = deleteDiagnosticJournalFiles();
      writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    } finally {
      held.resolve();
      await snapshot;
      await deletion;
      mkdirMock.mock.restore();
      syncBuiltinESMExports();
    }
    const before = await fs.readFile(path.join(destination, "aiden-fatal.log"), "utf8");
    assert.match(before, /"sequence":1/u);
    assert.doesNotMatch(before, /"sequence":2/u);
    const live = await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8");
    assert.match(live, /"sequence":2/u);
    assert.doesNotMatch(live, /"sequence":1/u);
    const after = path.join(dir, "after-delete");
    await snapshotDiagnosticJournalFiles(after);
    assert.equal(await fs.readFile(path.join(after, "aiden-fatal.log"), "utf8"), live);
  });
});

test("fatal retention finishes before queued general maintenance can cross a deletion", async (context) => {
  await withJournal("production", async (target, dir) => {
    await flushDiagnosticJournal();
    let current = new Date("2026-08-01T00:00:00.000Z");
    initDiagnosticJournal({ targetPath: target, profile: "production", now: () => current });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
    await flushDiagnosticJournal();
    current = new Date(current.getTime() + MAX_DIAGNOSTIC_LOG_AGE_MS + 1_000);
    const stat = fsPromises.lstat;
    const started = deferred();
    const held = deferred();
    const statMock = context.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof stat>) => {
      if (args[0] === target) { started.resolve(); await held.promise; }
      return stat(...args);
    });
    syncBuiltinESMExports();
    const sweep = pruneDiagnosticJournalRetention(current);
    let deletion: Promise<void> | undefined;
    try {
      await started.promise;
      assert.equal(await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8"), "");
      deletion = deleteDiagnosticJournalFiles();
      writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    } finally {
      held.resolve();
      await sweep;
      await deletion;
      statMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.match(await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8"), /"sequence":2/u);
  });
});

test("snapshot admission precedes an immediately requested journal deletion", async () => {
  await withJournal("production", async (target, dir) => {
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 1 } });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
    const destination = path.join(dir, "snapshot");
    const snapshot = snapshotDiagnosticJournalFiles(destination);
    const deletion = deleteDiagnosticJournalFiles();
    writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 2 } });
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    await Promise.all([snapshot, deletion, flushDiagnosticJournal()]);
    for (const file of [path.basename(target), "aiden-fatal.log"]) {
      const before = await fs.readFile(path.join(destination, file), "utf8");
      assert.match(before, /"sequence":1/u);
      assert.doesNotMatch(before, /"sequence":2/u);
      const live = await fs.readFile(path.join(dir, file), "utf8");
      assert.match(live, /"sequence":2/u);
      assert.doesNotMatch(live, /"sequence":1/u);
    }
  });
});

test("a fatal snapshot publication failure preserves its destination and releases the queue", async () => {
  await withJournal("production", async (_target, dir) => {
    const destination = path.join(dir, "snapshot");
    await fs.mkdir(destination);
    const occupied = path.join(destination, "aiden-fatal.log");
    await fs.writeFile(occupied, "keep");
    await assert.rejects(snapshotDiagnosticJournalFiles(destination), { code: "EEXIST" });
    assert.equal(await fs.readFile(occupied, "utf8"), "keep");
    assert.equal(diagnosticJournalStatus().writeFailed, true);
    await deleteDiagnosticJournalFiles();
    writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
    const next = path.join(dir, "next-snapshot");
    await snapshotDiagnosticJournalFiles(next);
    assert.match(await fs.readFile(path.join(next, "aiden-fatal.log"), "utf8"), /"sequence":2/u);
  });
});
