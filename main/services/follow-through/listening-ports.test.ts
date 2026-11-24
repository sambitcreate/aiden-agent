import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultListeningPorts,
  isLoopbackAddress,
  jobProcessTree,
  listeningSocketsByProcess,
  parseLsofCwd,
  portHolders,
  processEnvironmentMarks,
  processFolders,
  processNames,
  processSubtree,
  MAX_DESIGN_JOB_FDS,
  parseLsofListening,
  parseLsofListeningSockets,
  parseProcNetTcp,
  parseProcNetTcpSockets,
  portsOfProcesses,
  processTable,
  readJobSockets,
  type SocketReaderDeps,
} from "./listening-ports.js";

test("only listening sockets count from the kernel's TCP table, by socket inode", () => {
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    // 127.0.0.1:5173, LISTEN
    "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41231 1 0000000000000000 100 0 0 10 0",
    // 0.0.0.0:3000, ESTABLISHED: a connection, not a server
    "   1: 00000000:0BB8 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0000000000000000 20 4 30 10 -1",
    // A listening socket with no inode is not attributable to a process.
    "   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  assert.deepEqual([...parseProcNetTcp(table)], [["41231", 5173]]);
});

test("lsof's name lines give each process's ports after the last colon, IPv4 and IPv6 alike", () => {
  assert.deepEqual(
    [...parseLsofListening("p4242\nf23\nn*:5173\nf24\nn[::1]:24678\np4243\nf25\nn127.0.0.1:3000\n")],
    [[4242, [5173, 24678]], [4243, [3000]]],
  );
  assert.deepEqual([...parseLsofListening("")], []);
});

test("a socket a job inherited from Aiden is Aiden's address, not the job's", () => {
  const byProcess = new Map([[100, [38229]], [200, [5173, 38229]], [300, [38229]]]);
  assert.deepEqual(portsOfProcesses(byProcess, [200, 300], 100), [5173]);
  assert.deepEqual(portsOfProcesses(byProcess, [200, 100], 100), [5173], "Aiden itself is never one of the job's processes");
});

test("on Linux, a child that inherits one of Aiden's listening sockets does not report it as its own", { skip: process.platform !== "linux" }, async () => {
  const { createServer } = await import("node:net");
  const { spawn } = await import("node:child_process");
  const ownServer = createServer();
  await new Promise<void>((resolve) => ownServer.listen(0, "127.0.0.1", resolve));
  const ownPort = (ownServer.address() as { port: number }).port;
  const handle = (ownServer as unknown as { _handle: { fd: number } })._handle;
  // The child gets Aiden's listening socket as an extra descriptor, then listens on its own port.
  const child = spawn(
    process.execPath,
    ["-e", "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"],
    { stdio: ["ignore", "pipe", "ignore", handle.fd] },
  );
  try {
    const childPort = await new Promise<number>((resolve) => child.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    const ports = await defaultListeningPorts([child.pid!]);
    assert.ok(ports.includes(childPort), `${childPort} in ${ports.join(",")}`);
    assert.equal(ports.includes(ownPort), false);
  } finally {
    child.kill();
    ownServer.close();
  }
});

// ── Addresses, the job's process tree, and a reader that fails closed (design mode, S14) ──

const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (local: string, inode: string, state = "0A") =>
  `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

test("lsof sockets keep their address", () => {
  const found = parseLsofListeningSockets("p4242\nf23\nn127.0.0.1:5173\nf24\nn*:3000\np4243\nf25\nn[::1]:4321\nf26\nn[::]:8000\n");
  assert.deepEqual(found.get(4242), [
    { address: "127.0.0.1", port: 5173 },
    { address: "*", port: 3000 },
  ]);
  assert.deepEqual(found.get(4243), [
    { address: "::1", port: 4321 },
    { address: "::", port: 8000 },
  ]);
});

test("the lsof reader asks for numeric addresses and ports, listening TCP only, for exactly the pids", async () => {
  const calls: string[][] = [];
  const deps = fakeDeps({
    platform: "darwin",
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return { ok: true, stdout: "p501\nn127.0.0.1:5173\n", stderr: "", exitCode: 0 };
    },
  });
  const result = await listeningSocketsByProcess([501, 502], deps);
  assert.equal(result.ok, true);
  const [call] = calls;
  assert.ok(call!.includes("-nP") || (call!.includes("-n") && call!.includes("-P")), call!.join(" "));
  assert.ok(call!.includes("-sTCP:LISTEN"));
  assert.equal(call!.filter((arg) => arg === "-p").length, 1);
  assert.deepEqual(call![call!.indexOf("-p") + 1]!.split(",").map(Number).sort(), [501, 502, deps.self].sort());
});

test("/proc tcp and tcp6 rows give addresses", () => {
  const v4 = parseProcNetTcpSockets([TCP_HEADER, row("0100007F:1435", "11"), row("00000000:0BB8", "12"), row("0100007F:0050", "13", "01")].join("\n"), 4);
  assert.deepEqual([...v4], [
    ["11", { address: "127.0.0.1", port: 5173 }],
    ["12", { address: "0.0.0.0", port: 3000 }],
  ]);
  const v6 = parseProcNetTcpSockets(
    [
      TCP_HEADER,
      row("00000000000000000000000001000000:10E1", "21"),
      row("00000000000000000000000000000000:1F40", "22"),
      row("0000000000000000FFFF00000100007F:1435", "23"),
      row("B80D0120000000000000000001000000:0050", "24"),
    ].join("\n"),
    6,
  );
  assert.deepEqual([...v6], [
    ["21", { address: "::1", port: 4321 }],
    ["22", { address: "::", port: 8000 }],
    ["23", { address: "::ffff:127.0.0.1", port: 5173 }],
    ["24", { address: "2001:db8::1", port: 80 }],
  ]);
});

test("isLoopbackAddress accepts 127.0.0.0/8, ::1 and ::ffff:127.x, and refuses *, 0.0.0.0, ::, 192.168.1.10 and localhost", () => {
  for (const address of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["*", "0.0.0.0", "::", "[::]", "192.168.1.10", "localhost", "::ffff:192.168.1.10", "128.0.0.1", "fe80::1", "", "127.0.0"]) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});

test("the ps tree gives the group and every descendant by parent pid", () => {
  const rows = [
    { pid: 100, ppid: 1, pgid: 100 }, // the job's leader
    { pid: 101, ppid: 100, pgid: 100 },
    { pid: 102, ppid: 101, pgid: 102 }, // called setsid: its own group
    { pid: 103, ppid: 102, pgid: 102 }, // its child
    { pid: 104, ppid: 1, pgid: 100 }, // re-parented, still in the group
    { pid: 200, ppid: 1, pgid: 200 }, // someone else
    { pid: 201, ppid: 200, pgid: 200 },
  ];
  assert.deepEqual(jobProcessTree(rows, 100), [100, 101, 102, 103, 104]);
  assert.deepEqual(jobProcessTree(rows, 300), []);
});

test("processTable parses ps and fails closed", async () => {
  const table = await processTable(fakeDeps({ exec: async () => ({ ok: true, stdout: "  100     1   100   501\n  101   100   100   501\n\n", stderr: "", exitCode: 0 }) }));
  assert.deepEqual(table, { ok: true, rows: [{ pid: 100, ppid: 1, pgid: 100, uid: 501 }, { pid: 101, ppid: 100, pgid: 100, uid: 501 }] });
  for (const failure of ["timeout", "max-buffer", "error"] as const) {
    const failed = await processTable(fakeDeps({ exec: async () => ({ ok: false, reason: failure }) }));
    assert.equal(failed.ok, false, failure);
  }
  assert.equal((await processTable(fakeDeps({ exec: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 1 }) }))).ok, false);
});

test("on macOS, a timeout, a maxBuffer overrun or lsof's own error fails closed, never an empty list", async () => {
  for (const failure of ["timeout", "max-buffer", "error"] as const) {
    const result = await listeningSocketsByProcess([501], fakeDeps({ platform: "darwin", exec: async () => ({ ok: false, reason: failure }) }));
    assert.equal(result.ok, false, failure);
  }
  const errored = await listeningSocketsByProcess(
    [501],
    fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "", stderr: "lsof: WARNING: can't stat()", exitCode: 1 }) }),
  );
  assert.equal(errored.ok, false);
  for (const exitCode of [0, 1]) {
    const partial = await listeningSocketsByProcess(
      [501],
      fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "p501\nf3\nn127.0.0.1:5173\n", stderr: "lsof: can't read process 502\n", exitCode }) }),
    );
    assert.equal(partial.ok, false, `a loopback-only answer next to a diagnostic is not a complete look (exit ${exitCode})`);
  }
  const other =await listeningSocketsByProcess([501], fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 2 }) }));
  assert.equal(other.ok, false);
});

test("lsof exiting 1 with output is a success", async () => {
  const result = await listeningSocketsByProcess(
    [501, 502],
    fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "p501\nf3\nn127.0.0.1:5173\n", stderr: "", exitCode: 1 }) }),
  );
  assert.deepEqual(result, { ok: true, byPid: new Map([[501, [{ address: "127.0.0.1", port: 5173 }]], [502, []]]) });
  const none = await listeningSocketsByProcess([501], fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 1 }) }));
  assert.deepEqual(none, { ok: true, byPid: new Map([[501, []]]) }, "nothing listening yet is a success with no sockets");
});

test("a socket Aiden holds is left out on macOS", async () => {
  const self = 900;
  const result = await listeningSocketsByProcess(
    [501],
    fakeDeps({
      platform: "darwin",
      self,
      exec: async () => ({ ok: true, stdout: `p900\nn0.0.0.0:7777\np501\nn0.0.0.0:7777\nn127.0.0.1:5173\n`, stderr: "", exitCode: 0 }),
    }),
  );
  assert.deepEqual(result, { ok: true, byPid: new Map([[501, [{ address: "127.0.0.1", port: 5173 }]]]) });
});

function linuxDeps(overrides: Partial<SocketReaderDeps> & { fds?: Record<number, string[] | Error>; tcp?: string | Error; tcp6?: string | Error } = {}) {
  const fds = overrides.fds ?? {};
  return fakeDeps({
    platform: "linux",
    readFile: async (file) => {
      const value = file.endsWith("tcp6") ? (overrides.tcp6 ?? TCP_HEADER) : (overrides.tcp ?? TCP_HEADER);
      if (value instanceof Error) throw value;
      return value;
    },
    readdir: async (folder) => {
      const pid = Number(folder.split("/")[2]);
      const value = fds[pid] ?? [];
      if (value instanceof Error) throw value;
      return value.map((_, index) => String(index));
    },
    readlink: async (link) => {
      const [, , pid, , fd] = link.split("/");
      const value = fds[Number(pid)];
      if (!Array.isArray(value)) throw new Error("gone");
      return value[Number(fd)]!;
    },
    ...overrides,
  });
}

const denied = () => Object.assign(new Error("EACCES"), { code: "EACCES" });

test("on Linux, sockets come from the tables and each pid's fds, with addresses", async () => {
  const result = await listeningSocketsByProcess(
    [501, 502],
    linuxDeps({
      tcp: [TCP_HEADER, row("0100007F:1435", "11"), row("00000000:0BB8", "12")].join("\n"),
      tcp6: [TCP_HEADER, row("00000000000000000000000001000000:10E1", "21")].join("\n"),
      fds: { 501: ["socket:[11]", "pipe:[5]", "socket:[21]"], 502: ["socket:[12]"] },
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    byPid: new Map([
      [501, [{ address: "127.0.0.1", port: 5173 }, { address: "::1", port: 4321 }]],
      [502, [{ address: "0.0.0.0", port: 3000 }]],
    ]),
  });
});

test("on Linux, an unreadable table fails closed", async () => {
  for (const which of ["tcp", "tcp6"] as const) {
    const result = await listeningSocketsByProcess([501], linuxDeps({ [which]: denied() }));
    assert.equal(result.ok, false, which);
  }
});

test("on Linux with IPv6 disabled, a missing tcp6 table is an empty one; a missing tcp table still fails", async () => {
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const noIpv6 = await listeningSocketsByProcess(
    [501],
    linuxDeps({ tcp: [TCP_HEADER, row("0100007F:1435", "11")].join("\n"), tcp6: missing(), fds: { 501: ["socket:[11]"] } }),
  );
  assert.deepEqual(noIpv6, { ok: true, byPid: new Map([[501, [{ address: "127.0.0.1", port: 5173 }]]]) });
  assert.equal((await listeningSocketsByProcess([501], linuxDeps({ tcp: missing() }))).ok, false, "no IPv4 table is never empty");
  assert.equal((await listeningSocketsByProcess([501], linuxDeps({ tcp: missing(), tcp6: missing() }))).ok, false);
});

test("an unreadable fd folder fails only the job that owns that pid", async () => {
  const result = await listeningSocketsByProcess(
    [501, 502],
    linuxDeps({
      tcp: [TCP_HEADER, row("0100007F:1435", "11")].join("\n"),
      fds: { 501: denied(), 502: ["socket:[11]"] },
      processExists: () => true,
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false && result.pids, [501]);
  assert.deepEqual(result.ok === false && result.byPid?.get(502), [{ address: "127.0.0.1", port: 5173 }]);
  // A pid that has gone has no sockets, which is not a failure.
  const gone = await listeningSocketsByProcess([501], linuxDeps({ fds: { 501: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }, processExists: () => false }));
  assert.deepEqual(gone, { ok: true, byPid: new Map([[501, []]]) });
});

test("more than 4 096 open fds fails closed for that pid", async () => {
  const many = Array.from({ length: MAX_DESIGN_JOB_FDS + 1 }, () => "pipe:[1]");
  const result = await listeningSocketsByProcess([501], linuxDeps({ fds: { 501: many } }));
  assert.equal(result.ok, false);
  const exactly = await listeningSocketsByProcess([501], linuxDeps({ fds: { 501: many.slice(1) } }));
  assert.equal(exactly.ok, true);
});

test("three jobs cost one ps and one lsof call", async () => {
  const calls: string[][] = [];
  const ps = ["100 1 100 501", "101 100 100 501", "200 1 200 501", "201 200 201 501", "300 1 300 501", "400 1 400 501"].join("\n");
  const deps = fakeDeps({
    platform: "darwin",
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file.endsWith("ps")) return { ok: true, stdout: ps, stderr: "", exitCode: 0 };
      return { ok: true, stdout: "p101\nn127.0.0.1:5173\np201\nn*:3000\n", stderr: "", exitCode: 1 };
    },
  });
  const result = await readJobSockets(new Map([["job_a", 100], ["job_b", 200], ["job_c", 300]]), deps);
  assert.equal(calls.length, 2);
  const lsof = calls.find((call) => !call[0]!.endsWith("ps"))!;
  assert.equal(lsof.filter((arg) => arg === "-p").length, 1);
  assert.deepEqual(lsof[lsof.indexOf("-p") + 1]!.split(",").map(Number).sort((a, b) => a - b), [100, 101, 200, 201, 300, deps.self].sort((a, b) => a - b));
  assert.deepEqual(result.get("job_a"), { ok: true, sockets: [{ pid: 101, address: "127.0.0.1", port: 5173 }] });
  assert.deepEqual(result.get("job_b"), { ok: true, sockets: [{ pid: 201, address: "*", port: 3000 }] });
  assert.deepEqual(result.get("job_c"), { ok: true, sockets: [] });
});

test("a failed ps or socket read fails every job it covers; a per-pid failure fails only its job", async () => {
  const groups = new Map([["job_a", 100], ["job_b", 200]]);
  const psFailed = await readJobSockets(groups, fakeDeps({ exec: async () => ({ ok: false, reason: "timeout" }) }));
  assert.deepEqual([...psFailed.values()].map((entry) => entry.ok), [false, false]);
  const ps = "100 1 100 501\n200 1 200 501\n";
  const perPid = await readJobSockets(
    groups,
    linuxDeps({
      exec: async () => ({ ok: true, stdout: ps, stderr: "", exitCode: 0 }),
      tcp: [TCP_HEADER, row("0100007F:1435", "11")].join("\n"),
      fds: { 100: denied(), 200: ["socket:[11]"] },
      processExists: () => true,
    }),
  );
  assert.equal(perPid.get("job_a")?.ok, false);
  assert.deepEqual(perPid.get("job_b"), { ok: true, sockets: [{ pid: 200, address: "127.0.0.1", port: 5173 }] });
});

test("the existing ports-only functions behave as before", async () => {
  // Ports-only reads still give nothing on failure, for chat jobs.
  assert.deepEqual(await defaultListeningPorts([]), []);
  assert.deepEqual([...parseLsofListening("p1\nn*:80\n")], [[1, [80]]]);
});

function fakeDeps(overrides: Partial<SocketReaderDeps> = {}): SocketReaderDeps {
  return {
    platform: "darwin",
    self: 900,
    exec: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 1 }),
    readFile: async () => TCP_HEADER,
    readdir: async () => [],
    readlink: async () => "",
    processExists: () => true,
    ...overrides,
  };
}

// ── 2c: process owners, folders, names, port holders, and a separate read for attached servers ──

test("processTable reads the uid column and skips a line without it", async () => {
  const table = await processTable(fakeDeps({ exec: async () => ({ ok: true, stdout: "100 1 100 501\n101 100 100\n102 1 102 0\n", stderr: "", exitCode: 0 }) }));
  assert.deepEqual(table, { ok: true, rows: [{ pid: 100, ppid: 1, pgid: 100, uid: 501 }, { pid: 102, ppid: 1, pgid: 102, uid: 0 }] });
});

test("processTable asks ps for pid, ppid, pgid and uid", async () => {
  const calls: string[][] = [];
  await processTable(fakeDeps({ exec: async (file, args) => (calls.push([file, ...args]), { ok: true, stdout: "1 0 1 0\n", stderr: "", exitCode: 0 }) }));
  assert.deepEqual(calls, [["ps", "-A", "-o", "pid=,ppid=,pgid=,uid="]]);
});

test("with identity, one ps also reads each process's start time and command, so an exec or a reused pid shows while padding doesn't", async () => {
  const calls: string[][] = [];
  const table = (stdout: string) =>
    processTable(
      fakeDeps({ exec: async (file, args) => (calls.push([file, ...args]), { ok: true, stdout, stderr: "", exitCode: 0 }) }),
      { identity: true },
    );
  const identOf = async (stdout: string, pid: number) => {
    const read = await table(stdout);
    assert.ok(read.ok);
    return read.rows.find((row) => row.pid === pid)?.ident;
  };
  const before = await identOf("  100     1   100   501 Tue Nov 24 10:00:00 2026     /usr/local/bin/node\n", 100);
  assert.equal(calls.length, 1, "one ps call");
  assert.equal(calls[0]![0], "ps");
  assert.ok(before);
  // The same process, printed with other column widths (another row was wider): the same identity.
  assert.equal(await identOf("100 1 100 501 Tue Nov 24 10:00:00 2026 /usr/local/bin/node\n99999 1 99999 501 Tue Nov 24 09:00:00 2026 x\n", 100), before);
  // An exec in place: another command under the same pid and start time.
  assert.notEqual(await identOf("100 1 100 501 Tue Nov 24 10:00:00 2026 /bin/sleep\n", 100), before);
  // The pid reused by a process started later.
  assert.notEqual(await identOf("100 1 100 501 Tue Nov 24 10:05:00 2026 /usr/local/bin/node\n", 100), before);
  // A row ps printed without the identity columns has none, and is still a row.
  const bare = await table("100 1 100 501\n");
  assert.deepEqual(bare, { ok: true, rows: [{ pid: 100, ppid: 1, pgid: 100, uid: 501 }] });
});

test("readJobSockets gives an attach root's rows their identity", async () => {
  const deps = fakeDeps({
    platform: "darwin",
    exec: async (file, args) => {
      if (file.endsWith("ps")) {
        const identity = args.some((arg) => arg.includes("lstart"));
        return { ok: true, stdout: identity ? "300 1 300 501 Tue Nov 24 10:00:00 2026 /usr/local/bin/node\n" : "300 1 300 501\n", stderr: "", exitCode: 0 };
      }
      return { ok: true, stdout: "p300\nn127.0.0.1:5173\n", stderr: "", exitCode: 0 };
    },
  });
  const result = (await readJobSockets(new Map(), deps, new Map([["attach:r", 300]]))).get("attach:r");
  assert.ok(result?.ok);
  assert.equal(typeof result.rows?.[0]?.ident, "string");
});

test("processSubtree is a pid and its descendants by parent pid, not its process group", () => {
  const rows = [
    { pid: 100, ppid: 1, pgid: 100, uid: 501 },
    { pid: 101, ppid: 100, pgid: 100, uid: 501 },
    { pid: 102, ppid: 101, pgid: 102, uid: 501 },
    { pid: 103, ppid: 1, pgid: 100, uid: 501 }, // same group, not a descendant
    { pid: 104, ppid: 100, pgid: 100, uid: 501 },
  ];
  assert.deepEqual(processSubtree(rows, 101), [101, 102]);
  assert.deepEqual(processSubtree(rows, 100), [100, 101, 102, 104]);
  assert.deepEqual(processSubtree(rows, 999), []);
});

test("parseLsofCwd maps each pid to its folder, spaces and unicode included, skipping malformed lines", () => {
  const output = "p123\nfcwd\nn/Users/x/app\np124\nfcwd\nn/Users/x/My App/ünï\npnope\nn/ignored\np125\nfcwd\nxjunk\n";
  assert.deepEqual([...parseLsofCwd(output)], [
    [123, "/Users/x/app"],
    [124, "/Users/x/My App/ünï"],
  ]);
});

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

test("processFolders on macOS runs one lsof for the uid and keeps only the pids asked for", async () => {
  const calls: string[][] = [];
  const deps = fakeDeps({
    platform: "darwin",
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return { ok: true, stdout: "p10\nfcwd\nn/w/apps/web\np11\nfcwd\nn/w\np12\nfcwd\nn/elsewhere\n", stderr: "", exitCode: 0 };
    },
  });
  const result = await processFolders([10, 11], deps, { uid: 501, maxPids: 4096 });
  assert.deepEqual(result, { ok: true, incomplete: false, byPid: new Map([[10, "/w/apps/web"], [11, "/w"]]) });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call![0], "/usr/sbin/lsof");
  assert.ok(call!.includes("-d") && call![call!.indexOf("-d") + 1] === "cwd");
  assert.equal(call![call!.indexOf("-u") + 1], "501");
});

test("processFolders on macOS: stderr is incomplete with partial and a failure without; a timeout always fails", async () => {
  const noisy = fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "p10\nfcwd\nn/w\n", stderr: "lsof: WARNING: can't stat()\n", exitCode: 1 }) });
  assert.deepEqual(await processFolders([10, 11], noisy, { uid: 501, maxPids: 4096, partial: true }), {
    ok: true,
    incomplete: true,
    byPid: new Map([[10, "/w"]]),
  });
  assert.equal((await processFolders([10], noisy, { uid: 501, maxPids: 4096 })).ok, false);
  for (const partial of [true, false]) {
    const timedOut = fakeDeps({ platform: "darwin", exec: async () => ({ ok: false, reason: "timeout" }) });
    assert.equal((await processFolders([10], timedOut, { uid: 501, maxPids: 4096, partial })).ok, false);
  }
  const exit2 = fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 2 }) });
  assert.equal((await processFolders([10], exit2, { uid: 501, maxPids: 4096, partial: true })).ok, false);
});

test("processFolders on Linux reads /proc/<pid>/cwd for exactly the pids given and skips EACCES and ENOENT", async () => {
  const read: string[] = [];
  const deps = fakeDeps({
    platform: "linux",
    readlink: async (link) => {
      read.push(link);
      if (link === "/proc/11/cwd") throw denied();
      if (link === "/proc/12/cwd") throw enoent();
      return "/w/apps/web";
    },
  });
  assert.deepEqual(await processFolders([10, 11, 12], deps, { uid: 501, maxPids: 4096, partial: true }), {
    ok: true,
    incomplete: true,
    byPid: new Map([[10, "/w/apps/web"]]),
  });
  assert.deepEqual(read, ["/proc/10/cwd", "/proc/11/cwd", "/proc/12/cwd"]);
  assert.equal((await processFolders([10, 11], deps, { uid: 501, maxPids: 4096 })).ok, false, "strict reads fail on a skipped pid");
  assert.deepEqual(await processFolders([10], deps, { uid: 501, maxPids: 4096 }), { ok: true, incomplete: false, byPid: new Map([[10, "/w/apps/web"]]) });
});

test("processFolders refuses more than maxPids processes", async () => {
  const deps = fakeDeps({ platform: "linux", readlink: async () => "/w" });
  assert.equal((await processFolders([10, 11, 12], deps, { uid: 501, maxPids: 2, partial: true })).ok, false);
});

test("processNames keeps the last path segment of comm, cut to 64 characters, and fails closed", async () => {
  const long = "x".repeat(80);
  const calls: string[][] = [];
  const deps = fakeDeps({
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return { ok: true, stdout: `  10 /Applications/My Tools/node server\n  11 vite\n  12 /opt/${long}\n`, stderr: "", exitCode: 0 };
    },
  });
  assert.deepEqual(await processNames([10, 11, 12], deps), {
    ok: true,
    byPid: new Map([[10, "node server"], [11, "vite"], [12, "x".repeat(64)]]),
  });
  assert.deepEqual(calls, [["ps", "-o", "pid=,comm=", "-p", "10,11,12"]]);
  assert.equal((await processNames([10], fakeDeps({ exec: async () => ({ ok: false, reason: "timeout" }) }))).ok, false);
});

test("portHolders on macOS asks lsof for the uid's listeners on the port and fails closed on stderr", async () => {
  const calls: string[][] = [];
  const deps = fakeDeps({
    platform: "darwin",
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return { ok: true, stdout: "p10\nf3\nn127.0.0.1:5173\np11\nf4\nn[::1]:5173\n", stderr: "", exitCode: 0 };
    },
  });
  assert.deepEqual(await portHolders(5173, 501, deps), { ok: true, pids: [10, 11] });
  const [call] = calls;
  assert.ok(call!.includes("-iTCP:5173"));
  assert.ok(call!.includes("-sTCP:LISTEN"));
  assert.equal(call![call!.indexOf("-u") + 1], "501");
  const noisy = fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "p10\nn127.0.0.1:5173\n", stderr: "lsof: oops\n", exitCode: 0 }) });
  assert.equal((await portHolders(5173, 501, noisy)).ok, false);
  const nobody = fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 1 }) });
  assert.deepEqual(await portHolders(5173, 501, nobody), { ok: true, pids: [] });
});

test("portHolders on Linux maps the port's listening inode to this uid's process and never reads another uid's", async () => {
  const opened: number[] = [];
  const deps = linuxDeps({
    exec: async () => ({ ok: true, stdout: "10 1 10 501\n20 1 20 0\n30 1 30 501\n", stderr: "", exitCode: 0 }),
    tcp: [TCP_HEADER, row("0100007F:1435", "11"), row("0100007F:0BB8", "12")].join("\n"),
    tcp6: [TCP_HEADER, row("00000000000000000000000001000000:1435", "21")].join("\n"),
    fds: { 10: ["socket:[11]"], 20: ["socket:[21]"], 30: ["socket:[21]"] },
  });
  const readdir = deps.readdir;
  deps.readdir = async (folder) => {
    opened.push(Number(folder.split("/")[2]));
    return readdir(folder);
  };
  assert.deepEqual(await portHolders(5173, 501, deps), { ok: true, pids: [10, 30] });
  assert.equal(opened.includes(20), false, "another uid's fds are never read");
  assert.deepEqual(await portHolders(4000, 501, deps), { ok: true, pids: [] });
});

test("portHolders on Linux skips an unreadable process only while the readable ones account for every socket on the port", async () => {
  // 40 is the person's but its fds can't be read, as with Chromium's non-dumpable sandboxed helpers.
  const deps = linuxDeps({
    exec: async () => ({ ok: true, stdout: "10 1 10 501\n40 1 40 501\n", stderr: "", exitCode: 0 }),
    tcp: [TCP_HEADER, row("0100007F:1435", "11"), row("0100007F:0BB8", "12")].join("\n"),
    fds: { 10: ["socket:[11]"], 40: denied() },
  });
  assert.deepEqual(await portHolders(5173, 501, deps), { ok: true, pids: [10] }, "port 5173's one socket is 10's");
  assert.deepEqual(
    await portHolders(3000, 501, deps),
    { ok: false, reason: "a holder of port 3000 couldn't be read" },
    "no readable process holds port 3000's socket, and 40 might",
  );
});

test("listeningSocketsByProcess with partial keeps what lsof read next to a diagnostic", async () => {
  const deps = fakeDeps({ platform: "darwin", exec: async () => ({ ok: true, stdout: "p501\nf3\nn127.0.0.1:5173\n", stderr: "lsof: can't read 502\n", exitCode: 1 }) });
  assert.deepEqual(await listeningSocketsByProcess([501, 502], deps, { partial: true }), {
    ok: true,
    incomplete: true,
    byPid: new Map([[501, [{ address: "127.0.0.1", port: 5173 }]], [502, []]]),
  });
  assert.equal((await listeningSocketsByProcess([501, 502], deps)).ok, false, "without partial it still fails closed");
});

test("readJobSockets answers jobs and attach roots from one ps and two socket reads", async () => {
  const calls: string[][] = [];
  const ps = ["100 1 100 501", "101 100 100 501", "300 1 300 501", "301 300 300 501", "302 301 300 0"].join("\n");
  const deps = fakeDeps({
    platform: "darwin",
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file.endsWith("ps")) return { ok: true, stdout: ps, stderr: "", exitCode: 0 };
      const pids = args[args.indexOf("-p") + 1]!;
      if (pids.includes("101")) return { ok: true, stdout: "p101\nn127.0.0.1:5173\n", stderr: "", exitCode: 1 };
      return { ok: true, stdout: "p301\nn[::1]:4321\n", stderr: "", exitCode: 1 };
    },
  });
  const result = await readJobSockets(new Map([["job_a", 100]]), deps, new Map([["attach:ws\0docs", 301]]));
  assert.equal(calls.filter((call) => call[0]!.endsWith("ps")).length, 1);
  assert.equal(calls.filter((call) => call[0]!.endsWith("lsof")).length, 2);
  assert.deepEqual(result.get("job_a"), { ok: true, sockets: [{ pid: 101, address: "127.0.0.1", port: 5173 }] });
  assert.deepEqual(result.get("attach:ws\0docs"), {
    ok: true,
    sockets: [{ pid: 301, address: "::1", port: 4321 }],
    rows: [
      { pid: 301, ppid: 300, pgid: 300, uid: 501 },
      { pid: 302, ppid: 301, pgid: 300, uid: 0 },
    ],
  });
});

test("a diagnostic on one side's socket read never fails the other", async () => {
  const ps = ["100 1 100 501", "300 1 300 501"].join("\n");
  const noisyOn = (noisy: "100" | "300") =>
    fakeDeps({
      platform: "darwin",
      exec: async (file, args) => {
        if (file.endsWith("ps")) return { ok: true, stdout: ps, stderr: "", exitCode: 0 };
        const pids = args[args.indexOf("-p") + 1]!;
        const stdout = pids.startsWith("100") ? "p100\nn127.0.0.1:5173\n" : "p300\nn127.0.0.1:4321\n";
        return { ok: true, stdout, stderr: pids.startsWith(noisy) ? "lsof: WARNING\n" : "", exitCode: 0 };
      },
    });
  const roots = new Map([["attach:r", 300]]);
  const rootsNoisy = await readJobSockets(new Map([["job_a", 100]]), noisyOn("300"), roots);
  assert.equal(rootsNoisy.get("attach:r")?.ok, false);
  assert.equal(rootsNoisy.get("job_a")?.ok, true);
  const jobsNoisy = await readJobSockets(new Map([["job_a", 100]]), noisyOn("100"), roots);
  assert.equal(jobsNoisy.get("job_a")?.ok, false);
  assert.equal(jobsNoisy.get("attach:r")?.ok, true);
});

test("an attach root whose pid is gone answers with no sockets and no rows", async () => {
  const deps = fakeDeps({ exec: async (file) => (file.endsWith("ps") ? { ok: true, stdout: "100 1 100 501\n", stderr: "", exitCode: 0 } : { ok: true, stdout: "", stderr: "", exitCode: 1 }) });
  const result = await readJobSockets(new Map(), deps, new Map([["attach:r", 777]]));
  assert.deepEqual(result.get("attach:r"), { ok: true, sockets: [], rows: [] });
});

test("portHolders on Linux fails closed when an unreadable process is right above the outermost holder it found", async () => {
  // 40 can't be read and is 10's parent: it may hold the same listening socket (a forked fd), so it may be the outermost holder.
  const deps = linuxDeps({
    exec: async () => ({ ok: true, stdout: "40 1 40 501\n10 40 10 501\n", stderr: "", exitCode: 0 }),
    tcp: [TCP_HEADER, row("0100007F:1435", "11")].join("\n"),
    fds: { 10: ["socket:[11]"], 40: denied() },
  });
  assert.equal((await portHolders(5173, 501, deps)).ok, false);
  // 10 holds it under a readable parent 30 (which doesn't), below an unreadable 40: a session daemon above
  // everything, such as an sshd session or cua-spacesd. 40 could have handed the socket down only through 30.
  const below = linuxDeps({
    exec: async () => ({ ok: true, stdout: "40 1 40 501\n30 40 30 501\n10 30 10 501\n", stderr: "", exitCode: 0 }),
    tcp: [TCP_HEADER, row("0100007F:1435", "11")].join("\n"),
    fds: { 10: ["socket:[11]"], 30: [], 40: denied() },
  });
  assert.deepEqual(await portHolders(5173, 501, below), { ok: true, pids: [10] });
  // The same chain where 30 holds the socket too: 40, right above the outermost holder, may hold it as well.
  const chain = linuxDeps({
    exec: async () => ({ ok: true, stdout: "40 1 40 501\n30 40 30 501\n10 30 10 501\n", stderr: "", exitCode: 0 }),
    tcp: [TCP_HEADER, row("0100007F:1435", "11")].join("\n"),
    fds: { 10: ["socket:[11]"], 30: ["socket:[11]"], 40: denied() },
  });
  assert.equal((await portHolders(5173, 501, chain)).ok, false);
});

test("on Linux, an attach root whose subtree holds another user's unreadable process answers its rows with the failed read", async () => {
  const deps = linuxDeps({
    exec: async () => ({ ok: true, stdout: "300 1 300 501\n301 300 300 501\n302 301 300 0\n", stderr: "", exitCode: 0 }),
    tcp: [TCP_HEADER, row("0100007F:1435", "11")].join("\n"),
    fds: { 301: ["socket:[11]"], 302: denied() },
  });
  const result = (await readJobSockets(new Map(), deps, new Map([["attach:r", 301]]))).get("attach:r");
  assert.equal(result?.ok, false);
  assert.deepEqual(result?.rows, [
    { pid: 301, ppid: 300, pgid: 300, uid: 501 },
    { pid: 302, ppid: 301, pgid: 300, uid: 0 },
  ]);
});

test("processEnvironmentMarks on Linux reads each /proc/<pid>/environ and fails closed per process", async () => {
  const environ: Record<number, string | Error> = { 10: "PATH=/bin\0AIDEN_BACKGROUND_JOB=job_0badc0de\0", 11: "PATH=/bin\0", 12: denied() };
  const deps = fakeDeps({
    platform: "linux",
    readFile: async (file) => {
      const value = environ[Number(file.split("/")[2])];
      if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (value instanceof Error) throw value;
      return value;
    },
  });
  assert.deepEqual(await processEnvironmentMarks([10, 11, 12, 13], "AIDEN_BACKGROUND_JOB=", deps), {
    ok: true,
    marked: new Set([10]),
    unreadable: new Set([12, 13]),
  });
});

test("processEnvironmentMarks on macOS compares ps -E with plain ps, so an environment ps can't show is unreadable", async () => {
  const command: Record<number, string> = { 10: "node server.mjs", 11: "node server.mjs", 12: "sleep 30" };
  const environment: Record<number, string> = { 10: " PATH=/bin AIDEN_BACKGROUND_JOB=job_0badc0de", 11: " PATH=/bin HOME=/Users/me", 12: "" };
  const calls: string[][] = [];
  const deps = fakeDeps({
    platform: "darwin",
    exec: async (file, args) => {
      calls.push([file, ...args]);
      const shown = args.includes("-E");
      // 13 left between the two reads.
      const pids = args[args.indexOf("-p") + 1]!.split(",").map(Number).filter((pid) => command[pid] && !(pid === 13 && !shown));
      return { ok: true, stdout: pids.map((pid) => `${String(pid).padStart(5)} ${command[pid]}${shown ? environment[pid] : ""}`).join("\n"), stderr: "", exitCode: 0 };
    },
  });
  command[13] = "node other.mjs";
  environment[13] = " PATH=/bin";
  assert.deepEqual(await processEnvironmentMarks([10, 11, 12, 13], "AIDEN_BACKGROUND_JOB=", deps), {
    ok: true,
    marked: new Set([10]),
    unreadable: new Set([12, 13]),
  });
  assert.equal(calls.length, 2, "two ps calls cover every pid");
  assert.equal((await processEnvironmentMarks([10], "AIDEN_BACKGROUND_JOB=", fakeDeps({ exec: async () => ({ ok: false, reason: "timeout" }) }))).ok, false);
});
