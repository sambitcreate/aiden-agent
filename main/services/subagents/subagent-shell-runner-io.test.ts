import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  decodeSubagentShellResponse,
  encodeSubagentShellRequest,
  pinSubagentShellWorkspaceRoot,
  resolveSubagentShellRunnerBinary,
  runSubagentShellProductionInert,
} from "./subagent-shell-runner-io.js";

const digest = "a".repeat(64);
const nonce = "b".repeat(64);
const binary = path.join(process.cwd(), "build", "native", "aiden-subagent-shell-runner-test");

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-shell-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function run(t: test.TestContext, command: string, timeoutMs = 2_000) {
  const root = await pinSubagentShellWorkspaceRoot(await workspace(t));
  return runSubagentShellProductionInert({
    workspaceRoot: root,
    command,
    effectDigest: digest,
    timeoutMs,
    nonce,
    signal: new AbortController().signal,
    binary,
  });
}

test("resolves packaged and development helper locations", () => {
  assert.equal(
    resolveSubagentShellRunnerBinary({
      defaultApp: false,
      resourcesPath: "/Applications/Aiden.app/Contents/Resources",
      cwd: "/workspace",
    }),
    "/Applications/Aiden.app/Contents/Helpers/aiden-subagent-shell-runner",
  );
  assert.equal(
    resolveSubagentShellRunnerBinary({ defaultApp: true, cwd: "/workspace" }),
    "/workspace/build/native/aiden-subagent-shell-runner",
  );
});

test("command exists only in the framed control payload, never helper argv or environment", async () => {
  const secret = "COMMAND_SECRET_47f4";
  const root = { path: "/workspace", device: "1", inode: "2" };
  const child = new EventEmitter() as never as ReturnType<
    typeof import("node:child_process").spawn
  >;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, kill: () => true });
  let args: readonly string[] = [];
  let environment: NodeJS.ProcessEnv | undefined;
  const promise = runSubagentShellProductionInert({
    workspaceRoot: root,
    command: `printf ${secret}`,
    effectDigest: digest,
    timeoutMs: 100,
    nonce,
    signal: new AbortController().signal,
    spawnProcess: ((
      _binary: string,
      capturedArgs: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      args = capturedArgs;
      environment = options.env;
      queueMicrotask(() => child.emit("error", new Error("stop")));
      return child;
    }) as never,
  });
  await assert.rejects(promise, /stop/u);
  assert.doesNotMatch(JSON.stringify(args), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(environment), new RegExp(secret, "u"));
  assert.match(stdin.read()?.toString("utf8") ?? "", new RegExp(secret, "u"));
});

test("protocol rejects hostile commands and response spoofing", () => {
  for (const command of ["", "echo\0bad", "echo\rbad", "echo\u001bbad", "echo\u202ebad"]) {
    assert.throws(
      () => encodeSubagentShellRequest({ command, effectDigest: digest, nonce, timeoutMs: 1 }),
      /invalid/u,
    );
  }
  assert.throws(
    () => decodeSubagentShellResponse(Buffer.alloc(163), { nonce, effectDigest: digest }),
    /malformed/u,
  );
  const spoof = Buffer.alloc(164);
  spoof.write("AIDSR001", 0, "ascii");
  spoof.writeUInt32BE(1, 8);
  spoof.writeUInt32BE(1, 12);
  spoof.writeUInt32BE(1, 24);
  spoof.write("c".repeat(64), 36, "ascii");
  spoof.write(digest, 100, "ascii");
  assert.throws(
    () => decodeSubagentShellResponse(spoof, { nonce, effectDigest: digest }),
    /malformed/u,
  );
});

test("native runner returns zero, nonzero, signal, and no-output outcomes", async (t) => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(await run(t, "printf hello"), {
    outcome: "exited",
    exitCode: 0,
    cleanupConfirmed: true,
    stdout: "hello",
    stderr: "",
  });
  const nonzero = await run(t, "printf bad >&2; exit 7");
  assert.equal(nonzero.outcome, "exited");
  assert.equal(nonzero.exitCode, 7);
  assert.equal(nonzero.stderr, "bad");
  const signaled = await run(t, "kill -TERM $$");
  assert.equal(signaled.outcome, "signaled");
  assert.equal(signaled.signal, 15);
  assert.equal((await run(t, ":")).stdout, "");
  assert.equal((await run(t, "printf '\\377'")).stdout, "�");
});

test("native runner uses a secret-free fixed environment and private 0700 directories", async (t) => {
  if (process.platform !== "darwin") return;
  process.env.AIDEN_PHASE5D_SECRET = "must-not-cross";
  t.after(() => delete process.env.AIDEN_PHASE5D_SECRET);
  const result = await run(
    t,
    'printf \'%s\\n\' "${AIDEN_PHASE5D_SECRET-unset}" "$PATH" "$LANG"; stat -f \'%Lp\' "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME"; test ! -t 0',
  );
  assert.equal(result.outcome, "exited");
  assert.match(result.stdout, /^unset\n\/usr\/bin:\/bin:\/usr\/sbin:\/sbin\nC\n700\n700\n700\n$/u);
  const environment = (await run(t, "env | sort")).stdout;
  for (const forbidden of [
    "AIDEN_",
    "ANTHROPIC_",
    "AWS_",
    "AZURE_",
    "DYLD_",
    "ELECTRON_",
    "GOOGLE_",
    "HTTP_PROXY=",
    "HTTPS_PROXY=",
    "MCP_",
    "NODE_",
    "NPM_TOKEN=",
    "OPENAI_",
    "SSH_AUTH_SOCK=",
  ]) {
    assert.doesNotMatch(environment, new RegExp(`^${forbidden}`, "mu"));
  }
});

test("timeout, cancellation, output floods, and held pipes clean the occupied group", async (t) => {
  if (process.platform !== "darwin") return;
  assert.equal((await run(t, "sleep 30", 30)).outcome, "timed_out");
  assert.equal(
    (await run(t, "/usr/bin/yes x & /usr/bin/yes y >&2 & wait", 2_000)).outcome,
    "output_limit",
  );
  assert.equal((await run(t, "(sleep 30) & printf done", 2_000)).cleanupConfirmed, true);
  assert.equal(
    (await run(t, "(trap '' TERM; while true; do sleep 1; done) & wait", 30)).outcome,
    "timed_out",
  );

  const root = await pinSubagentShellWorkspaceRoot(await workspace(t));
  const controller = new AbortController();
  const pending = runSubagentShellProductionInert({
    workspaceRoot: root,
    command: "sleep 30",
    effectDigest: digest,
    timeoutMs: 10_000,
    nonce,
    signal: controller.signal,
    binary,
  });
  setTimeout(() => controller.abort(), 20);
  assert.equal((await pending).outcome, "cancelled");
});

test("workspace identity drift is rejected before shell execution", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const root = await pinSubagentShellWorkspaceRoot(rootPath);
  root.inode = (BigInt(root.inode) + 1n).toString();
  await assert.rejects(
    runSubagentShellProductionInert({
      workspaceRoot: root,
      command: "printf should-not-run",
      effectDigest: digest,
      timeoutMs: 1_000,
      nonce,
      signal: new AbortController().signal,
      binary,
    }),
    /failed before/u,
  );
  assert.equal((await stat(rootPath)).isDirectory(), true);
});

test("a deliberate setsid double-fork proves the documented containment limit and self-cleans", async (t) => {
  if (process.platform !== "darwin") return;
  const rootPath = await workspace(t);
  const marker = path.join(rootPath, "detached.pid");
  const fixture = path.join(
    process.cwd(),
    "build",
    "native",
    "aiden-subagent-shell-setsid-fixture",
  );
  let pid = 0;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    const deadline = Date.now() + 5_000;
    while (pid <= 1 && Date.now() < deadline) {
      try {
        const candidate = Number.parseInt(await readFile(marker, "utf8"), 10);
        if (candidate > 1) pid = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (pid <= 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (pid <= 1) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    cleaned = true;
  };
  t.after(cleanup);
  try {
    const result = await run(t, `${fixture} ${marker}`);
    assert.equal(result.outcome, "exited");
    const markerDeadline = Date.now() + 20_000;
    while (Date.now() < markerDeadline) {
      try {
        const candidate = Number.parseInt(await readFile(marker, "utf8"), 10);
        if (candidate > 1) {
          pid = candidate;
          break;
        }
      } catch {
        // The intermediate process publishes the marker asynchronously.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(pid > 1, "detached fixture must publish its PID");
    assert.doesNotThrow(() => process.kill(pid, 0));
  } finally {
    await cleanup();
  }
});

for (const failure of ["EPIPE", "EIO", "synchronous"] as const) {
  test(`control-channel ${failure} failure waits for helper close and rejects normally`, async () => {
    const child = new EventEmitter();
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error(`write ${failure}`), { code: failure }));
      },
    });
    if (failure === "synchronous") {
      stdin.write = (() => { throw new Error("synchronous write failure"); }) as typeof stdin.write;
    }
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, kill: () => true });
    let settled = false;
    const pending = runSubagentShellProductionInert({
      workspaceRoot: { path: "/workspace", device: "1", inode: "2" },
      command: "printf should-not-run", effectDigest: digest, nonce,
      timeoutMs: 1_000, signal: new AbortController().signal,
      spawnProcess: (() => child) as never,
    });
    const checked = assert.rejects(pending, /failed before returning a verified outcome/u)
      .finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stdin.destroyed, true);
    assert.equal(settled, false, "write errors must not bypass helper close/cleanup");
    // Even a zero exit cannot turn a failed control write into trusted success.
    child.emit("close", 0, null);
    await checked;
    assert.equal(stdout.destroyed, true);
    assert.equal(stderr.destroyed, true);
  });
}

test("a failed control write keeps the watchdog until helper close", async () => {
  const child = new EventEmitter();
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: string[] = [];
  Object.assign(child, {
    stdin, stdout, stderr,
    kill: (signal: string) => {
      kills.push(signal);
      child.emit("close", null, "SIGKILL");
      return true;
    },
  });
  await assert.rejects(runSubagentShellProductionInert({
    workspaceRoot: { path: "/workspace", device: "1", inode: "2" },
    command: "printf should-not-run", effectDigest: digest, nonce,
    timeoutMs: 1, signal: new AbortController().signal,
    spawnProcess: (() => child) as never,
  }), /failed before returning a verified outcome/u);
  assert.deepEqual(kills, ["SIGKILL"]);
  assert.equal(stdin.destroyed, true);
  assert.equal(stdout.destroyed, true);
  assert.equal(stderr.destroyed, true);
});

for (const settlement of ["success", "callback-error", "stream-error", "watchdog"] as const) {
  test(`helper close waits for the control-write callback (${settlement})`, async () => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let finishWrite: ((error?: Error | null) => void) | undefined;
    stdin.write = ((_request: Uint8Array, callback: (error?: Error | null) => void) => {
      finishWrite = callback;
      return true;
    }) as typeof stdin.write;
    Object.assign(child, { stdin, stdout, stderr, kill: () => true });
    const pending = runSubagentShellProductionInert({
      workspaceRoot: { path: "/workspace", device: "1", inode: "2" },
      command: "printf done", effectDigest: digest, nonce,
      timeoutMs: 1, signal: new AbortController().signal,
      spawnProcess: (() => child) as never,
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const response = Buffer.alloc(164);
    response.write("AIDSR001", 0, "ascii");
    response.writeUInt32BE(1, 8);
    response.writeUInt32BE(1, 12);
    response.writeUInt32BE(1, 24);
    response.write(nonce, 36, "ascii");
    response.write(digest, 100, "ascii");
    stdout.write(response);
    child.emit("close", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a valid response cannot precede write settlement");
    assert.ok(finishWrite);
    const error = Object.assign(new Error("late EPIPE"), { code: "EPIPE" });
    if (settlement === "callback-error") finishWrite(error);
    else if (settlement === "stream-error") stdin.emit("error", error);
    else if (settlement === "success") finishWrite(null);
    // The watchdog case deliberately never settles the callback.
    if (settlement === "success") assert.equal((await pending).outcome, "exited");
    else await assert.rejects(pending, /failed before returning a verified outcome/u);
    assert.equal(stdin.destroyed, true);
    assert.equal(stdout.destroyed, true);
    assert.equal(stderr.destroyed, true);
  });
}
