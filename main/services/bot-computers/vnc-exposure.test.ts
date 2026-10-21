import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import test from "node:test";

import { vncReachableBeyondLoopback } from "./vnc-exposure.js";

async function listen(host: string): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.end("RFB 003.008\n");
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}

// 127.0.0.2 stands in for an external interface address: on Linux it reaches
// a wildcard listener but not one bound to 127.0.0.1 only.
const external: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  en0: [{ address: "127.0.0.2", netmask: "255.255.255.0", family: "IPv4", mac: "a6:4f:2c:9e:13:01", internal: false, cidr: "127.0.0.2/24" }],
};

test("a listener bound to every interface is reachable beyond loopback", async () => {
  const { server, port } = await listen("0.0.0.0");
  try {
    assert.equal(await vncReachableBeyondLoopback(port, { interfaces: external }), true);
  } finally {
    server.close();
  }
});

test("a loopback-only listener is not, and internal interfaces are never tried", async () => {
  const { server, port } = await listen("127.0.0.1");
  try {
    assert.equal(await vncReachableBeyondLoopback(port, { interfaces: external }), false);
    assert.equal(await vncReachableBeyondLoopback(port, { interfaces: { lo0: external.lo0 } }), false);
    assert.equal(await vncReachableBeyondLoopback(0, { interfaces: external }), false);
  } finally {
    server.close();
  }
});
