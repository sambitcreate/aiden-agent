import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { AidenRemotePairingService } from "./aiden-remote-pairing.js";
import {
  AidenRemotePairingRequestService,
  type AidenPairingRequestTransport,
} from "./aiden-remote-pairing-requests.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import {
  generatePairingRequestKeyPair,
  pairingRequestCommitment,
  pairingRequestMatchCode,
} from "./aiden-remote-sealed-envelope.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  type AidenRemoteStateDocument,
} from "./aiden-remote-state.js";
import { openPeerPairingRequestGrant } from "./peer-pairing.js";

const SPKI = `sha256/${Buffer.alloc(32, 5).toString("base64")}`;
const LAN_ENDPOINT = "https://studio.local:47123/api/aiden/v1";
const TAILSCALE_ENDPOINT = "https://studio.example-tailnet.ts.net/api/aiden/v1";

async function host(options: { wired?: boolean; acceptStrippedBasePath?: boolean } = {}) {
  let stored: AidenRemoteStateDocument = createDefaultAidenRemoteState(() => Buffer.alloc(24, 3));
  const registry = new AidenRemoteStateRegistry(
    {
      load: async () => structuredClone(stored),
      save: async (document) => {
        stored = structuredClone(document);
      },
    },
    {
      now: Date.now,
      randomBytes,
      deriveCredentialDigest: async (credential, salt) =>
        createHash("sha256").update(credential).update(salt).digest(),
    },
  );
  let accepting = true;
  const transports: AidenPairingRequestTransport[] = [];
  const requests = new AidenRemotePairingRequestService({
    instanceId: stored.instanceId,
    devices: registry,
    accepting: () => accepting,
    resolveTransport: async (transport) => {
      transports.push(transport);
      return transport === "lan"
        ? { endpoint: LAN_ENDPOINT, serverSpkiSha256: SPKI, trust: { mode: "system" } }
        : { endpoint: TAILSCALE_ENDPOINT, serverSpkiSha256: SPKI, trust: { mode: "system" } };
    },
    displayName: () => "Studio Mac",
    botCapabilitiesSupported: () => true,
    hostCapabilitiesSupported: () => true,
    pollTimeoutMs: 2_000,
  });
  const logs: Array<{ route: string; routePath?: string; status: number }> = [];
  const handler = createAidenRemoteRequestHandler({
    instanceId: stored.instanceId,
    displayName: () => "Studio Mac",
    appVersion: "0.52.0",
    devices: registry,
    pairing: new AidenRemotePairingService(
      stored.instanceId,
      registry,
      undefined,
      undefined,
      undefined,
      () => true,
      () => true,
    ),
    ...(options.wired === false ? {} : { pairingRequests: requests }),
    platform: "mac",
    connectionMode: () => "both",
    now: Date.now,
    acceptStrippedBasePath: options.acceptStrippedBasePath === true,
    log: (entry) => logs.push(entry),
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const prefix = options.acceptStrippedBasePath ? "" : "/api/aiden/v1";
  return {
    base: `http://127.0.0.1:${address.port}${prefix}`,
    requests,
    registry,
    logs,
    transports,
    setAccepting: (value: boolean) => {
      accepting = value;
    },
    close: async () => {
      await requests.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function errorOf(response: Response): Promise<{ code: string; retryable: boolean; details?: Record<string, unknown> }> {
  return ((await response.json()) as { error: { code: string; retryable: boolean; details?: Record<string, unknown> } }).error;
}

test("an approved request round-trips over HTTP and its credential authenticates /server", async () => {
  const app = await host();
  try {
    const health = await (await fetch(`${app.base}/health?detail=host`)).json();
    assert.equal(health.pairingRequests, true);

    const keys = generatePairingRequestKeyPair();
    const createdResponse = await fetch(
      `${app.base}/pairing/requests`,
      json({ deviceName: "Travel MacBook", deviceType: "mac", publicKey: keys.publicKey, clientVersion: "0.52.0" }),
    );
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.deepEqual(Object.keys(created).sort(), ["expiresAt", "hostCommitment", "pollSecret", "requestId"]);
    assert.deepEqual(app.transports, ["lan"]);
    const secretHeader = { "aiden-pairing-secret": created.pollSecret };

    const requesterNonce = randomBytes(32);
    const revealed = await fetch(
      `${app.base}/pairing/requests/${created.requestId}/reveal`,
      json({ requesterNonce: requesterNonce.toString("base64url") }, secretHeader),
    );
    assert.equal(revealed.status, 200);
    const { hostNonce } = await revealed.json();
    assert.equal(pairingRequestCommitment(created.requestId, hostNonce), created.hostCommitment);
    const matchCode = pairingRequestMatchCode({
      requesterPublicKey: keys.publicKey,
      serverSpkiSha256: SPKI,
      requestId: created.requestId,
      requesterNonce,
      hostNonce,
    });
    assert.equal(app.requests.list()[0]?.matchCode, matchCode);

    const polling = fetch(`${app.base}/pairing/requests/${created.requestId}`, { headers: secretHeader });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await app.requests.respond(created.requestId, "allow"))?.state, "approved");
    const pollResponse = await polling;
    assert.equal(pollResponse.status, 200);
    const status = await pollResponse.json();
    assert.equal(status.state, "approved");

    const grant = openPeerPairingRequestGrant(status.envelope, {
      requestId: created.requestId,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      endpoint: LAN_ENDPOINT,
      serverSpkiSha256: SPKI,
    });
    const server = await fetch(`${app.base}/server`, {
      headers: { authorization: `Bearer ${grant.credential}`, "aiden-protocol-version": "1" },
    });
    assert.equal(server.status, 200);
    const projection = await server.json();
    assert.equal(projection.instanceId, grant.instanceId);
    assert.equal(projection.deviceName, "Travel MacBook");
    assert.ok(projection.capabilities.includes("runs:control"));
    assert.ok(projection.features.includes("pairing-requests-v1"));

    // Request logs carry the route template, never the request id.
    const requestLogs = app.logs.filter((entry) => entry.route.startsWith("pairingRequest"));
    assert.ok(requestLogs.length >= 3);
    for (const entry of requestLogs) {
      assert.equal(JSON.stringify(entry).includes(created.requestId), false);
    }
    assert.ok(requestLogs.some((entry) => entry.routePath === "/pairing/requests/:requestId/reveal"));
  } finally {
    await app.close();
  }
});

test("request routes refuse phones, browsers, bad secrets and a closed host with stable errors", async () => {
  const app = await host();
  try {
    const publicKey = generatePairingRequestKeyPair().publicKey;
    const phone = await fetch(
      `${app.base}/pairing/requests`,
      json({ deviceName: "iPhone", deviceType: "iphone", publicKey }),
    );
    assert.equal(phone.status, 403);
    assert.equal((await errorOf(phone)).code, "capability_denied");

    const browser = await fetch(`${app.base}/pairing/requests`, {
      ...json({ deviceName: "Mac", deviceType: "mac", publicKey }),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
    });
    assert.equal(browser.status, 403);

    const created = await (
      await fetch(`${app.base}/pairing/requests`, json({ deviceName: "Mac", deviceType: "linux", publicKey }))
    ).json();
    const wrongSecrets: Array<Record<string, string>> = [{}, { "aiden-pairing-secret": randomBytes(32).toString("base64url") }];
    for (const headers of wrongSecrets) {
      const poll = await fetch(`${app.base}/pairing/requests/${created.requestId}`, { headers });
      assert.equal(poll.status, 404);
      assert.equal((await errorOf(poll)).code, "not_found");
    }
    const secretHeader = { "aiden-pairing-secret": created.pollSecret };
    for (const path of [
      "/pairing/requests/not-a-request-id",
      `/pairing/requests/${created.requestId}/approve`,
      `/pairing/requests/${created.requestId}?secret=${created.pollSecret}`,
    ]) {
      const response = await fetch(`${app.base}${path}`, { headers: secretHeader });
      assert.ok([400, 404].includes(response.status), path);
    }
    const listAll = await fetch(`${app.base}/pairing/requests`);
    assert.equal(listAll.status, 404);

    const cancelled = await fetch(`${app.base}/pairing/requests/${created.requestId}`, {
      method: "DELETE",
      headers: secretHeader,
    });
    assert.deepEqual(await cancelled.json(), { requestId: created.requestId, state: "cancelled" });
    const after = await (await fetch(`${app.base}/pairing/requests/${created.requestId}`, { headers: secretHeader })).json();
    assert.equal(after.state, "cancelled");
    assert.equal("envelope" in after, false);

    app.setAccepting(false);
    assert.equal((await (await fetch(`${app.base}/health?detail=host`)).json()).pairingRequests, false);
    const refused = await fetch(
      `${app.base}/pairing/requests`,
      json({ deviceName: "Mac", deviceType: "mac", publicKey }),
    );
    assert.equal(refused.status, 403);
    assert.equal((await errorOf(refused)).code, "pairing_closed");
  } finally {
    await app.close();
  }
});

test("admission limits are reported as retryable with a retry delay", async () => {
  const app = await host();
  try {
    const publicKey = generatePairingRequestKeyPair().publicKey;
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof errorOf>> | undefined;
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(
        `${app.base}/pairing/requests`,
        json({ deviceName: "Mac", deviceType: "mac", publicKey }),
      );
      statuses.push(response.status);
      if (response.status === 429) limited = await errorOf(response);
      else await response.arrayBuffer();
    }
    assert.deepEqual(statuses.slice(0, 2), [201, 201]);
    assert.equal(statuses[statuses.length - 1], 429);
    assert.equal(limited?.code, "rate_limited");
    assert.equal(limited?.retryable, true);
    assert.equal(typeof limited?.details?.retryAfterSeconds, "number");
  } finally {
    await app.close();
  }
});

test("requests through Tailscale Serve resolve the Tailscale identity", async () => {
  const app = await host({ acceptStrippedBasePath: true });
  try {
    const response = await fetch(
      `${app.base}/pairing/requests`,
      json({ deviceName: "Mac", deviceType: "mac", publicKey: generatePairingRequestKeyPair().publicKey }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(app.transports, ["tailscale"]);
  } finally {
    await app.close();
  }
});

test("a host without the request service answers the routes as not found", async () => {
  const app = await host({ wired: false });
  try {
    const response = await fetch(
      `${app.base}/pairing/requests`,
      json({ deviceName: "Mac", deviceType: "mac", publicKey: generatePairingRequestKeyPair().publicKey }),
    );
    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, "not_found");
    assert.equal((await (await fetch(`${app.base}/health?detail=host`)).json()).pairingRequests, false);
  } finally {
    await app.close();
  }
});

test("a long-poll the requester abandons never counts as collecting the credential", async () => {
  const app = await host();
  try {
    const keys = generatePairingRequestKeyPair();
    const created = await (
      await fetch(`${app.base}/pairing/requests`, json({ deviceName: "Mac", deviceType: "mac", publicKey: keys.publicKey }))
    ).json();
    const secretHeader = { "aiden-pairing-secret": created.pollSecret };
    await (
      await fetch(
        `${app.base}/pairing/requests/${created.requestId}/reveal`,
        json({ requesterNonce: randomBytes(32).toString("base64url") }, secretHeader),
      )
    ).json();
    const controller = new AbortController();
    const abandoned = fetch(`${app.base}/pairing/requests/${created.requestId}`, {
      headers: secretHeader,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    assert.ok((await abandoned) instanceof Error);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal((await app.requests.respond(created.requestId, "allow"))?.state, "approved");
    // Nobody received the envelope, so a requester cancel revokes the grant
    // instead of leaving a live credential behind.
    const cancelled = await fetch(`${app.base}/pairing/requests/${created.requestId}`, {
      method: "DELETE",
      headers: secretHeader,
    });
    assert.deepEqual(await cancelled.json(), { requestId: created.requestId, state: "cancelled" });
    const devices = await app.registry.listDevices();
    assert.equal(devices.length, 1);
    assert.equal(typeof devices[0]?.revokedAt, "number");
  } finally {
    await app.close();
  }
});
