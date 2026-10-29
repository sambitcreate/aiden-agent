import assert from "node:assert/strict";
import test from "node:test";
import { defaultListeningPorts, parseLsofListening, parseProcNetTcp, portsOfProcesses } from "./listening-ports.js";

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
