import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import test from "node:test";
import { chooseAppPort, defaultPortProbe } from "./app-ports.js";

async function listen(host: string, port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => resolve());
  });
  return { server, port: (server.address() as { port: number }).port };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function freePort(): Promise<number> {
  const { server, port } = await listen("127.0.0.1");
  await close(server);
  return port;
}

async function hasIPv6Loopback(): Promise<boolean> {
  try {
    const { server } = await listen("::1");
    await close(server);
    return true;
  } catch {
    return false;
  }
}

test("the sticky port is used when free", async () => {
  const sticky = await freePort();
  assert.equal(await chooseAppPort({ sticky, fallback: 1 }), sticky);
});

test("a sticky port in use falls back to the framework default, then to an OS port", async (t) => {
  const taken = await listen("127.0.0.1");
  t.after(() => close(taken.server));
  const fallback = await freePort();
  assert.equal(await chooseAppPort({ sticky: taken.port, fallback }), fallback);
  const alsoTaken = await listen("127.0.0.1");
  t.after(() => close(alsoTaken.server));
  const chosen = await chooseAppPort({ sticky: taken.port, fallback: alsoTaken.port });
  assert.notEqual(chosen, taken.port);
  assert.notEqual(chosen, alsoTaken.port);
  assert.ok(chosen > 0 && chosen < 65_536);
  assert.equal(await defaultPortProbe(chosen), true);
});

test("a port held on the wildcard address counts as in use", async (t) => {
  const wildcard = await listen("0.0.0.0");
  t.after(() => close(wildcard.server));
  assert.equal(await defaultPortProbe(wildcard.port), false);
  assert.notEqual(await chooseAppPort({ fallback: wildcard.port }), wildcard.port);
});

test("a port held on ::1 only counts as in use", async (t) => {
  if (!(await hasIPv6Loopback())) {
    t.skip("this host has no IPv6 loopback");
    return;
  }
  const v6 = await listen("::1");
  t.after(() => close(v6.server));
  assert.equal(await defaultPortProbe(v6.port), false);
});

test("the probe finishes within a second when nothing answers", async () => {
  const port = await freePort();
  const started = Date.now();
  assert.equal(await defaultPortProbe(port), true);
  assert.ok(Date.now() - started < 1_000, `${Date.now() - started} ms`);
});
