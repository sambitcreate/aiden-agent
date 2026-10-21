import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import process from "node:process";
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

/**
 * An address of this machine that a wildcard listener answers on and a
 * 127.0.0.1-only one doesn't: one of its own interface addresses, else on
 * Linux 127.0.0.2, which the whole 127/8 loopback net answers. macOS keeps
 * only 127.0.0.1 on lo0, so there it must be a real interface.
 */
function externalAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4") return entry.address;
    }
  }
  return process.platform === "linux" ? "127.0.0.2" : undefined;
}

const loopback: NetworkInterfaceInfo[] = [
  { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
];
const address = externalAddress();
const external: NodeJS.Dict<NetworkInterfaceInfo[]> | undefined =
  address === undefined
    ? undefined
    : {
        lo0: loopback,
        en0: [{ address, netmask: "255.255.255.0", family: "IPv4", mac: "a6:4f:2c:9e:13:01", internal: false, cidr: `${address}/24` }],
      };
const noAddress = external === undefined ? "this machine has no address beyond loopback to try" : false;

test("a listener bound to every interface is reachable beyond loopback", { skip: noAddress }, async () => {
  const { server, port } = await listen("0.0.0.0");
  try {
    assert.equal(await vncReachableBeyondLoopback(port, { interfaces: external }), true);
  } finally {
    server.close();
  }
});

test("a loopback-only listener is not, and internal interfaces are never tried", { skip: noAddress }, async () => {
  const { server, port } = await listen("127.0.0.1");
  try {
    assert.equal(await vncReachableBeyondLoopback(port, { interfaces: external }), false);
    assert.equal(await vncReachableBeyondLoopback(port, { interfaces: { lo0: loopback } }), false);
    assert.equal(await vncReachableBeyondLoopback(0, { interfaces: external }), false);
  } finally {
    server.close();
  }
});
