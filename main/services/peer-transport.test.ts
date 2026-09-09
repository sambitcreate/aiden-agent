import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOrCreateAidenRemoteTlsIdentity } from "./aiden-remote-tls-identity.js";
import { PeerTransport } from "./peer-transport.js";
import { decryptPeerPairing } from "./peer-pairing.js";
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
    /private connection/,
  );
  assert.throws(() =>
    peerOperationResult({ operation: "chat" }, { id: "missing-fields" }),
  );
});

test("real HTTPS verifies CA and SPKI, rejects redirects/oversized JSON, and parses chunked SSE", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-peer-test-"));
  const identity = await loadOrCreateAidenRemoteTlsIdentity({ directory });
  const pairingService = new AidenRemotePairingService("host_tls", {
    issueDevice: async (input) => ({
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
    }),
  });
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
    registry.close();
    await assert.rejects(
      new PeerTransport({
        ...trust,
        serverSpkiSha256: `sha256/${Buffer.alloc(32).toString("base64")}`,
      }).json({ path: "/server" }),
    );
    await assert.rejects(
      client.json({ path: "/redirect", credential: "a".repeat(43) }),
    );
    assert.equal(redirected, 0);
    await assert.rejects(client.json({ path: "/large" }));
    const frames: string[] = [];
    await client.events({ path: "/events" }, (frame) => frames.push(frame));
    assert.deepEqual(frames, ['id: 1\ndata: {"text":"hello"}']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
