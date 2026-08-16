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

test("initDevLog creates the file with a session header and writes formatted lines", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "nested", "aiden-dev.log");
    initDevLog(target);
    assert.equal(devLogPath(), target);
    writeDevLog("info", "main", ["hello", 42]);
    writeDevLog("error", "renderer", [new Error("boom")]);
    writeDevLog("warn", "main", [{ a: 1 }]);
    await flushDevLog();

    const text = await fs.readFile(target, "utf8");
    assert.match(text, /── session .+ ──/);
    assert.match(text, /INFO {2}\[main\] hello 42\n/);
    assert.match(text, /ERROR \[renderer\] Error: boom/);
    assert.match(text, /WARN {2}\[main\] \{"a":1\}\n/);
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

    const text = await fs.readFile(target, "utf8");
    assert.match(text, /ERROR \[process\] fatal Error: boom/u);
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
  assert.match(redacted, /Bearer \[REDACTED\]/);
});

test("an oversized existing log is rotated aside on init", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "aiden-dev.log");
    await fs.writeFile(target, "y".repeat(3 * 1024 * 1024), "utf8");
    initDevLog(target);
    writeDevLog("info", "main", ["fresh"]);
    await flushDevLog();

    const prev = await fs.readFile(path.join(dir, "aiden-dev.prev.log"), "utf8");
    assert.equal(prev.length, 3 * 1024 * 1024);
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
