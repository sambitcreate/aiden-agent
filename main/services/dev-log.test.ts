import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import test from "node:test";
import {
  devLogPath,
  flushDevLog,
  initDevLog,
  redactDevLogSecrets,
  writeDevLog,
  writeDevLogSync,
} from "./dev-log.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-dev-log-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("writeDevLog is a no-op before initDevLog", async () => {
  // Module state persists across tests in this file, so this must run first.
  // Before any init in this test, a fresh module would no-op; here we only
  // assert it never throws.
  writeDevLog("info", "scope", ["hello"]);
  await flushDevLog();
});

test("initDevLog creates a versioned JSONL journal and writes structured legacy events", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "nested", "aiden-dev.log");
    initDevLog(target);
    assert.equal(devLogPath(), target);
    writeDevLog("info", "main", ["hello", 42]);
    writeDevLog("error", "renderer", [new Error("boom")]);
    writeDevLog("warn", "main", [{ a: 1 }]);
    await flushDevLog();

    const records = (await fs.readFile(target, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records[0]?.event, "session-started");
    assert.ok(records.every((record) => record.version === 1));
    assert.ok(records.some((record) => record.level === "info" && record.area === "app"));
    assert.ok(records.some((record) => record.level === "error" && record.area === "renderer"));
    assert.ok(records.some((record) => record.level === "warn" && record.area === "app"));
    assert.doesNotMatch(JSON.stringify(records), /boom/u);
  });
});

test("long lines are truncated to the cap", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "aiden-dev.log");
    initDevLog(target);
    writeDevLog("info", "main", ["x".repeat(10_000)]);
    await flushDevLog();
    const lines = (await fs.readFile(target, "utf8")).trim().split("\n");
    const data = lines.find((l) => l.includes("xxx"));
    assert.ok(data);
    assert.ok(data.length <= 4096);
  });
});

test("fatal diagnostics are appended synchronously", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "aiden-dev.log");
    initDevLog(target);
    writeDevLogSync("error", "process", ["fatal", new Error("boom")]);

    const record = JSON.parse((await fs.readFile(path.join(dir, "aiden-fatal.log"), "utf8")).trim()) as {
      level: string;
      fields: Record<string, unknown>;
    };
    assert.equal(record.level, "error");
    assert.equal(record.fields.legacyScope, "process");
    assert.equal(record.fields.errorType, "Error");
    assert.match(String(record.fields.fingerprint), /^[0-9a-f]{16}$/u);
    assert.doesNotMatch(JSON.stringify(record), /boom/u);
  });
});

test("credentials are redacted before they reach disk", () => {
  const redacted = redactDevLogSecrets(
    'Authorization: Bearer live-token access_token="oauth-token" client_secret=secret api_key: sk-abcdefghijklmnop',
  );
  for (const credential of [
    "live-token",
    "oauth-token",
    "=secret",
    "sk-abcdefghijklmnop",
  ]) {
    assert.equal(redacted.includes(credential), false);
  }
  assert.match(redacted, /REDACTED/u);
});

test("an oversized existing log is discarded before a bounded session starts", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "aiden-dev.log");
    const legacyStructured = `${JSON.stringify({ version: 1, at: "2026-08-27T12:00:00.000Z" })}\n`;
    await fs.writeFile(target, legacyStructured.repeat(Math.ceil((3 * 1024 * 1024) / legacyStructured.length)), "utf8");
    initDevLog(target);
    writeDevLog("info", "main", ["fresh"]);
    await flushDevLog();

    await assert.rejects(fs.stat(path.join(dir, "aiden-dev.log.1")), { code: "ENOENT" });
    const current = await fs.readFile(target, "utf8");
    assert.match(current, /fresh/);
    assert.ok(current.length < 1024);
  });
});

test("logging never throws, even when the path is unusable", async () => {
  await withTempDir(async (dir) => {
    const blocker = path.join(dir, "blocker");
    await fs.writeFile(blocker, "file", "utf8");
    initDevLog(path.join(blocker, "aiden-dev.log")); // parent is a file
    writeDevLog("info", "main", ["ignored"]);
    await flushDevLog(); // must resolve without rejecting
  });
});
