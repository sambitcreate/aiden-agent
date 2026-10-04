import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import type { ServerResponse } from "node:http";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOrCreateAidenRemoteTlsIdentity } from "./aiden-remote-tls-identity.js";
import {
  PeerTransport,
  PeerEventFrames,
  PeerTransportError,
  MAX_PEER_UPLOAD_BYTES,
} from "./peer-transport.js";
import { decryptPeerPairing, assertPeerPairingExpiry } from "./peer-pairing.js";
import { peerOperationRequest, peerOperationResult } from "./peer-operation.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import { AidenRemotePairingService } from "./aiden-remote-pairing.js";
import { PeerHostRegistry, type StoredPeerHost } from "./peer-host-registry.js";

test("desktop manual pairing consumes the native clients' canonical cryptographic vector", async () => {
  const vector = JSON.parse(
    await readFile(
      new URL(
        "../../protocol/aiden-remote/v1/fixtures/manual-pairing-vector.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const envelope = vector.bootstrap;
  const endpoint = JSON.parse(vector.payload).bootstrap.endpoint;
  const decoded = decryptPeerPairing(
    envelope,
    vector.code,
    endpoint,
    Date.parse(envelope.expiresAt) - 1000,
  );
  assert.equal(decoded.endpoint, endpoint);
  assert.throws(() =>
    decryptPeerPairing(envelope, "0000-0000-0000-0000-0000", endpoint),
  );
});

test("closed peer operations reject injected routes and require mutation identity", () => {
  for (const operation of ["cancel", "respondApproval"]) {
    assert.throws(() =>
      peerOperationRequest({ operation, resourceId: "resource" }),
    );
    assert.equal(
      peerOperationRequest({
        operation,
        resourceId: "resource",
        idempotencyKey: "k".repeat(32),
      }).idempotencyKey,
      "k".repeat(32),
    );
  }
  assert.throws(() =>
    peerOperationRequest({ operation: "send", resourceId: "chat" }),
  );
  assert.throws(() =>
    peerOperationRequest({ operation: "server", path: "/secrets" }),
  );
  assert.throws(() => peerOperationRequest({ operation: "unknown" }));
  assert.deepEqual(
    peerOperationRequest({
      operation: "file",
      workspaceId: "work",
      resourceId: "file_handle",
    }),
    { method: "GET", path: "/workspaces/work/files/file_handle" },
  );
  assert.throws(
    () =>
      peerOperationResult(
        { operation: "server" },
        { nested: { credential: "secret" } },
      ),
    /response contract/,
  );
  assert.throws(() =>
    peerOperationResult({ operation: "chat" }, { id: "missing-fields" }),
  );
});

test("real HTTPS verifies CA and SPKI, rejects redirects/oversized JSON, and parses chunked SSE", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-peer-test-"));
  const identity = await loadOrCreateAidenRemoteTlsIdentity({ directory });
  const issuedCapabilities: string[][] = [];
  const pairingService = new AidenRemotePairingService(
    "host_tls",
    {
      issueDevice: async (input) => {
        issuedCapabilities.push([...input.capabilities!]);
        return {
          credential: "a".repeat(43),
          device: {
            id: "device_tls",
            name: input.name,
            type: input.type,
            clientVersion: input.clientVersion,
            capabilities: [...input.capabilities!],
            createdAt: Date.now(),
            lastSeenAt: 0,
          },
        };
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    () => true,
  );
  const actualRouter = createAidenRemoteRequestHandler({
    instanceId: "host_tls",
    displayName: () => "TLS fixture",
    appVersion: "1",
    pairing: pairingService,
    devices: {
      acquireDeviceAuthorization: () => () => undefined,
      authenticate: async (credential) =>
        credential === "a".repeat(43)
          ? {
              id: "device_tls",
              name: "Desktop",
              revoked: false,
              acceptsBotCapabilities: false,
              capabilities: new Set(["server:read"]),
            }
          : null,
    },
    connectionMode: () => "lan",
    now: Date.now,
    log: () => undefined,
  });
  let redirected = 0;
  let liveResponse: ServerResponse | undefined;
  let slowResponse: ServerResponse | undefined;
  let slowArrived!: () => void;
  const slowRequested = new Promise<void>((resolve) => {
    slowArrived = resolve;
  });
  const server = https.createServer(
    { key: identity.privateKey, cert: identity.certificateChain },
    (request, response) => {
      if (
        request.url?.endsWith("/pairing/exchange") ||
        request.url?.endsWith("/server")
      ) {
        void actualRouter(request, response);
        return;
      }
      if (request.url?.endsWith("/redirect")) {
        response.writeHead(302, { Location: "/target" });
        response.end();
        return;
      }
      if (request.url === "/target") redirected++;
      if (request.url?.endsWith("/slow-open")) {
        // Headers wait until the test sends them.
        slowResponse = response;
        slowArrived();
        return;
      }
      if (request.url?.endsWith("/live")) {
        liveResponse = response;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("data: start\n\n");
        return;
      }
      if (request.url?.endsWith("/denied")) {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "capability_denied",
              message: "No.",
              retryable: false,
            },
          }),
        );
        return;
      }
      if (request.url?.endsWith("/revoked")) {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "credential_revoked",
              message: "No.",
              retryable: false,
            },
          }),
        );
        return;
      }
      if (request.url?.endsWith("/resume")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${request.headers["last-event-id"] ?? "none"}\n\n`);
        return;
      }
      if (request.url?.endsWith("/upload")) {
        let received = 0;
        request.on("data", (chunk: Buffer) => {
          received += chunk.length;
        });
        request.on("end", () => {
          response.writeHead(201, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ received }));
        });
        return;
      }
      if (request.url?.endsWith("/events")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(': hello\n\nid: 1\ndata: {"text":');
        response.end('"hello"}\n\n');
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        request.url?.endsWith("/large")
          ? JSON.stringify({ text: "a".repeat(1_048_576) })
          : '{"ok":true}',
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const trust = {
    endpoint: `https://127.0.0.1:${address.port}/api/aiden/v1`,
    serverSpkiSha256: identity.serverSpkiSha256,
    caCertificateDerBase64: new X509Certificate(
      identity.caCertificate,
    ).raw.toString("base64"),
  };
  try {
    const client = new PeerTransport(trust);
    assert.equal(
      (
        (await client.json({
          path: "/server",
          credential: "a".repeat(43),
        })) as { name: string }
      ).name,
      "TLS fixture",
    );
    let savedHosts: StoredPeerHost[] = [];
    const registry = new PeerHostRegistry({
      storage: {
        load: async () => [],
        save: async (hosts) => {
          savedHosts = hosts;
        },
      },
      localInstanceId: async () => "different_local_host",
      deviceName: "Desktop",
      clientVersion: "1",
      platform: "mac",
    });
    const opened = pairingService.begin(trust.endpoint, trust.serverSpkiSha256);
    const view = await registry.pair({ ...trust, ...opened.bootstrap });
    assert.equal(view.id, "host_tls");
    assert.equal(savedHosts.length, 1);
    assert.equal(view.state, "connected");
    // A desktop controller opts into the host-wide run vocabulary at pairing.
    for (const capability of ["host:events", "runs:observe", "runs:control"]) {
      assert.ok(issuedCapabilities[0]!.includes(capability), capability);
    }
    registry.close();
    // A pin mismatch is an identity change, never mere unavailability.
    await assert.rejects(
      new PeerTransport({
        ...trust,
        serverSpkiSha256: `sha256/${Buffer.alloc(32).toString("base64")}`,
      }).json({ path: "/server" }),
      (error: unknown) =>
        error instanceof PeerTransportError && error.code === "identity_changed",
    );
    // Envelope codes separate an answered per-operation refusal from a revoked credential.
    await assert.rejects(
      client.json({ path: "/denied", credential: "a".repeat(43) }),
      (error: unknown) =>
        error instanceof PeerTransportError &&
        error.code === "request_failed" &&
        error.status === 403 &&
        error.remote?.code === "capability_denied",
    );
    await assert.rejects(
      client.json({ path: "/revoked", credential: "a".repeat(43) }),
      (error: unknown) =>
        error instanceof PeerTransportError &&
        error.code === "authentication_required" &&
        error.remote?.code === "credential_revoked",
    );
    const resumed: string[] = [];
    const openedAt: number[] = [];
    assert.deepEqual(
      await client.events(
        {
          path: "/resume",
          lastEventId: "epoch_1:41",
          onOpen: () => openedAt.push(resumed.length),
        },
        (frame) => resumed.push(frame),
      ),
      { reason: "eof" },
    );
    assert.deepEqual(resumed, ["data: epoch_1:41"]);
    // The accepted-stream signal precedes every frame; a refused stream never opens.
    assert.deepEqual(openedAt, [0]);
    await assert.rejects(
      client.events({ path: "/denied", onOpen: () => openedAt.push(-1) }, () => {}),
    );
    assert.deepEqual(openedAt, [0]);
    await assert.rejects(
      client.events({ path: "/resume", lastEventId: "bad\nid" }, () => {}),
    );
    await assert.rejects(
      client.json({ path: "/redirect", credential: "a".repeat(43) }),
    );
    assert.equal(redirected, 0);
    await assert.rejects(client.json({ path: "/large" }));
    // A request body over 1 MiB leaves only where the operation allows an
    // upload, and never past the upload ceiling, whatever the caller asks for.
    const upload = { data: "a".repeat(2 * 1_048_576) };
    await assert.rejects(
      client.json({ method: "POST", path: "/upload", body: upload }),
      /too large/u,
    );
    const accepted = (await client.json({
      method: "POST",
      path: "/upload",
      body: upload,
      maxBodyBytes: MAX_PEER_UPLOAD_BYTES,
    })) as { received: number };
    assert.equal(accepted.received, Buffer.byteLength(JSON.stringify(upload)));
    await assert.rejects(
      client.json({
        method: "POST",
        path: "/upload",
        body: { data: "a".repeat(MAX_PEER_UPLOAD_BYTES) },
        maxBodyBytes: Number.MAX_SAFE_INTEGER,
      }),
      /too large/u,
    );
    const frames: string[] = [];
    await client.events({ path: "/events" }, (frame) => frames.push(frame));
    assert.deepEqual(frames, ['id: 1\ndata: {"text":"hello"}']);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let received!: () => void;
    let nextFrame = new Promise<void>((resolve) => {
      received = resolve;
    });
    const live = client.events({ path: "/live" }, () => received());
    await nextFrame;
    // Completed frames keep the frame deadline alive, but cannot extend the session cap;
    // reaching the cap is a resumable outcome, not an error.
    for (let i = 0; i < 14; i++) {
      t.mock.timers.tick(20_000);
      nextFrame = new Promise<void>((resolve) => {
        received = resolve;
      });
      liveResponse!.write("data: pulse\n\n");
      await nextFrame;
    }
    t.mock.timers.tick(20_000);
    assert.deepEqual(await live, { reason: "capped" });
    // Even a peer that has sent headers and one valid frame must finish its next frame.
    nextFrame = new Promise<void>((resolve) => {
      received = resolve;
    });
    const stalled = client.events({ path: "/live" }, () => received());
    const stalledRejected = assert.rejects(stalled);
    await nextFrame;
    liveResponse!.write("data: partial");
    t.mock.timers.tick(30_000);
    await stalledRejected;
    // A slow connect does not eat into the quiet time allowed before the first frame.
    let slowOpened!: () => void;
    const openedNow = new Promise<void>((resolve) => {
      slowOpened = resolve;
    });
    nextFrame = new Promise<void>((resolve) => {
      received = resolve;
    });
    const slow = client.events({ path: "/slow-open", onOpen: () => slowOpened() }, () => received());
    // An early abort surfaces as the stream's rejection rather than a hang.
    const unlessEnded = (step: Promise<void>) => Promise.race([step, slow.then(() => {})]);
    await slowRequested;
    t.mock.timers.tick(25_000);
    slowResponse!.writeHead(200, { "Content-Type": "text/event-stream" });
    slowResponse!.flushHeaders();
    await unlessEnded(openedNow);
    t.mock.timers.tick(20_000);
    slowResponse!.write("data: first\n\n");
    await unlessEnded(nextFrame);
    slowResponse!.end();
    assert.deepEqual(await slow, { reason: "eof" });
    t.mock.timers.reset();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "SSE one-byte trickles and heartbeat floods have bounded work and size",
  { timeout: 5000 },
  () => {
    const parser = new PeerEventFrames();
    const one = Buffer.from("a");
    for (let i = 0; i < 1_048_576; i++)
      parser.push(
        one,
        () => {},
        () => {},
      );
    assert.throws(
      () =>
        parser.push(
          Buffer.from("aaaaa"),
          () => {},
          () => {},
        ),
      /large/,
    );
    const flood = new PeerEventFrames();
    let boundaries = 0;
    assert.throws(
      () =>
        flood.push(
          Buffer.from(": ping\n\n".repeat(16_385)),
          () => {
            throw new Error("Heartbeat emitted");
          },
          () => {
            boundaries++;
          },
        ),
      /budget/,
    );
    assert.equal(boundaries, 16_384);
    // A long-lived feed keeps going: committed frames release the rolling budget.
    const feed = new PeerEventFrames();
    const committed = Buffer.from(
      `id: e:1\ndata: ${"x".repeat(1000)}\n\n`.repeat(1024),
    );
    let delivered = 0;
    for (let round = 0; round < 24; round++)
      feed.push(
        committed,
        () => delivered++,
        () => {},
      );
    assert.equal(delivered, 24 * 1024);
    const uncommitted = new PeerEventFrames();
    assert.throws(
      () =>
        uncommitted.push(
          Buffer.from(`data: ${"x".repeat(1000)}\n\n`.repeat(17 * 1024)),
          () => {},
          () => {},
        ),
      /budget/,
    );
    const split = new PeerEventFrames();
    const frames: string[] = [];
    for (const byte of Buffer.from("data: ☃\r\n\r\n"))
      split.push(
        Buffer.from([byte]),
        (frame) => frames.push(frame),
        () => {},
      );
    split.end();
    assert.deepEqual(frames, ["data: ☃"]);
  },
);

test("pairing tolerates bounded skew but rejects nonsense expiry", () => {
  const now = Date.now();
  for (const delta of [-120_000, 0, 300_000, 420_000])
    assertPeerPairingExpiry(new Date(now + delta).toISOString(), now);
  for (const delta of [-120_001, 420_001])
    assert.throws(() =>
      assertPeerPairingExpiry(new Date(now + delta).toISOString(), now),
    );
  assert.throws(() => assertPeerPairingExpiry("nonsense", now));
});

test("every exposed operation rejects malformed DTOs and preserves legitimate content", () => {
  const operations = [
    "server",
    "summaries",
    "workspaces",
    "models",
    "chat",
    "roots",
    "children",
    "stream",
    "approval",
    "files",
    "file",
    "git",
    "createChat",
    "send",
    "renameChat",
    "deleteChat",
    "cancel",
    "respondApproval",
    "selectFolder",
    "createWorkspace",
  ];
  for (const operation of operations)
    assert.throws(() => peerOperationResult({ operation }, {}), operation);
  const models = {
    providers: [],
    defaults: { secret: "model-id", headers: "another-model" },
  };
  assert.deepEqual(
    peerOperationResult({ operation: "models" }, models),
    models,
  );
  assert.deepEqual(
    peerOperationResult({ operation: "approval" }, { approval: null }),
    { approval: null },
  );
  assert.throws(() =>
    peerOperationResult(
      { operation: "approval" },
      { approval: null, credential: "private" },
    ),
  );
  assert.equal(
    peerOperationResult({ operation: "deleteChat" }, undefined),
    undefined,
  );
});
