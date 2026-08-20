import assert from "node:assert/strict";
import { createServer } from "node:net";
import * as fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AidenRemoteService } from "./aiden-remote-service.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
} from "./aiden-remote-state.js";
import { loadOrCreateAidenRemoteTlsIdentity } from "./aiden-remote-tls-identity.js";

async function canBind(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function availablePortPair(): Promise<number> {
  for (let port = 51_000; port < 55_000; port += 2) {
    if (await canBind(port) && await canBind(port + 1)) return port;
  }
  throw new Error("No test port pair was available.");
}

async function fixture(mode: "lan" | "tailscale" | "both" = "lan") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-service-"));
  const initial = createDefaultAidenRemoteState();
  initial.connectionMode = mode;
  initial.lanPort = await availablePortPair();
  let persisted = structuredClone(initial);
  const state = new AidenRemoteStateRegistry({
    load: async () => structuredClone(persisted),
    save: async (document) => {
      persisted = structuredClone(document);
    },
  });
  const bonjour: { starts: number; stops: number; start(): void; stop(): void } = {
    starts: 0,
    stops: 0,
    start: () => { bonjour.starts += 1; },
    stop: () => { bonjour.stops += 1; },
  };
  const tailscale = {
    connects: 0,
    disconnects: 0,
    targets: [] as string[],
    disconnectTargets: [] as string[],
    status: async () => ({ installed: true, dnsName: "aiden.tailnet.ts.net" }),
    connect: async (target: string) => {
      tailscale.connects += 1;
      tailscale.targets.push(target);
      return { path: "/api/aiden/v1" as const, target };
    },
    disconnect: async (target: string) => {
      tailscale.disconnects += 1;
      tailscale.disconnectTargets.push(target);
    },
  };
  let identityLoads = 0;
  const service = new AidenRemoteService({
    state,
    appVersion: "0.30.0",
    hostname: "Aiden-Test",
    bonjour,
    tailscale,
    resolveTlsEndpointPin: async () => `sha256/${Buffer.alloc(32, 9).toString("base64")}`,
    loadTlsIdentity: async () => {
      identityLoads += 1;
      return loadOrCreateAidenRemoteTlsIdentity({
        directory: path.join(directory, "identity"),
        hostnames: ["aiden-test", "aiden-test.local"],
      });
    },
  });
  return {
    service,
    state,
    bonjour,
    tailscale,
    identityLoads: () => identityLoads,
    persisted: () => structuredClone(persisted),
    directory,
    cleanup: async () => {
      await service.stopAndSettle();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function insecureHealth(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      `https://127.0.0.1:${port}/api/aiden/v1/health`,
      { rejectUnauthorized: false, timeout: 3_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
  });
}

async function insecureJson<T>(
  port: number,
  requestPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: T }> {
  const encodedBody = options.body === undefined
    ? undefined
    : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: options.method ?? "GET",
      rejectUnauthorized: false,
      timeout: 3_000,
      headers: {
        ...options.headers,
        ...(encodedBody === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(encodedBody.length),
        }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    if (encodedBody !== undefined) request.write(encodedBody);
    request.end();
  });
}

test("disabled startup creates no identity, listener, or Bonjour advertisement", async () => {
  const app = await fixture();
  try {
    await app.service.initialize();
    assert.deepEqual(await app.service.status(), {
      enabled: false,
      running: false,
      connectionMode: "lan",
      lanPort: app.persisted().lanPort,
      tailscaleConnected: false,
      tailscaleInstalled: false,
      pairedDeviceCount: 0,
      approvedRootCount: 0,
    });
    assert.equal(app.identityLoads(), 0);
    assert.equal(app.bonjour.starts, 0);
  } finally {
    await app.cleanup();
  }
});

test("explicit enable serves authenticated API shell over LAN HTTPS and stops cleanly", async () => {
  const app = await fixture();
  try {
    await app.service.initialize();
    await app.service.setEnabled(true);
    const health = await insecureHealth(app.persisted().lanPort);
    assert.deepEqual(health, { status: 200, body: { ok: true, protocolVersion: 1 } });
    assert.equal(app.bonjour.starts, 1);
    assert.equal((await app.service.status()).running, true);
    await app.service.setEnabled(false);
    assert.equal((await app.service.status()).running, false);
    assert.equal(app.persisted().enabled, false);
  } finally {
    await app.cleanup();
  }
});

test("Tailscale connect ownership persists only after connect and explicit disable clears only it", async () => {
  const app = await fixture("both");
  try {
    await app.service.initialize();
    await app.service.setEnabled(true);
    await app.service.connectTailscale();
    assert.equal(app.tailscale.connects, 1);
    assert.deepEqual(app.tailscale.targets, [
      `http://127.0.0.1:${app.persisted().lanPort + 1}/api/aiden/v1`,
    ]);
    assert.equal(app.persisted().tailscaleOwnership?.path, "/api/aiden/v1");
    await app.service.setEnabled(false);
    assert.equal(app.tailscale.disconnects, 1);
    assert.equal(app.persisted().tailscaleOwnership, undefined);
    assert.equal(app.persisted().enabled, false);
  } finally {
    await app.cleanup();
  }
});

test("Tailscale connect removes only a persisted origin-only route before canonical migration", async () => {
  const app = await fixture("both");
  const legacyTarget = `http://127.0.0.1:${app.persisted().lanPort + 1}`;
  try {
    await app.state.setTailscaleOwnership({ path: "/api/aiden/v1", target: legacyTarget });
    await app.service.initialize();
    await app.service.setEnabled(true);
    await app.service.connectTailscale();
    assert.deepEqual(app.tailscale.disconnectTargets, [legacyTarget]);
    assert.deepEqual(app.tailscale.targets, [
      `${legacyTarget}/api/aiden/v1`,
    ]);
    assert.equal(app.persisted().tailscaleOwnership?.target, `${legacyTarget}/api/aiden/v1`);
  } finally {
    await app.cleanup();
  }
});

test("pairing windows expose no secret until a local desktop action begins one", async () => {
  const app = await fixture();
  try {
    await app.service.setEnabled(true);
    const bootstrap = await app.service.beginPairing("lan");
    assert.equal(bootstrap.endpoint, `https://aiden-test.local:${app.persisted().lanPort}/api/aiden/v1`);
    assert.match(bootstrap.secret, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(bootstrap.serverSpkiSha256, /^sha256\/[A-Za-z0-9+/]{43}=$/u);
    const qr = JSON.parse(app.service.pairingQrPayload(bootstrap, "lan"));
    assert.equal(qr.kind, "aiden-pairing-v1");
    assert.equal(qr.bootstrap.secret, bootstrap.secret);
    assert.equal(qr.trust.mode, "private-ca");
    assert.ok(Buffer.from(qr.trust.caCertificateDerBase64, "base64").length > 100);
    assert.equal(JSON.stringify(await app.service.status()).includes(bootstrap.secret), false);
  } finally {
    await app.cleanup();
  }
});

test("revoked devices can re-pair through a fresh local window without reviving the old credential", async () => {
  const app = await fixture();
  try {
    await app.service.setEnabled(true);
    const firstBootstrap = await app.service.beginPairing("lan");
    const first = await insecureJson<{ deviceId: string; credential: string }>(
      app.persisted().lanPort,
      "/api/aiden/v1/pairing/exchange",
      {
        method: "POST",
        body: {
          secret: firstBootstrap.secret,
          deviceName: "Physical iPhone",
          deviceType: "iphone",
          clientVersion: "1.0",
        },
      },
    );
    assert.equal(first.status, 200);
    assert.match(first.body.credential, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(await app.state.revokeDevice(first.body.deviceId), true);

    const repairBootstrap = await app.service.beginPairing("lan");
    assert.notEqual(repairBootstrap.secret, firstBootstrap.secret);
    const repaired = await insecureJson<{ deviceId: string; credential: string }>(
      app.persisted().lanPort,
      "/api/aiden/v1/pairing/exchange",
      {
        method: "POST",
        body: {
          secret: repairBootstrap.secret,
          deviceName: "Physical iPhone",
          deviceType: "iphone",
          clientVersion: "1.0",
        },
      },
    );
    assert.equal(repaired.status, 200);
    assert.notEqual(repaired.body.deviceId, first.body.deviceId);
    assert.notEqual(repaired.body.credential, first.body.credential);

    const headers = (credential: string) => ({
      authorization: `Bearer ${credential}`,
      "aiden-protocol-version": "1",
    });
    const oldCredential = await insecureJson<{ error: { code: string } }>(
      app.persisted().lanPort,
      "/api/aiden/v1/server",
      { headers: headers(first.body.credential) },
    );
    assert.equal(oldCredential.status, 403);
    assert.equal(oldCredential.body.error.code, "credential_revoked");
    const replacementCredential = await insecureJson<{ instanceId: string }>(
      app.persisted().lanPort,
      "/api/aiden/v1/server",
      { headers: headers(repaired.body.credential) },
    );
    assert.equal(replacementCredential.status, 200);
    assert.equal(replacementCredential.body.instanceId, app.persisted().instanceId);

    const serialized = JSON.stringify(app.persisted());
    assert.equal(serialized.includes(first.body.credential), false);
    assert.equal(serialized.includes(repaired.body.credential), false);
  } finally {
    await app.cleanup();
  }
});
