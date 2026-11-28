import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { isPrivateIpAddress } from "../../renderer/shared/scheduled-task-trigger.js";
import { fetchBotWatchUrl } from "./bot-routine-events/watch-sources.js";
import { createPublicOnlyFetch } from "./public-only-fetch.js";

async function localServer(t: test.TestContext) {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.end("status: ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

const resolvesTo =
  (...addresses: string[]) =>
  (
    _host: string,
    callback: (error: null, found: Array<{ address: string; family: number }>) => void,
  ) =>
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );

test("a watch Aiden proposed refuses a name that resolves to this computer or a private network, before connecting", async (t) => {
  const server = await localServer(t);
  for (const addresses of [
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["93.184.215.14", "192.168.1.20"],
    ["::ffff:10.0.0.1"],
    ["fe80::1"],
  ]) {
    const fetch = createPublicOnlyFetch({ resolve: resolvesTo(...addresses) });
    const check = await fetchBotWatchUrl("https://status.example.com/", { fetch });
    assert.equal(check.ok, false, addresses.join(", "));
    assert.match(
      !check.ok ? check.error : "",
      /status\.example\.com points at this computer or a private network/u,
    );
  }
  const literal = await fetchBotWatchUrl(`https://[::ffff:7f00:1]:${server.port}/`, {
    fetch: createPublicOnlyFetch({ resolve: resolvesTo("93.184.215.14") }),
  });
  assert.equal(literal.ok, false, "an IP literal is checked without a lookup");
  assert.equal(server.hits(), 0, "nothing ever reached the private address");
});

test("the connection goes to the address that was checked, not to a second lookup", async (t) => {
  const server = await localServer(t);
  // The resolver is the only way this made-up name reaches the local server;
  // here it counts as public, so the request is allowed and connects there.
  const fetch = createPublicOnlyFetch({ resolve: resolvesTo("127.0.0.1"), isPrivate: () => false });
  const response = await fetch(`http://watch.example.test:${server.port}/status`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "status: ok");
  assert.equal(server.hits(), 1);
});

test("resolved addresses are judged like address literals", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.8",
    "172.20.1.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "192.0.0.8",
    "224.0.0.1",
    "255.255.255.255",
    "0.0.0.0",
    "::1",
    "::",
    "::ffff:192.168.1.1",
    "::7f00:1",
    "64:ff9b::a00:1",
    "fd00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }
  for (const address of [
    "93.184.215.14",
    "8.8.8.8",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ]) {
    assert.equal(isPrivateIpAddress(address), false, address);
  }
});
