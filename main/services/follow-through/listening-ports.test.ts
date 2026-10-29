import assert from "node:assert/strict";
import test from "node:test";
import { parseLsofListening, parseProcNetTcp } from "./listening-ports.js";

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

test("lsof's name lines give the port after the last colon, IPv4 and IPv6 alike", () => {
  assert.deepEqual(parseLsofListening("p4242\nf23\nn*:5173\nf24\nn[::1]:24678\nf25\nn127.0.0.1:3000\n"), [5173, 24678, 3000]);
  assert.deepEqual(parseLsofListening(""), []);
});
