import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  aidenLoopbackPorts,
  createAidenLoopbackPortsForTest,
  registerListeningPort,
  registerLoopbackUrlPort,
} from "./loopback-ports.ts";

test("ports are added, held per holder, and removed", () => {
  const ports = createAidenLoopbackPortsForTest();
  ports.add(5000);
  ports.add(5000);
  ports.add(6000);
  assert.deepEqual([...ports.snapshot()].sort(), [5000, 6000]);
  ports.delete(5000);
  assert.equal(ports.has(5000), true, "a second holder keeps it");
  ports.delete(5000);
  assert.equal(ports.has(5000), false);
  ports.add(0);
  ports.add(70_000);
  ports.add(1.5);
  assert.deepEqual([...ports.snapshot()], [6000]);
});

test("registerListeningPort registers a listening server's port until it is removed", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const remove = registerListeningPort(server);
  assert.equal(aidenLoopbackPorts.has(port), true);
  remove();
  remove();
  assert.equal(aidenLoopbackPorts.has(port), false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.doesNotThrow(() => registerListeningPort({ address: () => null })());
});

test("an updater feed URL on loopback registers its port, and nothing else does", () => {
  const remove = registerLoopbackUrlPort(() => "http://127.0.0.1:61234");
  assert.equal(aidenLoopbackPorts.has(61_234), true);
  remove();
  assert.equal(aidenLoopbackPorts.has(61_234), false);

  for (const feed of ["https://updates.example.com/feed", "http://10.0.0.2:61235", "http://127.0.0.1", "not a url", ""]) {
    registerLoopbackUrlPort(() => feed);
  }
  assert.equal(aidenLoopbackPorts.has(61_235), false);
  assert.deepEqual([...aidenLoopbackPorts.snapshot()].filter((port) => port === 80 || port === 443), []);
  assert.doesNotThrow(() =>
    registerLoopbackUrlPort(() => {
      throw new Error("no native updater on this platform");
    })(),
  );
});

test("an updater feed on localhost or [::1] registers too", () => {
  const removals = [
    registerLoopbackUrlPort(() => "http://localhost:61236/"),
    registerLoopbackUrlPort(() => "http://[::1]:61237/"),
  ];
  assert.equal(aidenLoopbackPorts.has(61_236), true);
  assert.equal(aidenLoopbackPorts.has(61_237), true);
  for (const remove of removals) remove();
  assert.equal(aidenLoopbackPorts.has(61_236), false);
  assert.equal(aidenLoopbackPorts.has(61_237), false);
});
