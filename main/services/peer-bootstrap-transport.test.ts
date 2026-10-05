import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import test from "node:test";
import { generatePairingRequestKeyPair } from "./aiden-remote-sealed-envelope.js";
import { PeerBootstrapTransport } from "./peer-bootstrap-transport.js";
import { startPeerTestHost } from "./peer-pairing-test-host.js";
import { PeerTransportError } from "./peer-transport.js";

async function rejection(promise: Promise<unknown>): Promise<PeerTransportError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PeerTransportError, String(error));
    return error;
  }
  assert.fail("expected the request to fail");
}

test("an unverified session pins the first key it sees and sends nothing to a different one", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const session = new PeerBootstrapTransport({
    endpoint: host.lanEndpoint,
    mode: "unverified",
  });
  assert.equal(session.observedSpki, undefined);
  const health = (await session.json({ path: "/health?detail=host" })) as Record<string, unknown>;
  assert.equal(health.instanceId, host.instanceId);
  assert.equal(session.observedSpki, host.serverSpkiSha256());

  await host.impersonate();
  const served = host.seen.length;
  const error = await rejection(
    session.json({
      method: "POST",
      path: "/pairing/requests",
      body: { deviceName: "Laptop", deviceType: "mac", publicKey: generatePairingRequestKeyPair().publicKey },
    }),
  );
  assert.equal(error.code, "identity_changed");
  assert.equal(host.seen.length, served, "the impersonating server received no request");
  assert.equal(host.requests.list().length, 0);
});

test("a WebPKI session requires a chain to a trusted root for the exact name", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const trusted = new PeerBootstrapTransport({
    endpoint: host.tailscaleEndpoint,
    mode: "webpki",
    ca: host.caPem,
  });
  const health = (await trusted.json({ path: "/health?detail=host" })) as Record<string, unknown>;
  assert.equal(health.pairingRequests, true);
  assert.equal(trusted.observedSpki, host.serverSpkiSha256());

  const untrusted = new PeerBootstrapTransport({
    endpoint: host.tailscaleEndpoint,
    mode: "webpki",
  });
  assert.equal((await rejection(untrusted.json({ path: "/health" }))).code, "identity_changed");
  assert.equal(untrusted.observedSpki, undefined);
});

test("pairing routes receive the poll secret, and refusals keep their code and retry hint", async (t) => {
  const host = await startPeerTestHost();
  t.after(() => host.close());
  const session = new PeerBootstrapTransport({ endpoint: host.lanEndpoint, mode: "unverified" });
  const create = () =>
    session.json({
      method: "POST",
      path: "/pairing/requests",
      body: { deviceName: "Laptop", deviceType: "mac", publicKey: generatePairingRequestKeyPair().publicKey },
    }) as Promise<{ requestId: string; pollSecret: string }>;
  const created = await create();

  const wrong = await rejection(
    session.json({ path: `/pairing/requests/${created.requestId}`, pairingSecret: "x".repeat(43) }),
  );
  assert.equal(wrong.status, 404);
  const cancelled = (await session.json({
    method: "DELETE",
    path: `/pairing/requests/${created.requestId}`,
    pairingSecret: created.pollSecret,
  })) as { state: string };
  assert.equal(cancelled.state, "cancelled");

  // The per-source limit answers 429 with a hint the client can show.
  let limited: PeerTransportError | undefined;
  for (let attempt = 0; attempt < 10 && !limited; attempt += 1) {
    try {
      await create();
    } catch (error) {
      assert.ok(error instanceof PeerTransportError);
      limited = error;
    }
  }
  assert.equal(limited?.remote?.code, "rate_limited");
  assert.ok((limited?.remote?.details?.retryAfterSeconds ?? 0) >= 1);

  // Request routes take no query, browser origin or protocol version; the
  // poll secret travels only in its header.
  const requestRoutes = host.received.filter(({ line }) => line.includes("/pairing/requests"));
  assert.ok(requestRoutes.length >= 3);
  for (const { line, headers } of requestRoutes) {
    assert.doesNotMatch(line, /\?/u);
    assert.equal(headers.origin, undefined);
    assert.equal(headers["aiden-protocol-version"], undefined);
    assert.doesNotMatch(line, new RegExp(created.pollSecret, "u"));
  }
  assert.equal(
    requestRoutes.filter(({ headers }) => headers["aiden-pairing-secret"] === created.pollSecret).length,
    1,
  );
});

test("an aborted request settles at once", async (t) => {
  const host = await startPeerTestHost({ pollTimeoutMs: 5_000 });
  t.after(() => host.close());
  const session = new PeerBootstrapTransport({ endpoint: host.lanEndpoint, mode: "unverified" });
  const created = (await session.json({
    method: "POST",
    path: "/pairing/requests",
    body: { deviceName: "Laptop", deviceType: "mac", publicKey: generatePairingRequestKeyPair().publicKey },
  })) as { requestId: string; pollSecret: string };
  const controller = new AbortController();
  const started = Date.now();
  const poll = session.json({
    path: `/pairing/requests/${created.requestId}`,
    pairingSecret: created.pollSecret,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  assert.equal((await rejection(poll)).code, "unavailable");
  assert.ok(Date.now() - started < 2_000);
});

/** A TCP listener that takes the ClientHello and never answers it. */
async function startStalledHandshake(): Promise<{
  endpoint: string;
  open(): number;
  closed(): Promise<void>;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let waiters: (() => void)[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => undefined);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        for (const wake of waiters) wake();
        waiters = [];
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `https://127.0.0.1:${port}/api/aiden/v1`,
    open: () => sockets.size,
    closed: () => (sockets.size === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function settlesWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a timed-out or cancelled request closes a connection stuck in the TLS handshake", async (t) => {
  const peer = await startStalledHandshake();
  t.after(() => peer.close());
  const session = new PeerBootstrapTransport({ endpoint: peer.endpoint, mode: "unverified" });

  assert.equal((await rejection(session.json({ path: "/health", timeoutMs: 100 }))).code, "unavailable");
  await settlesWithin(peer.closed(), 1_000, "closing the timed-out connection");

  const controller = new AbortController();
  const request = session.json({ path: "/health", signal: controller.signal });
  while (peer.open() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  assert.equal((await rejection(request)).code, "unavailable");
  await settlesWithin(peer.closed(), 1_000, "closing the cancelled connection");
  assert.equal(session.observedSpki, undefined);
});
