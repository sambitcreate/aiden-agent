// Connect running server… against real processes: the real socket reader
// (lsof on macOS, /proc on Linux), real `ps`, and the fake dev server in
// tests/fixtures/design-app-server. The fake-reader tests in
// app-attach.test.ts are the oracle for the rules; this file proves the
// darwin and Linux readers give them what they need. It never contacts a
// server: everything is read from the process and socket tables.
//
// The servers are started by a shell that exits at once, so they're no
// descendants of this test process (whose tree the scan treats as Aiden's).
// Each carries a marker argument, and every one is killed in `after`.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_JOB_MARKER } from "../../follow-through/background-jobs.js";
import { defaultSocketReaderDeps, jobProcessTree, portHolders, processTable, readJobSockets } from "../../follow-through/listening-ports.js";
import { checkAttach, findRebind, rebindHolder, recheckAttached, scanRunningServers, type AttachScanDeps } from "./app-attach.js";
import { defaultOsPort } from "./app-ports.js";

const skip = process.platform === "win32" || typeof process.getuid !== "function" ? "attaching reads Unix process tables" : false;
const SERVER = fileURLToPath(new URL("../../../../tests/fixtures/design-app-server/server.mjs", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function eventually<T>(read: () => Promise<T | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function deps(overrides: Partial<AttachScanDeps> = {}): AttachScanDeps {
  return {
    reader: defaultSocketReaderDeps(),
    uid: process.getuid!(),
    self: process.pid,
    realpath: (target) => realpath(target),
    lstat: (target) => lstat(target),
    excludedPorts: () => new Set(),
    ownedPids: () => new Set(),
    terminalShellPids: () => [],
    ...overrides,
  };
}

const shellQuote = (value: string) => `'${value.split("'").join(`'\\''`)}'`;

async function harness(t: test.TestContext) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "aiden-attach-")));
  const workspace = path.join(base, "workspace");
  const web = path.join(workspace, "apps", "web");
  const outside = path.join(base, "outside");
  await mkdir(web, { recursive: true });
  await mkdir(outside, { recursive: true });
  const marker = `--aiden-attach-test=${path.basename(base)}`;
  const direct: number[] = [];
  t.after(async () => {
    for (const pid of direct) if (alive(pid)) process.kill(pid, "SIGKILL");
    try {
      // The pattern is the marker without its dashes, so pkill doesn't read it as an option.
      execFileSync("pkill", ["-KILL", "-f", marker.slice(2)], { stdio: "ignore" });
    } catch {
      // No process left to kill.
    }
    await rm(base, { recursive: true, force: true });
  });

  /** A server whose parent (a shell) exits at once, so it isn't this process's descendant. Resolves to its pid. */
  const startOrphan = async (cwd: string, args: readonly string[]): Promise<number> => {
    const line = [process.execPath, SERVER, ...args, marker].map(shellQuote).join(" ");
    const shell = spawn("/bin/sh", ["-c", `${line} >/dev/null 2>&1 & echo $!`], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    shell.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((resolve) => shell.once("close", resolve));
    const pid = Number(out.trim());
    assert.ok(Number.isInteger(pid) && pid > 1, `a pid from the shell: ${out}`);
    return pid;
  };
  /** A server started by this process: part of the test runner's own tree. */
  const startChild = (cwd: string, args: readonly string[]): number => {
    const child = spawn(process.execPath, [SERVER, ...args, marker], { cwd, stdio: "ignore" });
    direct.push(child.pid!);
    return child.pid!;
  };
  const scan = () => scanRunningServers({ workspacePath: workspace, roots: ["apps/web"], busyRoots: new Set() }, deps());
  const listed = (port: number) =>
    eventually(async () => {
      const result = await scan();
      return result.ok ? result.servers.find((server) => server.port === port) : undefined;
    }, `port ${port} to be listed`);
  return { workspace, web, outside, startOrphan, startChild, scan, listed };
}

test("a server started from apps/web on 127.0.0.1 is listed under apps/web with its real process name", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  const server = await h.listed(port);
  assert.equal(server.pid, pid);
  assert.equal(server.appRoot, "apps/web");
  assert.equal(server.folder, "apps/web");
  assert.equal(server.connectable, true);
  assert.equal(server.origin, `http://127.0.0.1:${port}`);
  assert.match(server.processName, /node/iu);
});

test("the same server started from outside the workspace isn't listed", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.outside, ["--host", "127.0.0.1", "--port", String(port)]);
  // Wait until it really listens, by the check that reads the socket table for this port.
  await eventually(
    async () => (await checkAttach({ workspacePath: h.outside, appRoot: ".", port }, deps())).ok,
    "the outside server to listen",
  );
  assert.ok(alive(pid));
  const result = await h.scan();
  assert.ok(result.ok);
  assert.equal(result.servers.some((server) => server.port === port), false);
  const check = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps());
  assert.deepEqual(check, { ok: false, problem: "attach-not-in-app" });
});

test("a server on 0.0.0.0 is listed as not connectable", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  await h.startOrphan(h.web, ["--host", "0.0.0.0", "--port", String(port)]);
  const server = await h.listed(port);
  assert.equal(server.connectable, false);
  assert.equal(server.why, "beyond-loopback");
  assert.equal(server.origin, undefined);
  assert.deepEqual(await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps()), {
    ok: false,
    problem: "attach-not-loopback",
  });
});

test("a server whose child binds 0.0.0.0 is listed as not connectable", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port), "--fake-child-wildcard"]);
  const server = await eventually(async () => {
    const result = await h.scan();
    const found = result.ok ? result.servers.find((candidate) => candidate.port === port) : undefined;
    // The child starts after the parent listens; wait until its socket shows.
    return found && !found.connectable ? found : undefined;
  }, "the child's wildcard to show");
  assert.equal(server.why, "beyond-loopback");
});

test("checkAttach passes for the loopback server and gives the 127.0.0.1 origin", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  const check = await eventually(async () => {
    const result = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port, pid }, deps());
    return result.ok ? result : undefined;
  }, "the check to pass");
  assert.equal(check.pid, pid);
  assert.equal(check.origin, `http://127.0.0.1:${port}`);
  assert.deepEqual(check.held, ["127.0.0.1"]);
  assert.equal(check.folder, "apps/web");
  // Bound to the pid: another pid for the same port is refused.
  assert.deepEqual(await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port, pid: pid + 100_000 }, deps()), {
    ok: false,
    problem: "attach-not-in-app",
  });
});

test("the test runner's own process tree is never listed", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  h.startChild(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  // It listens, as the same scan with another `self` shows.
  await eventually(async () => {
    const result = await scanRunningServers({ workspacePath: h.workspace, roots: ["apps/web"], busyRoots: new Set() }, deps({ self: 1 }));
    return result.ok && result.servers.some((server) => server.port === port);
  }, "the child to listen");
  const result = await h.scan();
  assert.ok(result.ok);
  assert.equal(result.servers.some((server) => server.port === port), false);
  assert.deepEqual(await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps()), {
    ok: false,
    problem: "attach-not-in-app",
  });
});

test("after the server exits, readJobSockets with its root pid shows no sockets", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const pid = await h.startOrphan(h.web, ["--host", "127.0.0.1", "--port", String(port)]);
  await h.listed(port);
  const before = (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["attach:web", pid]]))).get("attach:web");
  assert.ok(before?.ok);
  assert.ok(before.sockets.some((socket) => socket.port === port && socket.pid === pid));
  process.kill(pid, "SIGKILL");
  await eventually(async () => !alive(pid), "the server to exit");
  const after = (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["attach:web", pid]]))).get("attach:web");
  assert.ok(after?.ok);
  assert.deepEqual(after.sockets, []);
  assert.deepEqual(after.rows ?? [], []);
});

test("with --respawn-child, killing the child leaves a new child under the same parent holding the port, which the re-bind rule accepts", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const parent = await h.startOrphan(h.web, ["--respawn-child", "--host", "127.0.0.1", "--port", String(port)]);
  const first = await eventually(async () => {
    const result = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, deps());
    return result.ok ? result : undefined;
  }, "the first child to listen");
  assert.notEqual(first.pid, parent, "the child holds the port, not the parent");
  assert.equal(first.ppid, parent);
  process.kill(first.pid, "SIGKILL");
  // Read the old parent's subtree the way the watch does, then apply the pure rule.
  const found = await eventually(async () => {
    const read = (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["parent", parent]]))).get("parent");
    if (!read?.ok || !read.rows) return undefined;
    const socketsOf = (pid: number) => read.sockets.filter((socket) => socket.pid === pid);
    const next = rebindHolder(read.rows, socketsOf, { ppid: parent, uid: process.getuid!(), port, held: first.held });
    const ident = read.rows.find((row) => row.pid === next?.pid)?.ident;
    return next && next.pid !== first.pid && ident ? { ...next, ident } : undefined;
  }, "a new child to hold the port");
  assert.equal(found.ppid, parent);
  assert.ok(alive(found.pid));
  // The identity (start time to the second, plus the command name) can match a child respawned within the same second, so the watch keys on the PID as well. The new holder is a different PID.
  assert.notEqual(found.pid, first.pid, "another process");
  // The async helper over a fresh table agrees, binds the identity the watch's look shows, and reads the new holder's folder: it's in apps/web.
  const where = { workspacePath: h.workspace, appRoot: "apps/web" };
  assert.deepEqual(await findRebind({ ppid: parent, port, held: first.held, ...where }, deps()), { ok: true, ...found });
  // For another app root of the same workspace, the same holder is outside it.
  await mkdir(path.join(h.workspace, "apps", "admin"), { recursive: true });
  assert.deepEqual(await findRebind({ ppid: parent, port, held: first.held, workspacePath: h.workspace, appRoot: "apps/admin" }, deps()), {
    ok: false,
    problem: "attach-not-in-app",
  });
  // Under launchd or init there's no re-bind.
  assert.equal(await findRebind({ ppid: 1, port, held: first.held, ...where }, deps()), undefined);
});

test("a server that a background job started and that left the job's tree with setsid is neither listed nor attachable", { skip }, async (t) => {
  const h = await harness(t);
  const port = await defaultOsPort();
  const marker = `--aiden-attach-test=${path.basename(path.dirname(h.workspace))}`;
  // The job's leader: a shell carrying the job marker, as BackgroundJobs starts one. A node it runs starts the
  // server in its own session and exits, so the server is re-parented out of the job's process tree.
  const launcher = `require("node:child_process").spawn(process.execPath, ${JSON.stringify([SERVER, "--host", "127.0.0.1", "--port", String(port), marker])}, { detached: true, stdio: "ignore" }).unref()`;
  const leader = spawn("/bin/sh", ["-c", `${shellQuote(process.execPath)} -e ${shellQuote(launcher)}; exec sleep 60`], {
    cwd: h.web,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [BACKGROUND_JOB_MARKER]: "job_0badc0de" },
  });
  t.after(() => {
    if (leader.pid && alive(leader.pid)) process.kill(leader.pid, "SIGKILL");
  });
  const jobDeps = deps({ ownedPids: (rows) => new Set(jobProcessTree(rows, leader.pid!)) });
  const reader = defaultSocketReaderDeps();
  const escapee = await eventually(async () => {
    const holders = await portHolders(port, process.getuid!(), reader);
    return holders.ok ? holders.pids[0] : undefined;
  }, "the escapee to listen");
  const table = await processTable(reader);
  assert.ok(table.ok);
  assert.equal(jobProcessTree(table.rows, leader.pid!).includes(escapee), false, "it left the job's tree");
  const result = await scanRunningServers({ workspacePath: h.workspace, roots: ["apps/web"], busyRoots: new Set() }, jobDeps);
  assert.ok(result.ok);
  assert.equal(result.servers.some((server) => server.port === port), false);
  assert.deepEqual(await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port }, jobDeps), { ok: false, problem: "attach-not-in-app" });
});

/**
 * A Python that can keep a listening socket open across an exec. Not one in
 * /usr/bin on macOS: Apple's platform binaries don't show their environment to
 * `ps -E`, so the attach check refuses them (as-built #26).
 */
const PYTHON = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((folder) => folder && !(process.platform === "darwin" && folder === "/usr/bin"))
  .map((folder) => path.join(folder, "python3"))
  .find((candidate) => existsSync(candidate));
/**
 * Listens on 127.0.0.1:<port>, then, once <trigger> exists, execs /bin/sleep in
 * place: the same pid, still holding the socket, now another program.
 */
const EXEC_IN_PLACE = [
  "import os, socket, sys, time",
  "port, trigger = int(sys.argv[1]), sys.argv[2]",
  "s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
  "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
  's.bind(("127.0.0.1", port))',
  "s.listen(8)",
  "s.set_inheritable(True)",
  "while not os.path.exists(trigger): time.sleep(0.05)",
  'os.execv("/bin/sleep", ["sleep", "60"])',
].join("\n");

test(
  "a holder that execs in place keeps its pid and its socket but not its identity, so the watch's look shows it lost",
  { skip: skip || (PYTHON ? false : "needs a python3 to exec in place with the socket kept") },
  async (t) => {
    const h = await harness(t);
    const port = await defaultOsPort();
    const trigger = path.join(h.outside, "exec-now");
    const marker = `--aiden-attach-test=${path.basename(path.dirname(h.workspace))}`;
    const line = [PYTHON!, "-c", EXEC_IN_PLACE, String(port), trigger, marker].map(shellQuote).join(" ");
    // Its shell exits at once, so the holder is no descendant of the test runner (whose tree is Aiden's).
    const shell = spawn("/bin/sh", ["-c", `${line} >/dev/null 2>&1 & echo $!`], { cwd: h.web, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    shell.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((resolve) => shell.once("close", resolve));
    const pid = Number(out.trim());
    assert.ok(Number.isInteger(pid) && pid > 1, `a pid from the shell: ${out}`);
    // After the exec its command line no longer carries the marker, so it's killed by pid.
    t.after(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    const attached = await eventually(async () => {
      const result = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port, pid }, deps());
      return result.ok ? result : undefined;
    }, "the holder to listen and pass the check");
    const look = async () => (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["attach:web", pid]]))).get("attach:web");
    const before = await look();
    assert.ok(before?.ok);
    assert.equal(before.rows?.find((row) => row.pid === pid)?.ident, attached.ident, "the watch's look sees the checked process while it runs");
    await writeFile(trigger, "");
    const after = await eventually(async () => {
      const read = await look();
      const row = read?.ok ? read.rows?.find((candidate) => candidate.pid === pid) : undefined;
      return read?.ok && row && row.ident !== attached.ident ? { read, row } : undefined;
    }, "the exec to show as another identity");
    assert.equal(after.row.ppid, attached.ppid, "the same process table entry");
    assert.equal(
      after.read.sockets.some((socket) => socket.pid === pid && socket.port === port),
      true,
      "the same pid still holds the port, so a pid-only look would keep it attached",
    );
  },
);

/**
 * Listens on 127.0.0.1:<port>, then, once <trigger> exists, execs the same
 * python3 in place with another script: the same pid, start time and command
 * name, still holding the socket. `cwd` first moves to <outside>; `marker`
 * adds a background job's marker to the environment instead.
 */
const SAME_NAME_EXEC = [
  "import os, socket, sys, time",
  "python, port, trigger, mode, outside, marker_name = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]",
  "s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
  "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
  's.bind(("127.0.0.1", port))',
  "s.listen(8)",
  "s.set_inheritable(True)",
  "while not os.path.exists(trigger): time.sleep(0.05)",
  "env = dict(os.environ)",
  'if mode == "cwd": os.chdir(outside)',
  'else: env[marker_name] = "job_0badc0de"',
  'os.execve(python, [python, "-c", "import time; time.sleep(60)"] + sys.argv[7:], env)',
].join("\n");

for (const mode of ["cwd", "marker"] as const) {
  test(
    `a same-name exec in place that keeps the listener and the identity, but ${mode === "cwd" ? "runs outside the app" : "carries a job's marker"}, fails the tick's re-check`,
    { skip: skip || (PYTHON ? false : "needs a python3 to exec in place with the socket kept") },
    async (t) => {
      const h = await harness(t);
      const port = await defaultOsPort();
      const trigger = path.join(h.outside, `exec-${mode}`);
      const marker = `--aiden-attach-test=${path.basename(path.dirname(h.workspace))}`;
      const line = [PYTHON!, "-c", SAME_NAME_EXEC, PYTHON!, String(port), trigger, mode, h.outside, BACKGROUND_JOB_MARKER, marker].map(shellQuote).join(" ");
      // Its shell exits at once, so the holder is no descendant of the test runner (whose tree is Aiden's).
      const shell = spawn("/bin/sh", ["-c", `${line} >/dev/null 2>&1 & echo $!`], { cwd: h.web, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      shell.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      await new Promise((resolve) => shell.once("close", resolve));
      const pid = Number(out.trim());
      assert.ok(Number.isInteger(pid) && pid > 1, `a pid from the shell: ${out}`);
      t.after(() => {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      });
      const attached = await eventually(async () => {
        const result = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port, pid }, deps());
        return result.ok ? result : undefined;
      }, "the holder to listen and pass the check");
      const look = async () => (await readJobSockets(new Map(), defaultSocketReaderDeps(), new Map([["attach:web", pid]]))).get("attach:web");
      const recheck = async () => {
        const read = await look();
        if (!read?.ok) return { ok: false as const, reason: `the watch's socket look failed: ${read?.reason}` };
        return recheckAttached({ holder: pid, subtree: read.rows!.map((row) => row.pid), workspacePath: h.workspace, appRoot: "apps/web" }, deps());
      };
      assert.deepEqual(await recheck(), { ok: true }, "before the exec, the tick keeps it");
      await writeFile(trigger, "");
      // A failed look (a `reason`, as when the exec lands between macOS's two environment reads) is no verdict:
      // the watch looks again next tick, and so does this.
      const verdict = await eventually(async () => {
        const result = await recheck();
        return result.ok || "reason" in result ? undefined : result;
      }, "the re-check to refuse the exec'd holder");
      assert.deepEqual(verdict, { ok: false, problem: "attach-not-in-app" });
      // The exec'd program is settled once its script runs; then its identity is what the watch bound.
      const after = await eventually(async () => {
        const read = await look();
        const row = read?.ok ? read.rows?.find((candidate) => candidate.pid === pid) : undefined;
        return read?.ok && row?.ident === attached.ident ? read : undefined;
      }, "the exec'd holder to show the identity the watch bound");
      assert.equal(
        after.sockets.some((socket) => socket.pid === pid && socket.port === port),
        true,
        "the same pid still holds the port under the same identity, so only the re-check detaches it",
      );
    },
  );
}

test(
  "a same-name exec in place that lands between macOS's two environment reads is a failed look, and the next look refuses it as outside the app",
  { skip: skip || (process.platform !== "darwin" ? "macOS reads the environment with two ps calls" : PYTHON ? false : "needs a python3 to exec in place with the socket kept") },
  async (t) => {
    const h = await harness(t);
    const port = await defaultOsPort();
    const trigger = path.join(h.outside, "exec-mid-read");
    const marker = `--aiden-attach-test=${path.basename(path.dirname(h.workspace))}`;
    const line = [PYTHON!, "-c", SAME_NAME_EXEC, PYTHON!, String(port), trigger, "cwd", h.outside, BACKGROUND_JOB_MARKER, marker].map(shellQuote).join(" ");
    const shell = spawn("/bin/sh", ["-c", `${line} >/dev/null 2>&1 & echo $!`], { cwd: h.web, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    shell.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((resolve) => shell.once("close", resolve));
    const pid = Number(out.trim());
    assert.ok(Number.isInteger(pid) && pid > 1, `a pid from the shell: ${out}`);
    t.after(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    await eventually(async () => {
      const result = await checkAttach({ workspacePath: h.workspace, appRoot: "apps/web", port, pid }, deps());
      return result.ok ? result : undefined;
    }, "the holder to listen and pass the check");
    // The holder execs right after the `ps -E` read and before the plain `ps`: this look reads its folder
    // in the app, then two commands that disagree.
    const real = defaultSocketReaderDeps();
    let armed = true;
    const reader = {
      ...real,
      exec: async (file: string, args: readonly string[], limits: { timeoutMs: number; maxBuffer: number }) => {
        const result = await real.exec(file, args, limits);
        if (armed && file === "ps" && args.includes("-E")) {
          armed = false;
          await writeFile(trigger, "");
          await eventually(async () => {
            const shown = await real.exec("ps", ["-ww", "-o", "command=", "-p", String(pid)], limits);
            return shown.ok && shown.stdout.includes("time.sleep(60)") && !shown.stdout.includes("socket");
          }, "the exec to replace the holder's command");
        }
        return result;
      },
    };
    const input = { holder: pid, subtree: [pid], workspacePath: h.workspace, appRoot: "apps/web" };
    const torn = await recheckAttached(input, deps({ reader }));
    assert.equal(armed, false, "the look read the environment");
    assert.ok(!torn.ok && "reason" in torn, `a failed look, not a verdict: ${JSON.stringify(torn)}`);
    assert.deepEqual(await recheckAttached(input, deps()), { ok: false, problem: "attach-not-in-app" }, "the next tick's look");
  },
);
