import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import type { SocketReaderDeps } from "../../follow-through/listening-ports.js";
import { attachOrigin, attachOrigins, checkAttach, parseAttachUrl, rebindHolder, scanRunningServers, type AttachScanDeps } from "./app-attach.js";

test("parseAttachUrl accepts a loopback http origin with an explicit port, as written", () => {
  assert.deepEqual(parseAttachUrl("http://localhost:4321"), { ok: true, url: "http://localhost:4321", port: 4321 });
  assert.deepEqual(parseAttachUrl("http://127.0.0.1:5173/"), { ok: true, url: "http://127.0.0.1:5173", port: 5173 });
  assert.deepEqual(parseAttachUrl("http://[::1]:3000"), { ok: true, url: "http://[::1]:3000", port: 3000 });
});

test("parseAttachUrl refuses anything that isn't exactly a loopback http origin", () => {
  const refused: unknown[] = [
    "https://localhost:4321",
    "ws://localhost:1",
    "http://192.168.1.10:3000",
    "http://localhost.evil.com:3000",
    "http://0.0.0.0:3000",
    "http://[::]:3000",
    "http://localhost",
    "http://u:p@localhost:3000",
    "http://localhost:3000/app",
    "http://localhost:3000?x=1",
    "http://localhost:3000#top",
    "http://localhost:80",
    "http://localhost:70000",
    "http://127.1:3000",
    " http://localhost:3000",
    `http://localhost:3000/${"a".repeat(280)}`,
    `http://localhost:${"0".repeat(290)}3000`,
    3000,
    null,
    undefined,
    { url: "http://localhost:3000" },
  ];
  for (const value of refused) assert.deepEqual(parseAttachUrl(value), { ok: false }, JSON.stringify(value));
});

const socket = (address: string, port = 5173) => ({ address, port });

test("attachOrigin picks the origin from the sockets the server holds", () => {
  assert.equal(attachOrigin([socket("127.0.0.1")], 5173), "http://127.0.0.1:5173");
  assert.equal(attachOrigin([socket("::ffff:127.0.0.1")], 5173), "http://127.0.0.1:5173");
  assert.equal(attachOrigin([socket("::1")], 5173), "http://[::1]:5173");
  assert.equal(attachOrigin([socket("::1"), socket("127.0.0.1")], 5173), "http://127.0.0.1:5173");
  assert.equal(attachOrigin([socket("127.0.0.2")], 5173), undefined, "another loopback address has no origin to load");
  assert.equal(attachOrigin([socket("127.0.0.1", 5174)], 5173), undefined, "a socket on another port");
});

test("attachOrigins lists every exact origin held on the port", () => {
  assert.deepEqual(attachOrigins([socket("127.0.0.1"), socket("::1")], 5173), ["http://127.0.0.1:5173", "http://[::1]:5173"]);
  assert.deepEqual(attachOrigins([socket("::1")], 5173), ["http://[::1]:5173"]);
  assert.deepEqual(attachOrigins([socket("127.0.0.2")], 5173), []);
});

// ── The scan and the attach check (D6, D8), over a fake process and socket table ──

interface FakeProcess {
  pid: number;
  ppid: number;
  uid?: number;
  /** Absolute folder. */
  cwd: string;
  /** "127.0.0.1:5173", "*:3000", "::1:4321" (last colon splits the port). */
  sockets?: string[];
  name?: string;
}

const ME = 501;
const SELF = 900;
const WORKSPACE = "/Users/me/site";

interface World {
  processes: FakeProcess[];
  platform?: "darwin" | "linux";
  /** Paths that are links: link → target. */
  links?: Record<string, string>;
  /** stderr on the discovery socket read (lsof -p …) */
  socketStderr?: string;
  psFails?: boolean;
  cwdTimeout?: boolean;
  holderFails?: boolean;
  owned?: number[];
  shells?: number[];
  renderer?: number;
}

function splitSocket(text: string): { address: string; port: number } {
  const colon = text.lastIndexOf(":");
  return { address: text.slice(0, colon), port: Number(text.slice(colon + 1)) };
}

const v4hex = (address: string) =>
  address === "*" ? "00000000" : address.split(".").map((byte) => Number(byte).toString(16).padStart(2, "0").toUpperCase()).reverse().join("");
const v6hex = (address: string) =>
  address === "::1" ? "00000000000000000000000001000000" : "00000000000000000000000000000000";

function world(spec: World) {
  const calls = { exec: [] as string[][], readlink: [] as string[], realpath: [] as string[] };
  const uidOf = (pid: number) => spec.processes.find((entry) => entry.pid === pid)?.uid ?? ME;
  const resolve = (target: string) => {
    for (const [link, to] of Object.entries(spec.links ?? {})) {
      if (target === link || target.startsWith(`${link}/`)) return to + target.slice(link.length);
    }
    return target;
  };
  const inodes = new Map<string, { pid: number; address: string; port: number }>();
  let inode = 100;
  for (const entry of spec.processes) for (const text of entry.sockets ?? []) inodes.set(String(inode++), { pid: entry.pid, ...splitSocket(text) });
  const reader: SocketReaderDeps = {
    platform: spec.platform ?? "darwin",
    self: SELF,
    exec: async (file, args) => {
      calls.exec.push([file, ...args]);
      if (file === "ps" && args[0] === "-A") {
        if (spec.psFails) return { ok: false, reason: "timeout" };
        const rows = [{ pid: SELF, ppid: 1, uid: ME }, ...spec.processes].map(
          (entry) => `${entry.pid} ${entry.ppid} ${entry.pid} ${"uid" in entry && entry.uid !== undefined ? entry.uid : ME}`,
        );
        return { ok: true, stdout: rows.join("\n"), stderr: "", exitCode: 0 };
      }
      if (file === "ps") {
        const pids = args[args.indexOf("-p") + 1]!.split(",").map(Number);
        const lines = pids.flatMap((pid) => {
          const entry = spec.processes.find((candidate) => candidate.pid === pid);
          return entry ? [`${pid} /usr/local/bin/${entry.name ?? "node"}`] : [];
        });
        return { ok: true, stdout: lines.join("\n"), stderr: "", exitCode: 0 };
      }
      if (args.includes("cwd")) {
        if (spec.cwdTimeout) return { ok: false, reason: "timeout" };
        const uid = Number(args[args.indexOf("-u") + 1]);
        const lines = spec.processes.filter((entry) => (entry.uid ?? ME) === uid).flatMap((entry) => [`p${entry.pid}`, "fcwd", `n${entry.cwd}`]);
        return { ok: true, stdout: lines.join("\n"), stderr: "", exitCode: 0 };
      }
      const portArg = args.find((arg) => arg.startsWith("-iTCP:"));
      if (portArg) {
        if (spec.holderFails) return { ok: true, stdout: "", stderr: "lsof: oops", exitCode: 1 };
        const port = Number(portArg.slice("-iTCP:".length));
        const uid = Number(args[args.indexOf("-u") + 1]);
        const lines = spec.processes
          .filter((entry) => (entry.uid ?? ME) === uid && (entry.sockets ?? []).some((text) => splitSocket(text).port === port))
          .flatMap((entry) => [`p${entry.pid}`, ...(entry.sockets ?? []).filter((text) => splitSocket(text).port === port).map((text) => `n${text}`)]);
        return { ok: true, stdout: lines.join("\n"), stderr: "", exitCode: lines.length ? 0 : 1 };
      }
      const pids = args[args.indexOf("-p") + 1]!.split(",").map(Number);
      const lines = spec.processes
        .filter((entry) => pids.includes(entry.pid) && (entry.uid ?? ME) === ME)
        .flatMap((entry) => [`p${entry.pid}`, ...(entry.sockets ?? []).map((text) => `n${text}`)]);
      return { ok: true, stdout: lines.join("\n"), stderr: spec.socketStderr ?? "", exitCode: lines.length ? 0 : 1 };
    },
    readFile: async (file) => {
      const family = file.endsWith("tcp6") ? 6 : 4;
      const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
      const rows = [...inodes]
        .filter(([, socket]) => (family === 6) === socket.address.includes(":"))
        .map(
          ([id, socket]) =>
            `   0: ${family === 6 ? v6hex(socket.address) : v4hex(socket.address)}:${socket.port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${ME}        0 ${id} 1 0000000000000000 100 0 0 10 0`,
        );
      return [header, ...rows].join("\n");
    },
    readdir: async (folder) => {
      const pid = Number(folder.split("/")[2]);
      if (uidOf(pid) !== ME) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return [...inodes].filter(([, socket]) => socket.pid === pid).map((_, index) => String(index));
    },
    readlink: async (link) => {
      calls.readlink.push(link);
      const [, , pidText, kind, fd] = link.split("/");
      const pid = Number(pidText);
      if (uidOf(pid) !== ME) throw new Error(`read another user's ${link}`);
      if (kind === "cwd") {
        const entry = spec.processes.find((candidate) => candidate.pid === pid);
        if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return entry.cwd;
      }
      const owned = [...inodes].filter(([, socket]) => socket.pid === pid);
      return `socket:[${owned[Number(fd)]![0]}]`;
    },
    processExists: (pid) => spec.processes.some((entry) => entry.pid === pid),
  };
  const deps: AttachScanDeps = {
    reader,
    uid: ME,
    self: SELF,
    realpath: async (target) => {
      calls.realpath.push(target);
      return resolve(path.resolve(target));
    },
    lstat: async (target) => {
      const isLink = Object.keys(spec.links ?? {}).includes(path.resolve(target));
      return { isDirectory: () => !isLink, isSymbolicLink: () => isLink };
    },
    excludedPorts: () => new Set([9222, 9229, 24678, ...(spec.renderer ? [spec.renderer] : [])]),
    ownedPids: () => new Set(spec.owned ?? []),
    terminalShellPids: () => spec.shells ?? [],
  };
  return { deps, calls };
}

const scan = (spec: World, input: Partial<{ roots: string[]; busyRoots: string[]; workspacePath: string }> = {}) => {
  const { deps, calls } = world(spec);
  return scanRunningServers(
    { workspacePath: input.workspacePath ?? WORKSPACE, roots: input.roots ?? ["apps/web"], busyRoots: new Set(input.busyRoots ?? []) },
    deps,
  ).then((result) => ({ result, calls }));
};

test("scan lists a loopback server under its app root with origin, process name and folder", async () => {
  const { result } = await scan({ processes: [{ pid: 10, ppid: 5, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:5173"], name: "vite" }, { pid: 5, ppid: 1, cwd: "/Users/me" }] });
  assert.deepEqual(result, {
    ok: true,
    incomplete: false,
    servers: [{ port: 5173, pid: 10, origin: "http://127.0.0.1:5173", appRoot: "apps/web", folder: "apps/web", processName: "vite", connectable: true }],
  });
});

test("scan: apps/web2 isn't inside apps/web, the workspace folder is '.', and outside folders aren't listed", async () => {
  const { result } = await scan({
    processes: [
      { pid: 10, ppid: 1, cwd: `${WORKSPACE}/apps/web2`, sockets: ["127.0.0.1:3000"] },
      { pid: 11, ppid: 1, cwd: WORKSPACE, sockets: ["127.0.0.1:3001"] },
      { pid: 12, ppid: 1, cwd: "/Users/me/other", sockets: ["127.0.0.1:3002"] },
      { pid: 13, ppid: 1, cwd: "/Users/me/site-copy", sockets: ["127.0.0.1:3003"] },
      { pid: 14, ppid: 1, cwd: `${WORKSPACE}/apps/web/src`, sockets: ["127.0.0.1:3004"] },
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(
    result.servers.map((server) => [server.port, server.appRoot, server.folder]),
    [
      [3000, "apps/web2", "apps/web2"],
      [3001, ".", "."],
      [3004, "apps/web", "apps/web/src"],
    ],
  );
});

test("scan resolves a symlinked workspace once and matches through it", async () => {
  const { result, calls } = await scan(
    { processes: [{ pid: 10, ppid: 1, cwd: "/Volumes/real/site/apps/web", sockets: ["127.0.0.1:5173"] }], links: { "/Users/me/site": "/Volumes/real/site" } },
  );
  assert.ok(result.ok);
  assert.equal(result.servers.length, 1);
  assert.deepEqual(calls.realpath, [WORKSPACE]);
});

test("scan never lists, nor reads the folder of, another user's process (Linux)", async () => {
  const { result, calls } = await scan({
    platform: "linux",
    processes: [
      { pid: 10, ppid: 1, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:5173"] },
      { pid: 20, ppid: 1, uid: 0, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:5174"] },
    ],
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.servers.map((server) => server.pid), [10]);
  assert.equal(calls.readlink.includes("/proc/20/cwd"), false);
});

test("scan leaves out Aiden's own processes, but lists a server under a terminal-drawer shell", async () => {
  const { result } = await scan({
    owned: [30],
    shells: [40],
    processes: [
      { pid: 30, ppid: SELF, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:4000"] }, // a job
      { pid: 31, ppid: SELF, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:4001"] }, // Aiden's helper
      { pid: 32, ppid: 31, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:4002"] }, // its child
      { pid: 40, ppid: SELF, cwd: WORKSPACE }, // the terminal shell
      { pid: 41, ppid: 40, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:4003"] }, // the person's server in it
    ],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.servers.map((server) => server.port), [4003]);
});

test("scan leaves out low, debugging, HMR and renderer ports", async () => {
  const { result } = await scan({
    renderer: 5175,
    processes: [80, 9222, 9229, 24678, 5175, 5176].map((port, index) => ({ pid: 10 + index, ppid: 1, cwd: `${WORKSPACE}/apps/web`, sockets: [`127.0.0.1:${port}`] })),
  });
  assert.ok(result.ok);
  assert.deepEqual(result.servers.map((server) => server.port), [5176]);
});

test("scan marks rows that can't be connected, and why", async () => {
  const { result } = await scan(
    {
      processes: [
        { pid: 10, ppid: 1, cwd: `${WORKSPACE}/apps/a`, sockets: ["127.0.0.1:3000"] },
        { pid: 11, ppid: 10, cwd: `${WORKSPACE}/apps/a`, sockets: ["0.0.0.0:3010"] }, // child binds a wildcard
        { pid: 20, ppid: 1, cwd: `${WORKSPACE}/apps/b`, sockets: ["127.0.0.2:3001"] },
        { pid: 30, ppid: 1, cwd: `${WORKSPACE}/apps/c`, sockets: ["127.0.0.1:3002"] },
        { pid: 31, ppid: 30, uid: 0, cwd: "/" },
        { pid: 40, ppid: 1, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:3003"] },
      ],
    },
    { roots: ["apps/a", "apps/b", "apps/c", "apps/web"], busyRoots: ["apps/web"] },
  );
  assert.ok(result.ok);
  const byPort = new Map(result.servers.map((server) => [server.port, server]));
  assert.deepEqual([byPort.get(3000)?.connectable, byPort.get(3000)?.why, byPort.get(3000)?.origin], [false, "beyond-loopback", undefined]);
  assert.deepEqual([byPort.get(3001)?.connectable, byPort.get(3001)?.why], [false, "other-address"]);
  assert.deepEqual([byPort.get(3002)?.connectable, byPort.get(3002)?.why], [false, "other-user"]);
  assert.deepEqual([byPort.get(3003)?.connectable, byPort.get(3003)?.why], [false, "already-running"]);
});

test("scan lists a port once, under its outermost holder, and at most 20 rows by port", async () => {
  const { result } = await scan({
    processes: [
      { pid: 10, ppid: 1, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:5173"] },
      { pid: 11, ppid: 10, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:5173"] },
      ...Array.from({ length: 25 }, (_, index) => ({ pid: 100 + index, ppid: 1, cwd: `${WORKSPACE}/apps/web`, sockets: [`127.0.0.1:${6000 - index}`] })),
    ],
  });
  assert.ok(result.ok);
  assert.equal(result.servers.length, 20);
  assert.equal(result.servers[0]!.port, 5173);
  assert.equal(result.servers[0]!.pid, 10);
  assert.deepEqual(result.servers.map((server) => server.port), [...result.servers.map((server) => server.port)].sort((a, b) => a - b));
});

test("scan keeps what it read next to an lsof diagnostic, and fails on a failed ps or a timed-out read", async () => {
  const processes = [{ pid: 10, ppid: 1, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:5173"] }];
  const noisy = await scan({ processes, socketStderr: "lsof: WARNING: can't stat()\n" });
  assert.deepEqual(noisy.result.ok && [noisy.result.incomplete, noisy.result.servers.length], [true, 1]);
  assert.deepEqual((await scan({ processes, psFails: true })).result, { ok: false });
  assert.deepEqual((await scan({ processes, cwdTimeout: true })).result, { ok: false });
});

const check = (spec: World, input: Partial<{ appRoot: string; port: number; pid: number }> = {}) => {
  const { deps, calls } = world(spec);
  return checkAttach(
    { workspacePath: WORKSPACE, appRoot: input.appRoot ?? "apps/web", port: input.port ?? 5173, ...(input.pid !== undefined ? { pid: input.pid } : {}) },
    deps,
  ).then((result) => ({ result, calls }));
};

const server = (overrides: Partial<FakeProcess> = {}): FakeProcess => ({ pid: 10, ppid: 5, cwd: `${WORKSPACE}/apps/web`, sockets: ["127.0.0.1:5173"], name: "vite", ...overrides });

test("checkAttach passes a loopback server of the person's in the app root", async () => {
  const { result } = await check({ processes: [{ pid: 5, ppid: 1, cwd: "/Users/me" }, server()] });
  assert.deepEqual(result, { ok: true, pid: 10, ppid: 5, origin: "http://127.0.0.1:5173", held: ["127.0.0.1"], processName: "vite", folder: "apps/web" });
});

test("checkAttach refuses in D8's order", async () => {
  const notInApp = { ok: false, problem: "attach-not-in-app" };
  const unreachable = { ok: false, problem: "attach-unreachable" };
  const notLoopback = { ok: false, problem: "attach-not-loopback" };
  assert.deepEqual((await check({ processes: [server({ sockets: ["127.0.0.1:9222"] })] }, { port: 9222 })).result, notInApp);
  assert.deepEqual((await check({ processes: [server({ sockets: ["127.0.0.1:800"] })] }, { port: 800 })).result, notInApp);
  const nobody = await check({ processes: [server({ sockets: [] })] });
  assert.deepEqual(nobody.result, unreachable);
  assert.equal(nobody.calls.exec.some((call) => call.includes("cwd")), false, "the folder isn't read for a port nobody holds");
  assert.deepEqual((await check({ holderFails: true, processes: [server()] })).result, unreachable);
  assert.deepEqual((await check({ processes: [server({ cwd: `${WORKSPACE}/apps/admin` })] })).result, notInApp);
  assert.deepEqual(
    (await check({ processes: [server({ cwd: "/elsewhere" })], links: { [`${WORKSPACE}/apps/web`]: "/elsewhere" } })).result,
    notInApp,
    "an app root that's a link out of the workspace",
  );
  assert.deepEqual((await check({ owned: [10], processes: [server()] })).result, notInApp);
  assert.deepEqual((await check({ processes: [server()] }, { pid: 11 })).result, notInApp, "a stale pid");
  assert.deepEqual((await check({ processes: [server(), { pid: 11, ppid: 10, uid: 0, cwd: "/" }] })).result, notLoopback);
  assert.deepEqual((await check({ processes: [server(), { pid: 11, ppid: 10, cwd: "/", sockets: ["*:24000"] }] })).result, notLoopback);
  assert.deepEqual((await check({ processes: [server({ sockets: ["127.0.0.2:5173"] })] })).result, unreachable);
});

test("checkAttach gives the [::1] origin for a server on ::1 only", async () => {
  const { result } = await check({ processes: [server({ sockets: ["::1:5173"] })] });
  assert.deepEqual(result.ok && [result.origin, result.held], ["http://[::1]:5173", ["::1"]]);
});

test("neither the scan nor the check makes a network request or a name lookup", async (t) => {
  let calls = 0;
  const count = () => {
    calls += 1;
    throw new Error("no network");
  };
  t.mock.method(http, "request", count);
  t.mock.method(https, "request", count);
  t.mock.method(net, "connect", count);
  t.mock.method(dns, "lookup", count);
  const spec: World = { processes: [{ pid: 5, ppid: 1, cwd: "/Users/me" }, server()] };
  assert.equal((await scan(spec)).result.ok, true);
  assert.equal((await check(spec)).result.ok, true);
  assert.equal(calls, 0);
});

test("rebindHolder accepts a same-uid loopback holder under the old parent, and nothing else", () => {
  const rows = [
    { pid: 50, ppid: 1, pgid: 50, uid: ME }, // the runner (old parent)
    { pid: 61, ppid: 50, pgid: 50, uid: ME }, // the new server
    { pid: 70, ppid: 1, pgid: 70, uid: ME }, // elsewhere
  ];
  const sockets = new Map<number, Array<{ address: string; port: number }>>([
    [61, [{ address: "127.0.0.1", port: 5173 }]],
    [70, [{ address: "127.0.0.1", port: 5174 }]],
  ]);
  const of = (pid: number) => sockets.get(pid) ?? [];
  const input = { ppid: 50, uid: ME, port: 5173, held: ["127.0.0.1"] };
  assert.deepEqual(rebindHolder(rows, of, input), { pid: 61, ppid: 50 });
  assert.equal(rebindHolder(rows, of, { ...input, ppid: 70 }), undefined, "another parent");
  assert.equal(rebindHolder(rows, of, { ...input, ppid: 1 }), undefined, "never under init or launchd");
  assert.equal(rebindHolder(rows, of, { ...input, held: ["::1"] }), undefined, "another address");
  assert.equal(rebindHolder([...rows, { pid: 62, ppid: 61, pgid: 50, uid: 0 }], of, input), undefined, "another user's child");
  sockets.set(61, [{ address: "127.0.0.1", port: 5173 }, { address: "0.0.0.0", port: 24000 }]);
  assert.equal(rebindHolder(rows, of, input), undefined, "a wildcard in the new subtree");
});
