import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultListeningPorts,
  isLoopbackAddress,
  jobProcessTree,
  listeningSocketsByProcess,
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
  const table = await processTable(fakeDeps({ exec: async () => ({ ok: true, stdout: "  100     1   100\n  101   100   100\n\n", stderr: "", exitCode: 0 }) }));
  assert.deepEqual(table, { ok: true, rows: [{ pid: 100, ppid: 1, pgid: 100 }, { pid: 101, ppid: 100, pgid: 100 }] });
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
  const ps = ["100 1 100", "101 100 100", "200 1 200", "201 200 201", "300 1 300", "400 1 400"].join("\n");
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
  const ps = "100 1 100\n200 1 200\n";
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
