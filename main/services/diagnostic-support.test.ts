import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

import { initDiagnosticJournal, writeDiagnosticEvent, writeDiagnosticEventSync, flushDiagnosticJournal, MAX_DIAGNOSTIC_LOG_BYTES } from "./diagnostic-journal.js";
import { initDiagnosticHealth } from "./diagnostic-health.js";
import {
  flushSubagentRuntimeDiagnostics,
  initSubagentRuntimeDiagnostics,
  writeSubagentRuntimeFailure,
} from "./subagents/subagent-runtime-diagnostics.js";
import {
  createDiagnosticExport,
  deleteAllDiagnosticData,
  diagnosticSupportStatus,
  enableLocalCrashCapture,
  pruneExpiredDiagnosticCrashDumps,
  type DiagnosticExportBundle,
} from "./diagnostic-support.js";

const gunzipAsync = promisify(gunzip);

async function fixture(
  run: (root: string, logs: string, dumps: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-diagnostic-support-"));
  const logs = path.join(root, "logs");
  const dumps = path.join(root, "dumps");
  await fs.mkdir(logs, { recursive: true, mode: 0o700 });
  await fs.mkdir(dumps, { recursive: true, mode: 0o700 });
  initDiagnosticHealth(path.join(logs, "diagnostic-health.json"), false);
  try {
    await run(root, logs, dumps);
  } finally {
    await flushDiagnosticJournal();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function app() {
  return { name: "Aiden Agent", version: "1.2.3", runtimeProfile: "production" as const };
}

test("status reports bounded local evidence without exposing file paths", async () => {
  await fixture(async (_root, logs, dumps) => {
    initDiagnosticJournal({
      targetPath: path.join(logs, "aiden.log"),
      profile: "production",
      sessionId: "session-test",
    });
    writeDiagnosticEvent({ level: "warn", area: "renderer", event: "renderer-unresponsive" });
    await flushDiagnosticJournal();
    const status = await diagnosticSupportStatus({ logsPath: logs, crashDumpsPath: dumps });
    assert.ok(status.retainedBytes > 0);
    assert.equal(status.fileCount, 2);
    assert.match(status.oldestAt ?? "", /^\d{4}-/u);
    assert.equal("path" in status, false);
  });
});

test("status reports corrupt journal and health evidence as a sink failure", async () => {
  await fixture(async (_root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    await fs.writeFile(path.join(logs, "aiden.log"), "not-json\n", { mode: 0o600 });
    await fs.writeFile(path.join(logs, "diagnostic-health.json"), "not-json\n", { mode: 0o600 });
    initDiagnosticHealth(path.join(logs, "diagnostic-health.json"));
    const status = await diagnosticSupportStatus({ logsPath: logs, crashDumpsPath: dumps });
    assert.equal(status.sinkFailed, true);
  });
});

test("export is manifest-first, projects subagent identifiers, and validates its round trip", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({
      targetPath: path.join(logs, "aiden.log"),
      profile: "production",
      sessionId: "session-test",
    });
    writeDiagnosticEvent({
      level: "error",
      area: "providers",
      event: "provider-failed",
      code: "provider-failed",
    });
    await flushDiagnosticJournal();
    initSubagentRuntimeDiagnostics(path.join(logs, "subagent-runtime.log"));
    await fs.writeFile(
      path.join(logs, "subagent-runtime.log"),
      `${JSON.stringify({
        at: "2026-08-27T12:00:00.000Z",
        diagnosticId: "private-diagnostic-id",
        runId: "private-run-id",
        providerId: "private-provider-id",
        modelId: "private-model-id",
        failure: "provider",
        attempts: 2,
        diagnostics: [{ stage: "provider", code: "provider_failure", detail: "private detail" }],
      })}\n`,
      { mode: 0o600 },
    );
    const destination = path.join(root, "export.json.gz");
    const manifest = await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination,
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
      now: () => new Date("2026-08-27T13:00:00.000Z"),
    });
    assert.deepEqual(manifest.included, {
      generalRecords: 2,
      subagentRecords: 1,
      healthDays: 0,
      crashDumps: 0,
    });
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    const bundle = JSON.parse(
      (await gunzipAsync(await fs.readFile(destination))).toString("utf8"),
    ) as DiagnosticExportBundle;
    const text = JSON.stringify(bundle);
    assert.doesNotMatch(
      text,
      /private-diagnostic-id|private-run-id|private-provider-id|private-model-id|private detail/u,
    );
    assert.match(text, /provider_failure/u);
  });
});

test("an export after a long idle period sweeps expired general fatal and subagent records", async () => {
  await fixture(async (root, logs, dumps) => {
    const firstDay = new Date("2026-08-01T00:00:00.000Z");
    const ninthDay = new Date("2026-08-09T00:00:00.001Z");
    const journal = path.join(logs, "aiden.log");
    initDiagnosticJournal({ targetPath: journal, profile: "production", now: () => firstDay });
    writeDiagnosticEvent({
      level: "warn",
      area: "diagnostics",
      event: "retention-check",
      fields: { sequence: 1 },
    });
    writeDiagnosticEventSync({
      level: "fatal",
      area: "app",
      event: "app-failed",
      fields: { sequence: 1 },
    });
    await flushDiagnosticJournal();

    const subagent = path.join(logs, "subagent-runtime.log");
    initSubagentRuntimeDiagnostics(subagent);
    await fs.writeFile(
      subagent,
      `${JSON.stringify({
        at: firstDay.toISOString(),
        diagnosticId: "SA-expired",
        providerId: "custom:test",
        modelId: "test-model",
        failure: "provider",
        attempts: 1,
        diagnostics: [{ stage: "provider", code: "provider_failure" }],
      })}\n`,
      { mode: 0o600 },
    );
    await fs.utimes(subagent, firstDay, firstDay);

    const destination = path.join(root, "idle-export.json.gz");
    const manifest = await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination,
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
      now: () => ninthDay,
    });
    assert.equal(manifest.included.generalRecords, 0);
    assert.equal(manifest.included.subagentRecords, 0);
    const bundle = JSON.parse(
      (await gunzipAsync(await fs.readFile(destination))).toString("utf8"),
    ) as DiagnosticExportBundle;
    assert.doesNotMatch(JSON.stringify(bundle), /SA-expired|"sequence":1/u);
  });
});

test("export snapshots every subagent record accepted before its queue barrier", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    initSubagentRuntimeDiagnostics(path.join(logs, "subagent-runtime.log"));
    for (let index = 0; index < 100; index += 1) {
      writeSubagentRuntimeFailure({
        diagnosticId: `SA-backlog-${index}`,
        providerId: "custom:test",
        modelId: "test-model",
        failure: "provider",
        attempts: 1,
        diagnostics: [{ stage: "provider", code: "provider_failure" }],
      });
    }
    const manifest = await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination: path.join(root, "backlog.json.gz"),
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
    });
    assert.equal(manifest.included.subagentRecords, 100);
  });
});

test("export snapshots every general record accepted before its queue barrier", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    for (let index = 0; index < 500; index += 1) {
      writeDiagnosticEvent({
        level: "warn",
        area: "diagnostics",
        event: "backpressure-fixture",
        fields: { sequence: index },
      });
    }
    const manifest = await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination: path.join(root, "general-backlog.json.gz"),
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
    });
    assert.equal(manifest.included.generalRecords, 501);
  });
});

test("crash dumps require explicit inclusion and remain count and size bounded", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    await fs.writeFile(path.join(dumps, "one.dmp"), Buffer.from("memory image"), { mode: 0o600 });
    const withoutDestination = path.join(root, "without.json.gz");
    const without = await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination: withoutDestination,
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
    });
    assert.equal(without.included.crashDumps, 0);
    const withDestination = path.join(root, "with.json.gz");
    const included = await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination: withDestination,
      includeCrashDumps: true,
      app: app(),
      tempRoot: root,
    });
    assert.equal(included.included.crashDumps, 1);
  });
});

test("startup pruning enforces crash dump age and count without reading dump contents", async () => {
  await fixture(async (_root, _logs, dumps) => {
    const stale = path.join(dumps, "stale.dmp");
    await fs.writeFile(stale, "stale", { mode: 0o600 });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    await fs.utimes(stale, old, old);
    for (let index = 0; index < 5; index += 1) {
      const file = path.join(dumps, `recent-${index}.dmp`);
      await fs.writeFile(file, "dump", { mode: 0o600 });
      const at = new Date(Date.now() - index * 1_000);
      await fs.utimes(file, at, at);
    }
    await fs.writeFile(path.join(dumps, "oversized.dmp"), Buffer.alloc(16 * 1024 * 1024 + 1), {
      mode: 0o644,
    });
    await pruneExpiredDiagnosticCrashDumps(dumps);
    const retained = (await fs.readdir(dumps)).filter((name) => name.endsWith(".dmp"));
    assert.equal(retained.length, 3);
    assert.equal(retained.includes("stale.dmp"), false);
    assert.equal(retained.includes("oversized.dmp"), false);
    for (const name of retained)
      assert.equal((await fs.stat(path.join(dumps, name))).mode & 0o777, 0o600);
  });
});

test("unknown records and symlinked sources fail closed or stay excluded", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    const outside = path.join(root, "outside.jsonl");
    await fs.writeFile(outside, `${JSON.stringify({ secret: "outside" })}\n`, "utf8");
    await fs.symlink(outside, path.join(logs, "aiden.log.1"));
    const destination = path.join(root, "safe.json.gz");
    await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination,
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
    });
    assert.doesNotMatch(
      (await gunzipAsync(await fs.readFile(destination))).toString("utf8"),
      /outside/u,
    );

    await fs.writeFile(
      path.join(logs, "aiden.log"),
      `${JSON.stringify({ unknown: true })}\n`,
      "utf8",
    );
    await assert.rejects(
      createDiagnosticExport({
        logsPath: logs,
        crashDumpsPath: dumps,
        destination: path.join(root, "rejected.json.gz"),
        includeCrashDumps: false,
        app: app(),
        tempRoot: root,
      }),
      /unknown record/u,
    );

    await fs.writeFile(
      path.join(logs, "aiden.log"),
      `${JSON.stringify({
        version: 1,
        sessionId: "session-forged",
        at: new Date().toISOString(),
        level: "error",
        area: "app",
        event: "app-failed",
        fields: { attackerContent: "looks structurally valid" },
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      createDiagnosticExport({
        logsPath: logs,
        crashDumpsPath: dumps,
        destination: path.join(root, "forged-rejected.json.gz"),
        includeCrashDumps: false,
        app: app(),
        tempRoot: root,
      }),
      /unknown record/u,
    );
  });
});

test("subagent export rejects open-string categorical fields", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    const subagent = path.join(logs, "subagent-runtime.log");
    initSubagentRuntimeDiagnostics(subagent);
    await fs.writeFile(
      subagent,
      `${JSON.stringify({
        at: new Date().toISOString(),
        diagnosticId: "SA-forged",
        providerId: "private",
        modelId: "private",
        failure: "plaintext-private-value",
        attempts: 1,
        diagnostics: [],
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      createDiagnosticExport({
        logsPath: logs,
        crashDumpsPath: dumps,
        destination: path.join(root, "forged-subagent.json.gz"),
        includeCrashDumps: false,
        app: app(),
        tempRoot: root,
      }),
      /unknown record/u,
    );
  });
});

test("export atomically replaces a symlink destination without modifying its target", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    const victim = path.join(root, "victim.txt");
    const destination = path.join(root, "export.json.gz");
    await fs.writeFile(victim, "keep", "utf8");
    await fs.symlink(victim, destination);
    await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination,
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
    });
    assert.equal(await fs.readFile(victim, "utf8"), "keep");
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  });
});

test("export atomically replaces a hardlink destination without truncating its peer", async () => {
  await fixture(async (root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    const victim = path.join(root, "victim.txt");
    const destination = path.join(root, "export.json.gz");
    await fs.writeFile(victim, "keep", "utf8");
    await fs.link(victim, destination);
    await createDiagnosticExport({
      logsPath: logs,
      crashDumpsPath: dumps,
      destination,
      includeCrashDumps: false,
      app: app(),
      tempRoot: root,
    });
    assert.equal(await fs.readFile(victim, "utf8"), "keep");
    assert.notEqual((await fs.stat(victim)).ino, (await fs.stat(destination)).ino);
  });
});

test("delete removes only diagnostic allowlist files and dumps", async () => {
  await fixture(async (_root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    const settings = path.join(logs, "settings.json");
    await fs.writeFile(settings, "keep", "utf8");
    initSubagentRuntimeDiagnostics(path.join(logs, "subagent-runtime.log"));
    await fs.writeFile(path.join(logs, "subagent-runtime.log"), "{}\n", "utf8");
    await fs.writeFile(path.join(dumps, "crash.dmp"), "dump", "utf8");
    await deleteAllDiagnosticData({ logsPath: logs, crashDumpsPath: dumps });
    assert.equal(await fs.readFile(settings, "utf8"), "keep");
    await assert.rejects(fs.stat(path.join(logs, "subagent-runtime.log")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(dumps, "crash.dmp")), { code: "ENOENT" });
  });
});

test("delete is ordered after already accepted subagent writes", async () => {
  await fixture(async (_root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    initSubagentRuntimeDiagnostics(path.join(logs, "subagent-runtime.log"));
    for (let index = 0; index < 100; index += 1) {
      writeSubagentRuntimeFailure({
        diagnosticId: `SA-delete-${index}`,
        providerId: "custom:test",
        modelId: "test-model",
        failure: "policy",
        attempts: 1,
        diagnostics: [{ stage: "runtime", code: "unknown" }],
      });
    }
    await deleteAllDiagnosticData({ logsPath: logs, crashDumpsPath: dumps });
    await flushSubagentRuntimeDiagnostics();
    await assert.rejects(fs.stat(path.join(logs, "subagent-runtime.log")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(logs, "subagent-runtime.prev.log")), { code: "ENOENT" });
  });
});

test("concurrent crash pruning and status tolerate disappearing dumps", async () => {
  await fixture(async (_root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    for (let index = 0; index < 8; index += 1) {
      const dump = path.join(dumps, `stale-${index}.dmp`);
      await fs.writeFile(dump, "dump", { mode: 0o600 });
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
      await fs.utimes(dump, old, old);
    }
    await Promise.all([
      ...Array.from({ length: 20 }, () =>
        diagnosticSupportStatus({ logsPath: logs, crashDumpsPath: dumps }),
      ),
      ...Array.from({ length: 10 }, () => pruneExpiredDiagnosticCrashDumps(dumps)),
    ]);
  });
});

test("diagnostic mode is explicit, idempotent, and disables on restart", () => {
  let starts = 0;
  const enabled = enableLocalCrashCapture(() => {
    starts += 1;
  });
  enableLocalCrashCapture(() => {
    starts += 1;
  });
  assert.equal(starts, 1);
  assert.deepEqual(enabled, { enabled: true, expiresAt: null, disablesOnRestart: true });
});


for (const profile of ["production", "development"] as const) {
  test(`support deletion preserves new ${profile} journal records through its final sweep`, async (context) => {
    await fixture(async (_root, logs, dumps) => {
      const target = path.join(logs, profile === "production" ? "aiden.log" : "aiden-dev.log");
      const inactive = path.join(logs, profile === "production" ? "aiden-dev.log" : "aiden.log");
      const fatal = path.join(logs, "aiden-fatal.log");
      const subagent = path.join(logs, "subagent-runtime.log");
      initSubagentRuntimeDiagnostics(subagent);
      initDiagnosticJournal({ targetPath: target, profile });
      writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 1 } });
      writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 1 } });
      await flushDiagnosticJournal();
      const stale = [inactive, `${inactive}.1`, path.join(logs, "aiden-dev.legacy.log"), path.join(dumps, "old.dmp")];
      for (const file of stale) await fs.writeFile(file, "old", { mode: 0o600 });
      const neighbor = path.join(logs, "settings.json");
      await fs.writeFile(neighbor, "keep", { mode: 0o600 });

      // Subagent cleanup follows the journal's barrier but precedes the final
      // allowlist sweep. Hold it while new live journal records are persisted.
      const remove = fsPromises.rm;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const reached = new Promise<void>((resolve) => { started = resolve; });
      const removal = context.mock.method(fsPromises, "rm", async (...args: Parameters<typeof remove>) => {
        if (args[0] === subagent) { started(); await held; }
        return remove(...args);
      });
      syncBuiltinESMExports();
      const deletion = deleteAllDiagnosticData({ logsPath: logs, crashDumpsPath: dumps });
      try {
        await reached;
        writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "retention-check", fields: { sequence: 2 } });
        writeDiagnosticEventSync({ level: "fatal", area: "app", event: "app-failed", fields: { sequence: 2 } });
        await flushDiagnosticJournal();
        const currentBytes = (await fs.stat(target)).size;
        await fs.appendFile(target, " ".repeat(MAX_DIAGNOSTIC_LOG_BYTES - currentBytes - 64));
        writeDiagnosticEvent({ level: "warn", area: "diagnostics", event: "rotation-fixture", fields: { sequence: 3 } });
        await flushDiagnosticJournal();
      } finally {
        release();
        await deletion;
        removal.mock.restore();
        syncBuiltinESMExports();
      }
      assert.match(await fs.readFile(target, "utf8"), /"sequence":3/u);
      assert.match(await fs.readFile(`${target}.1`, "utf8"), /"sequence":2/u);
      assert.match(await fs.readFile(fatal, "utf8"), /"sequence":2/u);
      for (const file of [target, `${target}.1`, fatal]) {
        assert.doesNotMatch(await fs.readFile(file, "utf8"), /"sequence":1/u);
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      }
      for (const file of stale) await assert.rejects(fs.stat(file), { code: "ENOENT" });
      assert.equal(await fs.readFile(neighbor, "utf8"), "keep");
    });
  });
}

test("support deletion still clears journal files when the live journal is disabled", async () => {
  await fixture(async (_root, logs, dumps) => {
    const blocker = path.join(logs, "settings.json");
    await fs.writeFile(blocker, "keep");
    initDiagnosticJournal({ targetPath: path.join(blocker, "aiden.log"), profile: "production" });
    const names = ["aiden.log", "aiden.log.1", "aiden-dev.log", "aiden-dev.log.1", "aiden-fatal.log"];
    for (const name of names) await fs.writeFile(path.join(logs, name), "old");
    await deleteAllDiagnosticData({ logsPath: logs, crashDumpsPath: dumps });
    for (const name of names) await assert.rejects(fs.stat(path.join(logs, name)), { code: "ENOENT" });
    assert.equal(await fs.readFile(blocker, "utf8"), "keep");
  });
});

test("support deletion still reports inactive journal cleanup failures", async (context) => {
  await fixture(async (_root, logs, dumps) => {
    initDiagnosticJournal({ targetPath: path.join(logs, "aiden.log"), profile: "production" });
    await flushDiagnosticJournal();
    const inactive = path.join(logs, "aiden-dev.log");
    const remove = fsPromises.rm;
    const removal = context.mock.method(fsPromises, "rm", async (...args: Parameters<typeof remove>) => {
      if (args[0] === inactive) throw Object.assign(new Error("Synthetic inactive journal removal failure"), { code: "EACCES" });
      return remove(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(deleteAllDiagnosticData({ logsPath: logs, crashDumpsPath: dumps }), { code: "EACCES" });
    } finally {
      removal.mock.restore();
      syncBuiltinESMExports();
    }
  });
});
