// Behavioral oracles for the `aiden serve` process (cli-native C03, C04): real
// daemon processes, their control socket and the artifacts they leave behind.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as api from "../dist/parity-test-api.js";

const cli = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist", "app", "cli.js");
const posix = { skip: process.platform === "win32" };

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "aiden-serve-life-"));
  const home = join(root, "home"),
    agentDir = join(root, "agent");
  mkdirSync(home);
  mkdirSync(agentDir, { mode: 0o700 });
  const box = {
    agentDir,
    socket: api.daemonSocket(agentDir),
    lock: join(agentDir, "serve.lock"),
    env: { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
  };
  // Hooks run in order, so the daemon has to stop here, while its directory still exists.
  t.after(() => {
    if (box.stopServer) run(["serve", "stop"], box.env);
    rmSync(root, { recursive: true, force: true });
  });
  return box;
}

const run = (args, env) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000, env });

/** A foreground server with Remote off, resolved once its control socket answers. */
async function foreground(t, box) {
  const child = spawn(process.execPath, [cli, "serve", "--no-remote"], {
    env: box.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part) => {
    stderr += part;
  });
  const exited = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  const deadline = Date.now() + 30_000;
  while (!stderr.includes("listening at")) {
    if (child.exitCode !== null) throw new Error(`serve exited early:\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`serve did not become ready:\n${stderr}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return { child, exited, stderr: () => stderr };
}

/** Sends raw bytes and returns everything the daemon answered before it closed. */
function exchange(socketPath, ...writes) {
  return new Promise((resolveReply, rejectReply) => {
    const socket = createConnection(socketPath);
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      for (const write of writes) socket.write(write);
    });
    socket.on("data", (part) => {
      reply += part;
    });
    socket.on("close", () => resolveReply(reply));
    socket.on("error", rejectReply);
  });
}

test("a stop that arrives during startup ends it there", posix, async (t) => {
  const box = sandbox(t);
  const previous = { agentDir: process.env.AIDEN_CODING_AGENT_DIR, home: process.env.HOME };
  process.env.AIDEN_CODING_AGENT_DIR = box.agentDir;
  process.env.HOME = box.env.HOME;
  const controller = new AbortController(),
    { listen } = Server.prototype;
  // The socket is being bound, so scheduler and Telegram startup are still ahead.
  Server.prototype.listen = function (...args) {
    controller.abort();
    return listen.apply(this, args);
  };
  t.after(() => {
    Server.prototype.listen = listen;
    process.env.AIDEN_CODING_AGENT_DIR = previous.agentDir;
    process.env.HOME = previous.home;
  });
  let ready = false;
  await api.serve(box.agentDir, controller.signal, {
    remote: false,
    onReady: () => {
      ready = true;
    },
  });
  assert.equal(ready, false, "a cancelled startup never reports ready");
  assert.equal(existsSync(box.socket), false);
  assert.equal(existsSync(box.lock), false);
});

test("a stop in the last step of startup still never reports ready", posix, async (t) => {
  const box = sandbox(t);
  const previous = { agentDir: process.env.AIDEN_CODING_AGENT_DIR, home: process.env.HOME };
  process.env.AIDEN_CODING_AGENT_DIR = box.agentDir;
  process.env.HOME = box.env.HOME;
  const controller = new AbortController(),
    { write } = process.stderr;
  // These lines are written once every service has started, just before ready.
  process.stderr.write = function (chunk, ...rest) {
    if (String(chunk).includes("listening at")) controller.abort();
    return write.call(this, chunk, ...rest);
  };
  t.after(() => {
    process.stderr.write = write;
    process.env.AIDEN_CODING_AGENT_DIR = previous.agentDir;
    process.env.HOME = previous.home;
  });
  let ready = false;
  await api.serve(box.agentDir, controller.signal, {
    remote: false,
    onReady: () => {
      ready = true;
    },
  });
  assert.equal(ready, false);
  assert.equal(existsSync(box.lock), false);
});

test(
  "a stopped server leaves nothing behind and a new one takes over at once",
  posix,
  async (t) => {
    const box = sandbox(t);
    box.stopServer = true;
    assert.equal(run(["serve", "--daemon", "--no-remote"], box.env).status, 0);
    const first = JSON.parse(readFileSync(join(box.lock, "owner.json"), "utf8"));
    const stopped = run(["serve", "stop"], box.env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(box.lock), false);
    assert.equal(existsSync(box.socket), false);
    const again = run(["serve", "--daemon", "--no-remote"], box.env);
    assert.equal(again.status, 0, again.stderr);
    const second = JSON.parse(readFileSync(join(box.lock, "owner.json"), "utf8"));
    assert.notEqual(second.pid, first.pid);
    assert.notEqual(second.token, first.token);
  },
);

test(
  "a second server is refused while the first holds the lease, and the first is unharmed",
  posix,
  async (t) => {
    const box = sandbox(t);
    const server = await foreground(t, box);
    const second = run(["serve", "--no-remote"], box.env);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Another Aiden process owns/u);
    assert.equal(
      JSON.parse(
        await exchange(box.socket, `${JSON.stringify({ command: "serve", args: ["status"] })}\n`),
      ).result.remote.on,
      false,
    );
    server.child.kill("SIGTERM");
    assert.deepEqual(await server.exited, { code: 0, signal: null }, server.stderr());
  },
);

test("a failed startup releases its lease and the next start succeeds", posix, async (t) => {
  const box = sandbox(t);
  // A directory at the socket path cannot be cleared, so startup fails after the lease is taken.
  mkdirSync(join(box.socket, "occupied"), { recursive: true });
  const failed = run(["serve", "--no-remote"], box.env);
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(box.lock), false, "the lease went with the failed start");
  rmSync(box.socket, { recursive: true, force: true });
  const server = await foreground(t, box);
  server.child.kill("SIGTERM");
  assert.deepEqual(await server.exited, { code: 0, signal: null }, server.stderr());
});

test("an idle or half-sent control client does not hold up shutdown", posix, async (t) => {
  const box = sandbox(t);
  const server = await foreground(t, box);
  const idle = createConnection(box.socket),
    partial = createConnection(box.socket);
  idle.on("error", () => {});
  partial.on("error", () => {});
  await new Promise((resolveWait) => partial.once("connect", resolveWait));
  partial.write('{"command":"serve"');
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  server.child.kill("SIGTERM");
  assert.deepEqual(await server.exited, { code: 0, signal: null }, server.stderr());
  assert.equal(existsSync(box.socket), false);
  assert.equal(existsSync(box.lock), false);
  idle.destroy();
  partial.destroy();
});

test(
  "the control socket answers one framed request per connection and refuses malformed ones",
  posix,
  async (t) => {
    const box = sandbox(t);
    await foreground(t, box);
    const status = `${JSON.stringify({ command: "serve", args: ["status"] })}\n`;
    // A request may arrive in pieces; only its newline frames it.
    assert.deepEqual(JSON.parse(await exchange(box.socket, status.slice(0, 5), status.slice(5))), {
      result: { remote: { on: false } },
    });
    // Anything after the first frame is ignored, however the bytes were split.
    assert.deepEqual(JSON.parse(await exchange(box.socket, status + status)), {
      result: { remote: { on: false } },
    });
    assert.match(await exchange(box.socket, "not json\n"), /"error"/u);
    assert.match(
      await exchange(box.socket, `${JSON.stringify({ command: "shell", args: [] })}\n`),
      /Invalid daemon command/u,
    );
    assert.match(
      await exchange(box.socket, `${JSON.stringify({ command: "serve", args: [1] })}\n`),
      /Invalid daemon command/u,
    );
    assert.match(
      await exchange(box.socket, `${JSON.stringify({ command: "remote", args: ["status"] })}\n`),
      /Remote is off/u,
    );
    // The ceiling is on the frame, so bytes after a request that fits cannot push it over.
    const full = `${JSON.stringify({ command: "serve", args: ["status"], padding: "x".repeat(65_000) })}\n`;
    const fits = await new Promise((resolveReply, rejectReply) => {
      const socket = createConnection(box.socket);
      let reply = "";
      socket
        .setEncoding("utf8")
        .on("data", (part) => {
          reply += part;
        })
        .on("close", () => resolveReply(reply))
        .on("error", rejectReply);
      socket.on("connect", () => {
        socket.write(full.slice(0, 60_000));
        setTimeout(() => socket.write(`${full.slice(60_000)}${"y".repeat(10_000)}`), 100);
      });
    });
    assert.deepEqual(JSON.parse(fits), { result: { remote: { on: false } } });
    // A request with no newline inside the byte ceiling is cut off, with no reply.
    assert.equal(await exchange(box.socket, "x".repeat(70_000)), "");
    assert.deepEqual(
      JSON.parse(await exchange(box.socket, status)),
      { result: { remote: { on: false } } },
      "the server is still healthy",
    );
  },
);

test("the running daemon answers hook commands over its control socket", posix, async (t) => {
  const box = sandbox(t),
    controller = new AbortController(),
    ready = Promise.withResolvers();
  const serving = api.serve(box.agentDir, controller.signal, { onReady: ready.resolve });
  void serving.catch(ready.reject);
  await ready.promise;
  t.after(async () => {
    controller.abort();
    await serving;
  });
  mkdirSync(join(box.agentDir, ".aiden"));
  writeFileSync(
    join(box.agentDir, ".aiden", "hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
  );
  await api.remoteDaemonCommand(box.agentDir, "workspace", ["add", box.agentDir]);
  const listed = await api.remoteDaemonCommand(box.agentDir, "hooks", ["list"]);
  assert.equal(listed.hooks.length, 1);
  assert.equal(listed.hooks[0].status, "waiting-for-approval");
  const approved = await api.hooksAdminCommand(
    box.agentDir,
    ["approve", listed.hooks[0].id, listed.hooks[0].digest],
    { isInteractive: () => true },
  );
  assert.equal(approved.status, "active");
  await assert.rejects(
    api.remoteDaemonCommand(box.agentDir, "hooks", ["nonsense"]),
    /usage|Usage/u,
  );
});

test("shutdown keeps the lease until a running control command has answered", posix, async (t) => {
  const box = sandbox(t),
    controller = new AbortController(),
    ready = Promise.withResolvers();
  const serving = api.serve(box.agentDir, controller.signal, { onReady: ready.resolve });
  void serving.catch(ready.reject);
  await ready.promise;
  const workspace = await api.remoteDaemonCommand(box.agentDir, "workspace", ["add", box.agentDir]);
  // Workspace changes look at the chat index first, which gives the test a place to hold one.
  const { stat } = fsPromises,
    reached = Promise.withResolvers(),
    held = Promise.withResolvers();
  fsPromises.stat = async (...args) => {
    if (String(args[0]).endsWith("index.json")) {
      reached.resolve();
      await held.promise;
    }
    return stat(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.stat = stat;
    syncBuiltinESMExports();
  });
  const answer = api.remoteDaemonCommand(box.agentDir, "workspace", [
    "access",
    workspace.id,
    "none",
  ]);
  await reached.promise;
  controller.abort();
  let released = false;
  void serving.then(() => {
    released = true;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  assert.equal(released, false, "the command is still changing state");
  assert.equal(existsSync(box.lock), true);
  held.resolve();
  assert.equal((await answer).access, "none", "the client hears how its command ended");
  await serving;
  assert.equal(existsSync(box.lock), false);
  assert.equal(existsSync(box.socket), false);
});

test("shutdown delivers the whole reply to a client that reads it slowly", posix, async (t) => {
  const box = sandbox(t),
    controller = new AbortController(),
    ready = Promise.withResolvers();
  const serving = api.serve(box.agentDir, controller.signal, { onReady: ready.resolve });
  void serving.catch(ready.reject);
  t.after(() => {
    controller.abort();
    return serving.catch(() => {});
  });
  await ready.promise;
  const workspace = await api.remoteDaemonCommand(box.agentDir, "workspace", ["add", box.agentDir]);
  const input = join(box.agentDir, "input.json");
  writeFileSync(
    input,
    JSON.stringify({
      name: "Large",
      mode: "llm",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "Review",
      permission: "read-only",
      enabled: false,
      workspaceId: workspace.id,
    }),
  );
  await api.remoteDaemonCommand(box.agentDir, "schedule", ["save", input]);
  // Far more than a socket buffers, so the reply cannot finish until the client reads.
  const file = join(box.agentDir, "schedules.json"),
    [task] = JSON.parse(readFileSync(file, "utf8"));
  api.atomicJson(file, [{ ...task, prompt: "x".repeat(4 * 1024 * 1024) }]);
  const client = createConnection(box.socket);
  client.pause();
  client.write(`${JSON.stringify({ command: "schedule", args: ["list"] })}\n`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  controller.abort();
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const chunks = [],
    closed = new Promise((resolveClose) => client.once("close", resolveClose));
  client.on("data", (part) => chunks.push(part)).on("error", () => {});
  client.resume();
  await closed;
  const { result } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(result[0].prompt.length, 4 * 1024 * 1024);
  await serving;
  assert.equal(existsSync(box.lock), false);
});

test("serve phases only move forward and draining waits for every accepted command", async () => {
  const lifetime = new api.ServeLifetime();
  assert.equal(lifetime.acceptsCommands, true, "commands are answered while services start");
  lifetime.markServing();
  assert.equal(lifetime.phase, "serving");
  const first = Promise.withResolvers(),
    second = Promise.withResolvers();
  lifetime.track(first.promise);
  lifetime.track(second.promise);
  lifetime.beginDrain();
  assert.equal(lifetime.acceptsCommands, false);
  lifetime.markServing();
  assert.equal(lifetime.phase, "draining", "a late ready report cannot reopen the socket");
  let settled = false;
  const settling = lifetime.settleCommands().then(() => {
    settled = true;
  });
  first.reject(new Error("answered already"));
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.equal(settled, false);
  second.resolve();
  await settling;
  assert.equal(settled, true);
});

test(
  "a daemon PID that stops being ours before the stop deadline is never killed or blamed",
  posix,
  async (t) => {
    const box = sandbox(t),
      script = join(box.agentDir, "becomes-foreign.sh");
    // Ignores TERM like a stuck daemon, then its PID stops being a daemon at all.
    writeFileSync(script, "trap '' TERM\nsleep 0.5\nexec sleep 30\n");
    const child = spawn("/bin/sh", [script, "serve"], { stdio: "ignore" });
    t.after(() => {
      child.kill("SIGKILL");
    });
    mkdirSync(box.lock, { mode: 0o700 });
    writeFileSync(
      join(box.lock, "owner.json"),
      JSON.stringify({
        pid: child.pid,
        argv: ["/bin/sh", script, "serve"],
        startedAt: 1,
        token: "legacy",
      }),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.deepEqual(await api.stopDaemon(box.agentDir, 1_000), { stopped: true, pid: child.pid });
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null, "the unrelated process was left alone");
    assert.equal(existsSync(box.lock), false, "its stale lease is gone");
  },
);

test(
  "a stop that cannot confirm its owner at the deadline signals nothing and advises no kill",
  posix,
  async (t) => {
    const box = sandbox(t),
      script = join(box.agentDir, "becomes-command.sh"),
      entry = join(box.agentDir, "entry.js");
    writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    // Ignores TERM like a stuck daemon, then its PID shows another Aiden command.
    writeFileSync(
      script,
      `trap '' TERM\nsleep 0.5\nexec "${process.execPath}" "${entry}" schedule\n`,
    );
    const previous = process.env.AIDEN_CLI_ENTRY;
    process.env.AIDEN_CLI_ENTRY = entry;
    const child = spawn("/bin/sh", [script, "serve"], { stdio: "ignore" });
    t.after(() => {
      child.kill("SIGKILL");
      if (previous === undefined) delete process.env.AIDEN_CLI_ENTRY;
      else process.env.AIDEN_CLI_ENTRY = previous;
    });
    mkdirSync(box.lock, { mode: 0o700 });
    writeFileSync(
      join(box.lock, "owner.json"),
      JSON.stringify({
        pid: child.pid,
        argv: ["/bin/sh", script, "serve"],
        startedAt: 1,
        token: "legacy",
      }),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    await assert.rejects(api.stopDaemon(box.agentDir, 1_000), (error) => {
      assert.match(error.message, /could not confirm/iu);
      assert.doesNotMatch(error.message, /kill/u);
      return true;
    });
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null, "the process was left alone");
    assert.equal(existsSync(box.lock), true, "its lease is not ours to clear");
  },
);

test("stop signals only a verified daemon, at the start and at the deadline", () => {
  assert.equal(api.decideServeStopStart("daemon"), "signal");
  for (const owner of ["gone", "foreign"])
    assert.equal(api.decideServeStopStart(owner), "clear_stale");
  assert.equal(api.decideServeStopStart("aiden"), "refuse_aiden");
  assert.equal(api.decideServeStopStart("unknown"), "refuse_unverified");
  assert.equal(api.decideServeStopDeadline("daemon", true), "force");
  assert.equal(
    api.decideServeStopDeadline("daemon", false),
    "stopped",
    "a replacement daemon is not the one asked to stop",
  );
  for (const owner of ["gone", "foreign"])
    assert.equal(api.decideServeStopDeadline(owner, true), "clear_stale");
  for (const owner of ["aiden", "unknown"])
    assert.equal(api.decideServeStopDeadline(owner, true), "unconfirmed");
});

test("two daemon starts cannot both spawn", posix, async (t) => {
  const box = sandbox(t);
  box.stopServer = true;
  const release = api.acquireLease(join(box.agentDir, "serve-start"));
  const refused = run(["serve", "--daemon", "--no-remote"], box.env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Another daemon start is already in progress/u);
  release();
  assert.equal(existsSync(box.lock), false, "the refused start spawned nothing");
  assert.equal(run(["serve", "--daemon", "--no-remote"], box.env).status, 0);
  const again = run(["serve", "--daemon", "--no-remote"], box.env);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already running/u);
});

/** A fake daemon that answers every connection with the given bytes. */
async function fakeDaemon(t, answer) {
  const box = sandbox(t);
  const server = createServer((socket) => {
    socket.on("data", () => answer(socket));
    socket.on("error", () => {});
  });
  await new Promise((resolveListen) => server.listen(box.socket, resolveListen));
  t.after(
    () =>
      new Promise((resolveClose) => {
        server.close(resolveClose);
      }),
  );
  return box.agentDir;
}

test("the command client settles once for every way a daemon can answer", posix, async (t) => {
  assert.deepEqual(
    await api.remoteDaemonCommand(
      await fakeDaemon(t, (socket) => socket.end('{"result":{"ok":true}}\n')),
      "serve",
      ["status"],
    ),
    { ok: true },
  );
  await assert.rejects(
    api.remoteDaemonCommand(
      await fakeDaemon(t, (socket) => socket.end('{"error":"Refused."}\n')),
      "serve",
      ["status"],
    ),
    /Refused\./u,
  );
  await assert.rejects(
    api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end()), "serve", ["status"]),
    /closed without a response/u,
  );
  await assert.rejects(
    api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end('{"partial"')), "serve", [
      "status",
    ]),
    /closed without a response/u,
  );
  await assert.rejects(
    api.remoteDaemonCommand(await fakeDaemon(t, (socket) => socket.end("not json\n")), "serve", [
      "status",
    ]),
    SyntaxError,
  );
  await assert.rejects(
    api.remoteDaemonCommand(
      await fakeDaemon(t, (socket) => {
        socket.write("x".repeat(9 * 1024 * 1024));
      }),
      "serve",
      ["status"],
    ),
    /too large/u,
  );
  // The ceiling holds even when the chunk that crosses it also completes the frame.
  const oversized = JSON.stringify({ result: "x".repeat(8 * 1024 * 1024 - 8) });
  const crossing = await fakeDaemon(t, (socket) => {
    socket.write(oversized.slice(0, -16));
    setTimeout(() => socket.end(`${oversized.slice(-16)}\n`), 100);
  });
  await assert.rejects(api.remoteDaemonCommand(crossing, "serve", ["status"]), /too large/u);
  // The ceiling is on the frame, so bytes after a reply that fits cannot push it over.
  const fits = "x".repeat(8 * 1024 * 1024 - 64),
    framed = JSON.stringify({ result: fits });
  const padded = await fakeDaemon(t, (socket) => {
    socket.write(framed.slice(0, -16));
    setTimeout(() => socket.end(`${framed.slice(-16)}\n${"y".repeat(1024)}`), 100);
  });
  assert.equal((await api.remoteDaemonCommand(padded, "serve", ["status"])).length, fits.length);
  // Once the first frame settles the command, a peer that keeps writing is cut off.
  const peer = sandbox(t),
    peerClosed = Promise.withResolvers();
  let accepted;
  const talkative = createServer({ allowHalfOpen: true }, (socket) => {
    accepted = socket;
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write('{"result":"ok"}\n');
      const flood = setInterval(() => socket.write("y".repeat(1024)), 5);
      socket.once("close", () => {
        clearInterval(flood);
        peerClosed.resolve("closed");
      });
    });
  });
  await new Promise((resolveListen) => talkative.listen(peer.socket, resolveListen));
  // A failed assertion must not leave cleanup waiting on a peer that is still writing.
  t.after(
    () =>
      new Promise((resolveClose) => {
        accepted?.destroy();
        talkative.close(resolveClose);
      }),
  );
  assert.equal(await api.remoteDaemonCommand(peer.agentDir, "serve", ["status"]), "ok");
  const timedOut = new Promise((resolveWait) =>
    setTimeout(resolveWait, 1_000, "still connected").unref(),
  );
  assert.equal(await Promise.race([peerClosed.promise, timedOut]), "closed");
  // The reply is its first frame: bytes after the newline do not turn it into an error.
  const trailing = await fakeDaemon(t, (socket) => {
    socket.end(`${JSON.stringify({ result: "ok" })}\nleftover`);
  });
  assert.equal(await api.remoteDaemonCommand(trailing, "serve", ["status"]), "ok");
  const missing = sandbox(t);
  await assert.rejects(
    api.remoteDaemonCommand(missing.agentDir, "serve", ["status"]),
    (error) => error.code === "ENOENT" && /not running/u.test(error.message),
  );
});

test("selectDaemonMcpGroups requires incarnation proof for leaderless groups and refuses stale PGID reuse", () => {
  const daemonPid = 500;
  const processes = [
    { pid: daemonPid, ppid: 400, pgid: 400, uid: 1000, zombie: false, startId: "proc:50" },
    // Direct child wrapper still alive.
    { pid: 601, ppid: daemonPid, pgid: 601, uid: 1000, zombie: false, startId: "proc:100" },
    // Orphaned grandchild whose wrapper (602) exited and was reaped; matches recorded survivor incarnation.
    { pid: 612, ppid: 1, pgid: 602, uid: 1000, zombie: false, startId: "proc:110" },
    // Orphaned survivor (622) turned zombie while its child (623) still runs in group 620.
    { pid: 622, ppid: 1, pgid: 620, uid: 1000, zombie: true, startId: "proc:115" },
    { pid: 623, ppid: 622, pgid: 620, uid: 1000, zombie: false, startId: "proc:116" },
    // Recycled leader PID (603) now owned by an unrelated parent (777) with a child in group 603.
    { pid: 603, ppid: 777, pgid: 603, uid: 1000, zombie: false, startId: "proc:120" },
    { pid: 613, ppid: 603, pgid: 603, uid: 1000, zombie: false, startId: "proc:121" },
    // Leaderless group with only a zombie left (even with matching startId).
    { pid: 614, ppid: 1, pgid: 604, uid: 1000, zombie: true, startId: "proc:130" },
    // Leaderless group whose live member belongs to another user.
    { pid: 615, ppid: 1, pgid: 605, uid: 2000, zombie: false, startId: "proc:140" },
    // Stale bare PGID (606) with no survivor incarnation proof, reused by an unrelated same-UID wrapper that exited.
    { pid: 616, ppid: 1, pgid: 606, uid: 1000, zombie: false, startId: "proc:200" },
    // Stale PGID (607) whose original survivor (617) exited; unrelated same-UID wrapper reused PGID 607 and left 717.
    { pid: 717, ppid: 1, pgid: 607, uid: 1000, zombie: false, startId: "proc:210" },
    // Stale PGID (608) where both PGID 608 and survivor PID 618 were reused with a newer startId.
    { pid: 618, ppid: 1, pgid: 608, uid: 1000, zombie: false, startId: "proc:220" },
    // Leaderless group (609) whose live member has no observable startId (must fail closed).
    { pid: 619, ppid: 1, pgid: 609, uid: 1000, zombie: false },
    // Direct child whose leaderStartId mismatches the recorded leader incarnation.
    { pid: 610, ppid: daemonPid, pgid: 610, uid: 1000, zombie: false, startId: "proc:230" },
    // Unrelated process sharing the foreground daemon's shell process group (400).
    { pid: 401, ppid: 400, pgid: 400, uid: 1000, zombie: false, startId: "proc:40" },
  ];
  assert.deepEqual(
    api.selectDaemonMcpGroups(
      daemonPid,
      [
        { pgid: 601, leaderStartId: "proc:100", survivors: [] },
        { pgid: 602, leaderStartId: "proc:105", survivors: [{ pid: 612, startId: "proc:110" }] },
        { pgid: 620, leaderStartId: "proc:114", survivors: [{ pid: 622, startId: "proc:115" }] },
        { pgid: 603, leaderStartId: "proc:90", survivors: [{ pid: 613, startId: "proc:91" }] },
        { pgid: 604, leaderStartId: "proc:129", survivors: [{ pid: 614, startId: "proc:130" }] },
        { pgid: 605, leaderStartId: "proc:139", survivors: [{ pid: 615, startId: "proc:140" }] },
        606,
        { pgid: 607, leaderStartId: "proc:95", survivors: [{ pid: 617, startId: "proc:100" }] },
        { pgid: 608, leaderStartId: "proc:96", survivors: [{ pid: 618, startId: "proc:100" }] },
        { pgid: 609, leaderStartId: "proc:97", survivors: [{ pid: 619, startId: "proc:100" }] },
        { pgid: 610, leaderStartId: "proc:98", survivors: [] },
        400,
        daemonPid,
        699,
      ],
      processes,
    ),
    [601, 602, 620],
  );
});

test(
  "serve stop force-stops an orphaned MCP grandchild survivor after its wrapper exited",
  posix,
  async (t) => {
    const box = sandbox(t);
    const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const wrapper = join(box.agentDir, "mcp-wrapper.mjs");
    const stuck = join(box.agentDir, "stuck-serve-orphan-mcp.mjs");
    const pidsFile = join(box.agentDir, "pids.json");
    const grandchildFile = join(box.agentDir, "grandchild.json");
    mkdirSync(box.lock, { mode: 0o700, recursive: true });
    // Wrapper spawns a stubborn grandchild in the same process group, then exits immediately.
    writeFileSync(
      wrapper,
      `import { spawn } from "node:child_process"; import { renameSync, writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1e9);"], { stdio: ["ignore", "inherit", "inherit"] });
writeFileSync(${JSON.stringify(grandchildFile + ".tmp")}, JSON.stringify({ wrapper: process.pid, grandchild: child.pid }));
renameSync(${JSON.stringify(grandchildFile + ".tmp")}, ${JSON.stringify(grandchildFile)});
process.exit(0);`,
    );
    writeFileSync(
      stuck,
      `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as api from ${JSON.stringify(join(pkg, "dist/parity-test-api.js"))};
process.on("SIGTERM", () => {});
api.recordServeMcpGroups(${JSON.stringify(box.agentDir)});
const transport = api.createMcpStdioTransport({ command: process.execPath, args: [${JSON.stringify(wrapper)}], stderr: "pipe" });
await transport.start();
const deadline = Date.now() + 10_000;
while (!existsSync(${JSON.stringify(grandchildFile)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
const info = JSON.parse(readFileSync(${JSON.stringify(grandchildFile)}, "utf8"));
writeFileSync(${JSON.stringify(pidsFile + ".tmp")}, JSON.stringify({ ...info, group: transport.pid }));
renameSync(${JSON.stringify(pidsFile + ".tmp")}, ${JSON.stringify(pidsFile)});
setInterval(() => {}, 1e9);`,
    );
    const daemon = spawn(process.execPath, [stuck, "serve"], { stdio: "ignore", detached: true });
    let started;
    t.after(() => {
      for (const pid of [daemon.pid, started?.group, started?.grandchild]) {
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    });
    const ready = Date.now() + 10_000;
    while (!existsSync(pidsFile) && Date.now() < ready) await new Promise((r) => setTimeout(r, 25));
    assert.equal(existsSync(pidsFile), true, "stuck daemon failed to start wrapper fixture");
    started = JSON.parse(readFileSync(pidsFile, "utf8"));
    // Wait for the wrapper leader to finish exiting and be reaped by the daemon,
    // leaving only the orphaned grandchild alive in the recorded MCP group.
    const isRunning = (pid) => {
      if (!api.pidAlive(pid)) return false;
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      return (
        state.status === 0 && state.stdout.trim() !== "" && !state.stdout.trim().startsWith("Z")
      );
    };
    const waitExit = Date.now() + 5_000;
    while (api.pidAlive(started.wrapper) && Date.now() < waitExit)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      api.pidAlive(started.wrapper),
      false,
      "wrapper leader should have exited and been reaped",
    );
    assert.equal(
      isRunning(started.grandchild),
      true,
      "grandchild survivor should still be running",
    );
    const mcpGroupsFile = join(box.lock, "mcp-groups.json");
    const hasRecordedSurvivor = () => {
      if (!existsSync(mcpGroupsFile)) return false;
      try {
        const recorded = JSON.parse(readFileSync(mcpGroupsFile, "utf8"));
        return (
          Array.isArray(recorded.groupRecords) &&
          recorded.groupRecords.some(
            (record) =>
              record?.pgid === started.group &&
              Array.isArray(record.survivors) &&
              record.survivors.some((survivor) => survivor?.pid === started.grandchild),
          )
        );
      } catch {
        return false;
      }
    };
    const waitRecorded = Date.now() + 5_000;
    while (!hasRecordedSurvivor() && Date.now() < waitRecorded)
      await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      hasRecordedSurvivor(),
      true,
      "daemon should record orphaned MCP grandchild survivor before force-stop",
    );
    api.atomicJson(join(box.lock, "owner.json"), {
      detached: true,
      pid: daemon.pid,
      argv: [process.execPath, stuck, "serve"],
      startedAt: Date.now(),
      token: "orphan-test",
    });
    writeFileSync(box.socket, "");
    assert.deepEqual(await api.stopDaemon(box.agentDir, 1_000), {
      stopped: true,
      pid: daemon.pid,
      forced: true,
    });
    const stopDeadline = Date.now() + 5_000;
    while ((isRunning(daemon.pid) || isRunning(started.grandchild)) && Date.now() < stopDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(isRunning(daemon.pid), false, "daemon must be stopped");
    assert.equal(
      isRunning(started.grandchild),
      false,
      "orphaned MCP grandchild survivor must be stopped",
    );
    assert.equal(existsSync(box.lock), false);
  },
);

test(
  "serve stop fails closed and spares unrelated same-UID leaderless groups matching a stale mcp-groups record",
  posix,
  async (t) => {
    const box = sandbox(t);
    const unrelatedWrapper = join(box.agentDir, "unrelated-wrapper.mjs");
    const stuckDaemon = join(box.agentDir, "stuck-serve-stale-pgid.mjs");
    const daemonReadyFile = join(box.agentDir, "stuck-daemon.ready");
    mkdirSync(box.lock, { mode: 0o700, recursive: true });
    writeFileSync(
      unrelatedWrapper,
      `import { spawn } from "node:child_process"; import { renameSync, writeFileSync } from "node:fs";
const outFile = process.argv[2];
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9);"], { stdio: "ignore" });
writeFileSync(outFile + ".tmp", JSON.stringify({ wrapper: process.pid, child: child.pid }));
renameSync(outFile + ".tmp", outFile);
process.exit(0);`,
    );
    writeFileSync(
      stuckDaemon,
      `import { renameSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(daemonReadyFile + ".tmp")}, "ready");
renameSync(${JSON.stringify(daemonReadyFile + ".tmp")}, ${JSON.stringify(daemonReadyFile)});
setInterval(() => {}, 1e9);`,
    );

    const spawnUnrelatedLeaderlessGroup = async (label) => {
      const outFile = join(box.agentDir, `${label}.json`);
      const wrapper = spawn(process.execPath, [unrelatedWrapper, outFile], {
        stdio: "ignore",
        detached: true,
      });
      const exited = new Promise((resolveExit) => wrapper.once("exit", resolveExit));
      const deadline = Date.now() + 10_000;
      while (!existsSync(outFile) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 25));
      assert.equal(existsSync(outFile), true, `unrelated wrapper ${label} did not report child`);
      await exited;
      return JSON.parse(readFileSync(outFile, "utf8"));
    };

    const isRunning = (pid) => {
      if (!api.pidAlive(pid)) return false;
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      return (
        state.status === 0 && state.stdout.trim() !== "" && !state.stdout.trim().startsWith("Z")
      );
    };

    const groupA = await spawnUnrelatedLeaderlessGroup("stale-incarnation");
    const groupB = await spawnUnrelatedLeaderlessGroup("stale-unproven");
    const daemon = spawn(process.execPath, [stuckDaemon, "serve"], {
      stdio: "ignore",
      detached: true,
    });
    t.after(() => {
      for (const pid of [daemon.pid, groupA.wrapper, groupA.child, groupB.wrapper, groupB.child]) {
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    });

    const daemonReadyDeadline = Date.now() + 10_000;
    while (!existsSync(daemonReadyFile) && Date.now() < daemonReadyDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(
      existsSync(daemonReadyFile),
      true,
      "stuck daemon failed to install SIGTERM handler in time",
    );
    assert.equal(isRunning(daemon.pid), true, "stuck daemon should be running");

    const waitReaped = Date.now() + 5_000;
    while (
      (api.pidAlive(groupA.wrapper) || api.pidAlive(groupB.wrapper)) &&
      Date.now() < waitReaped
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(
      api.pidAlive(groupA.wrapper),
      false,
      "unrelated wrapper A should have exited and been reaped",
    );
    assert.equal(
      api.pidAlive(groupB.wrapper),
      false,
      "unrelated wrapper B should have exited and been reaped",
    );
    assert.equal(isRunning(groupA.child), true, "unrelated leaderless child A should be running");
    assert.equal(isRunning(groupB.child), true, "unrelated leaderless child B should be running");

    const token = "stale-pgid-reuse-test";
    api.atomicJson(join(box.lock, "owner.json"), {
      detached: true,
      pid: daemon.pid,
      argv: [process.execPath, stuckDaemon, "serve"],
      startedAt: Date.now(),
      token,
    });
    // Simulate a stale mcp-groups.json left behind after earlier groups emptied and
    // their PGIDs were reused by unrelated same-UID wrappers that exited:
    // - groupA has a mismatched survivor startId (even with the same child PID),
    // - groupB has no survivor incarnation proof at all.
    api.atomicJson(join(box.lock, "mcp-groups.json"), {
      pid: daemon.pid,
      token,
      groups: [groupA.wrapper, groupB.wrapper],
      groupRecords: [
        {
          pgid: groupA.wrapper,
          leaderStartId: "proc:1",
          survivors: [{ pid: groupA.child, startId: "proc:1" }],
        },
        {
          pgid: groupB.wrapper,
          leaderStartId: "proc:2",
          survivors: [],
        },
      ],
    });
    writeFileSync(box.socket, "");

    assert.deepEqual(await api.stopDaemon(box.agentDir, 1_000), {
      stopped: true,
      pid: daemon.pid,
      forced: true,
    });
    const stopDeadline = Date.now() + 5_000;
    while (isRunning(daemon.pid) && Date.now() < stopDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(isRunning(daemon.pid), false, "daemon must be stopped");
    assert.equal(
      isRunning(groupA.child),
      true,
      "unrelated same-UID leaderless group with stale startId must be spared",
    );
    assert.equal(
      isRunning(groupB.child),
      true,
      "unrelated same-UID leaderless group without survivor proof must be spared",
    );
    assert.equal(existsSync(box.lock), false);
  },
);
