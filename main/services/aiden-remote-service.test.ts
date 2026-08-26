import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AidenRemotePortInUseError,
  AidenRemoteService,
  aidenRemoteBonjourServiceName,
  aidenRemotePortCandidates,
} from "./aiden-remote-service.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  type AidenRemoteStateDocument,
} from "./aiden-remote-state.js";
import { loadOrCreateAidenRemoteTlsIdentity } from "./aiden-remote-tls-identity.js";
import type { AidenTailscaleStatus } from "./aiden-remote-tailscale-route.js";
import { revokeAidenRemoteRuntimeDevice } from "./aiden-remote-revocation.js";

async function canBind(
  port: number,
  host: "::" | "127.0.0.1" = "127.0.0.1",
): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
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

async function availablePortPairs(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let port = 51_000; port < 55_000 && ports.length < count; port += 2) {
    if (await canBind(port) && await canBind(port + 1)) ports.push(port);
  }
  if (ports.length !== count) throw new Error(`Only ${ports.length} test port pairs were available.`);
  return ports;
}

async function availableLegacyOddPort(): Promise<number> {
  for (let port = 53_001; port < 54_999; port += 2) {
    if (await canBind(port) && await canBind(port + 1)) return port;
  }
  throw new Error("No legacy odd test port pair was available.");
}

async function reservePort(
  port: number,
  host: "::" | "127.0.0.1" = "127.0.0.1",
): Promise<ReturnType<typeof createServer>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

async function closeReservedPort(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function heldConnection(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function socketClosed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.on("error", () => undefined);
    socket.once("close", () => resolve());
  });
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface FixtureOptions {
  mode?: "lan" | "tailscale" | "both";
  lanPort?: number;
  initial?: (state: AidenRemoteStateDocument) => void;
  portCandidates?: readonly number[];
  failSaveWhen?: (document: AidenRemoteStateDocument) => boolean;
  failBonjourStart?: boolean;
  tailscaleServeStatus?: AidenTailscaleStatus;
  tailscaleStatusFailureAtCall?: number;
  enableTailscaleTakeover?: boolean;
  tailscaleAssessment?: {
    state: "available" | "owned" | "other_aiden_live" | "other_aiden_stale" | "unrelated_conflict" | "funnel_conflict" | "unavailable";
    errorCode?: "not_installed" | "not_connected" | "https_unavailable" | "status_unavailable";
  };
  tailscaleInspection?: {
    connectionStatus: {
      installed: boolean;
      dnsName?: string;
      httpsAvailable?: boolean;
      serveStatus?: AidenTailscaleStatus;
      errorCode?: "not_installed" | "not_connected" | "https_unavailable" | "status_unavailable";
    };
    assessment: NonNullable<FixtureOptions["tailscaleAssessment"]>;
  };
  afterListenerBound?: (input: {
    transport: "lan" | "tailscale";
    port: number;
  }) => Promise<void>;
}

async function fixture(
  modeOrOptions: "lan" | "tailscale" | "both" | FixtureOptions = "lan",
) {
  const options = typeof modeOrOptions === "string"
    ? { mode: modeOrOptions }
    : modeOrOptions;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-service-"));
  const initial = createDefaultAidenRemoteState();
  initial.connectionMode = options.mode ?? "lan";
  initial.lanPort = options.lanPort ?? await availablePortPair();
  options.initial?.(initial);
  let persisted = structuredClone(initial);
  const state = new AidenRemoteStateRegistry({
    load: async () => structuredClone(persisted),
    save: async (document) => {
      if (options.failSaveWhen?.(document)) throw new Error("disk unavailable");
      persisted = structuredClone(document);
    },
  });
  const bonjour: {
    starts: number;
    stops: number;
    inputs: Array<{ instanceId: string; displayName: string; port: number }>;
    failure?: (error: Error) => void;
    start(
      input: { instanceId: string; displayName: string; port: number },
      onUnexpectedFailure: (error: Error) => void,
    ): Promise<void>;
    stop(): void;
  } = {
    starts: 0,
    stops: 0,
    inputs: [],
    start: async (input, onUnexpectedFailure) => {
      bonjour.starts += 1;
      bonjour.inputs.push(input);
      if (options.failBonjourStart) throw new Error("dns-sd unavailable");
      bonjour.failure = onUnexpectedFailure;
    },
    stop: () => {
      bonjour.stops += 1;
      bonjour.failure = undefined;
    },
  };
  const tailscale = {
    connects: 0,
    disconnects: 0,
    reconciles: 0,
    statusCalls: 0,
    assessmentCalls: 0,
    inspectionCalls: 0,
    targets: [] as string[],
    disconnectTargets: [] as string[],
    status: async () => {
      tailscale.statusCalls += 1;
      if (
        options.tailscaleStatusFailureAtCall !== undefined
        && tailscale.statusCalls === options.tailscaleStatusFailureAtCall
      ) {
        throw new Error("tailscale status unavailable");
      }
      return {
        installed: true,
        dnsName: "aiden.tailnet.ts.net",
        ...(options.tailscaleServeStatus
          ? { serveStatus: options.tailscaleServeStatus }
          : {}),
      };
    },
    connect: async (
      target: string,
      _ownership?: { path: "/api/aiden/v1"; target: string },
      persistOwnership?: (ownership: { path: "/api/aiden/v1"; target: string }) => Promise<void>,
    ) => {
      tailscale.connects += 1;
      tailscale.targets.push(target);
      const ownership = { path: "/api/aiden/v1" as const, target };
      await persistOwnership?.(ownership);
      return ownership;
    },
    disconnect: async (
      target: string,
      _ownership?: { path: "/api/aiden/v1"; target: string },
      clearOwnership?: () => Promise<void>,
    ) => {
      tailscale.disconnects += 1;
      tailscale.disconnectTargets.push(target);
      await clearOwnership?.();
    },
    reconcilePendingOutcome: async () => {
      tailscale.reconciles += 1;
      const pending = (await state.snapshot()).tailscalePendingOutcome;
      if (!pending) throw new Error("tailscale_reconciliation_unavailable");
      await state.commitTailscaleOutcome(
        pending.operation === "disconnect"
          ? undefined
          : { path: "/api/aiden/v1", target: pending.target },
      );
      return pending.operation === "disconnect" ? "disconnected" as const : "connected" as const;
    },
    ...(options.enableTailscaleTakeover
      ? {
          assessRoute: async () => {
            tailscale.assessmentCalls += 1;
            return { state: "other_aiden_stale" as const };
          },
          reviewTakeover: async () => ({ token: "A".repeat(32), expiresAt: Date.now() + 30_000 }),
          takeOver: async (
            target: string,
            token: string,
            persistOwnership: (ownership: { path: "/api/aiden/v1"; target: string }) => Promise<void>,
          ) => {
            assert.equal(token, "A".repeat(32));
            const ownership = { path: "/api/aiden/v1" as const, target };
            await persistOwnership(ownership);
            return ownership;
          },
        }
      : {}),
    ...(options.tailscaleAssessment
      ? { assessRoute: async () => {
          tailscale.assessmentCalls += 1;
          return options.tailscaleAssessment!;
        } }
      : {}),
    ...(options.tailscaleInspection
      ? { inspectRoute: async () => {
          tailscale.inspectionCalls += 1;
          return options.tailscaleInspection!;
        } }
      : {}),
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
    ...(options.portCandidates === undefined
      ? {}
      : { portCandidates: () => options.portCandidates ?? [] }),
    ...(options.afterListenerBound === undefined
      ? {}
      : { afterListenerBound: options.afterListenerBound }),
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

async function plainHealth(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `http://127.0.0.1:${port}/api/aiden/v1/health`,
      { timeout: 1_000 },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
  });
}

async function healthWithAgent(
  port: number,
  transport: "lan" | "tailscale",
  agent: http.Agent | https.Agent,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = (transport === "lan" ? https : http).get({
      host: "127.0.0.1",
      port,
      path: "/api/aiden/v1/health",
      agent,
      ...(transport === "lan" ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
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

test("fresh endpoint candidates are bounded, unique, and reserve a loopback companion", () => {
  const candidates = aidenRemotePortCandidates(52_000);
  assert.equal(candidates[0], 52_000);
  assert.equal(candidates.length, 64);
  assert.equal(new Set(candidates).size, candidates.length);
  assert.equal(candidates.every((port) => port > 0 && port < 65_535), true);
  assert.equal(candidates.every((port) => port + 1 <= 65_535), true);
  assert.equal(candidates.every((port) => port % 2 === 0), true);
  assert.notEqual(aidenRemotePortCandidates(52_001)[0], 52_001);
});

test("a fresh profile moves to the next complete port pair and advertises only the committed port", async () => {
  const [blockedPort, fallbackPort] = await availablePortPairs(2);
  const blocker = await reservePort(blockedPort, "::");
  const app = await fixture({
    mode: "both",
    lanPort: blockedPort,
    portCandidates: [blockedPort, fallbackPort],
  });
  try {
    await app.service.setEnabled(true);
    assert.equal(app.persisted().lanPort, fallbackPort);
    assert.equal(app.persisted().lanPortCommitted, true);
    assert.deepEqual(app.bonjour.inputs.map((input) => input.port), [fallbackPort]);
    assert.deepEqual(await insecureHealth(fallbackPort), {
      status: 200,
      body: { ok: true, protocolVersion: 1 },
    });
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("a fresh profile skips a LAN candidate occupied only on IPv4 loopback", async () => {
  const [blockedPort, fallbackPort] = await availablePortPairs(2);
  const blocker = await reservePort(blockedPort, "127.0.0.1");
  const app = await fixture({
    mode: "both",
    lanPort: blockedPort,
    portCandidates: [blockedPort, fallbackPort],
  });
  try {
    await app.service.setEnabled(true);
    assert.equal(app.persisted().lanPort, fallbackPort);
    assert.equal(app.persisted().lanPortCommitted, true);
    assert.deepEqual(app.bonjour.inputs.map((input) => input.port), [fallbackPort]);
    assert.deepEqual(await insecureHealth(fallbackPort), {
      status: 200,
      body: { ok: true, protocolVersion: 1 },
    });
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("a failed loopback companion bind rolls back the partial LAN listener before retrying", async () => {
  const [partialPort, fallbackPort] = await availablePortPairs(2);
  const blocker = await reservePort(partialPort + 1);
  let heldSocket: Socket | undefined;
  let heldSocketClosed: Promise<void> | undefined;
  const app = await fixture({
    mode: "both",
    lanPort: partialPort,
    portCandidates: [partialPort, fallbackPort],
    afterListenerBound: async ({ transport, port }) => {
      if (transport !== "lan" || port !== partialPort) return;
      heldSocket = await heldConnection(port);
      heldSocketClosed = socketClosed(heldSocket);
    },
  });
  try {
    await within(app.service.setEnabled(true));
    if (heldSocketClosed) await within(heldSocketClosed);
    assert.equal(heldSocket?.destroyed, true);
    assert.equal(app.persisted().lanPort, fallbackPort);
    assert.equal(await canBind(partialPort), true, "the first candidate LAN listener was released");
    assert.deepEqual(app.bonjour.inputs.map((input) => input.port), [fallbackPort]);
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("single-transport profiles lease the inactive half and retain the pair when enabling both", async () => {
  const [lanPort, lanFallback, tailscalePort, tailscaleFallback] = await availablePortPairs(4);
  const loopbackBlocker = await reservePort(lanPort + 1);
  const lanBlocker = await reservePort(tailscalePort, "::");
  const lan = await fixture({
    mode: "lan",
    lanPort,
    portCandidates: [lanPort, lanFallback],
  });
  const tailscale = await fixture({
    mode: "tailscale",
    lanPort: tailscalePort,
    portCandidates: [tailscalePort, tailscaleFallback],
  });
  try {
    await lan.service.setEnabled(true);
    await tailscale.service.setEnabled(true);
    assert.equal(lan.persisted().lanPort, lanFallback);
    assert.equal(tailscale.persisted().lanPort, tailscaleFallback);

    await closeReservedPort(loopbackBlocker);
    await closeReservedPort(lanBlocker);
    await lan.service.setConnectionMode("both");
    await tailscale.service.setConnectionMode("both");
    assert.equal(lan.persisted().lanPort, lanFallback);
    assert.equal(tailscale.persisted().lanPort, tailscaleFallback);
    assert.equal(lan.identityLoads(), 1, "mode changes retain the original listener pair");
    assert.equal(tailscale.identityLoads(), 1, "mode changes retain the original listener pair");
  } finally {
    await Promise.all([lan.cleanup(), tailscale.cleanup()]);
    if (loopbackBlocker.listening) await closeReservedPort(loopbackBlocker);
    if (lanBlocker.listening) await closeReservedPort(lanBlocker);
  }
});

test("inactive transports retain their lease while rejecting connections at the socket boundary", async () => {
  const lan = await fixture("lan");
  const tailscale = await fixture("tailscale");
  try {
    await lan.service.setEnabled(true);
    await tailscale.service.setEnabled(true);
    await assert.rejects(plainHealth(lan.persisted().lanPort + 1));
    await assert.rejects(insecureHealth(tailscale.persisted().lanPort));
    assert.equal((await lan.service.status()).running, true);
    assert.equal((await tailscale.service.status()).running, true);
  } finally {
    await Promise.all([lan.cleanup(), tailscale.cleanup()]);
  }
});

test("mode transitions terminate keep-alive sockets accepted by the newly inactive transport", async () => {
  const app = await fixture("both");
  const lanAgent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
  const tailscaleAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    await app.service.setEnabled(true);
    await healthWithAgent(app.persisted().lanPort, "lan", lanAgent);
    await healthWithAgent(app.persisted().lanPort + 1, "tailscale", tailscaleAgent);
    const lanSocket = Object.values(lanAgent.freeSockets).flat()[0];
    const tailscaleSocket = Object.values(tailscaleAgent.freeSockets).flat()[0];
    assert.ok(lanSocket && !lanSocket.destroyed);
    assert.ok(tailscaleSocket && !tailscaleSocket.destroyed);

    const lanClosed = once(lanSocket, "close");
    await app.service.setConnectionMode("tailscale");
    await lanClosed;
    assert.equal(lanSocket.destroyed, true);
    assert.equal(tailscaleSocket.destroyed, false);

    const tailscaleClosed = once(tailscaleSocket, "close");
    await app.service.setConnectionMode("lan");
    await tailscaleClosed;
    assert.equal(tailscaleSocket.destroyed, true);
  } finally {
    lanAgent.destroy();
    tailscaleAgent.destroy();
    await app.cleanup();
  }
});

test("LAN-only and Tailscale-only profiles racing for one pair cannot split its ownership", async () => {
  const [firstPort, secondPort] = await availablePortPairs(2);
  const lan = await fixture({
    mode: "lan",
    lanPort: firstPort,
    portCandidates: [firstPort, secondPort],
  });
  const tailscale = await fixture({
    mode: "tailscale",
    lanPort: firstPort,
    portCandidates: [firstPort, secondPort],
  });
  try {
    await Promise.all([lan.service.setEnabled(true), tailscale.service.setEnabled(true)]);
    assert.deepEqual(
      new Set([lan.persisted().lanPort, tailscale.persisted().lanPort]),
      new Set([firstPort, secondPort]),
    );
  } finally {
    await Promise.all([lan.cleanup(), tailscale.cleanup()]);
  }
});

test("an enabled mode transition never releases its pair to a competing fresh profile", async () => {
  const [ownedPort, fallbackPort] = await availablePortPairs(2);
  const incumbent = await fixture({
    mode: "lan",
    lanPort: ownedPort,
    portCandidates: [ownedPort, fallbackPort],
  });
  const competitor = await fixture({
    mode: "tailscale",
    lanPort: ownedPort,
    portCandidates: [ownedPort, fallbackPort],
  });
  try {
    await incumbent.service.setEnabled(true);
    await incumbent.service.setConnectionMode("both");
    await competitor.service.setEnabled(true);
    assert.equal(incumbent.persisted().lanPort, ownedPort);
    assert.equal(competitor.persisted().lanPort, fallbackPort);
    assert.equal(incumbent.identityLoads(), 1);
  } finally {
    await Promise.all([incumbent.cleanup(), competitor.cleanup()]);
  }
});

test("a canonical Serve target owned elsewhere is excluded from fresh allocation", async () => {
  const [reservedPort, fallbackPort] = await availablePortPairs(2);
  const app = await fixture({
    mode: "both",
    lanPort: reservedPort,
    portCandidates: [reservedPort, fallbackPort],
    tailscaleServeStatus: {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "other-mac.tailnet.ts.net:443": {
          Handlers: {
            "/api/aiden/v1": {
              Proxy: `http://127.0.0.1:${reservedPort + 1}/api/aiden/v1`,
            },
          },
        },
      },
    },
  });
  try {
    await app.service.setEnabled(true);
    assert.equal(app.persisted().lanPort, fallbackPort);
    assert.deepEqual(app.bonjour.inputs.map((input) => input.port), [fallbackPort]);
  } finally {
    await app.cleanup();
  }
});

test("all exact Aiden Serve targets are reserved even with ambiguous authorities and either pair half", async () => {
  const [firstPort, secondPort, fallbackPort] = await availablePortPairs(3);
  const app = await fixture({
    mode: "both",
    lanPort: firstPort,
    portCandidates: [firstPort, secondPort, fallbackPort],
    tailscaleServeStatus: {
      Web: {
        "malformed authority": {
          Handlers: {
            "/api/aiden/v1": {
              Proxy: `http://localhost:${firstPort + 1}/api/aiden/v1`,
            },
          },
        },
        "second.tailnet.ts.net:443": {
          Handlers: {
            "/api/aiden/v1": { Proxy: `http://127.0.0.1:${secondPort}` },
          },
        },
      },
    },
  });
  try {
    await app.service.setEnabled(true);
    assert.equal(app.persisted().lanPort, fallbackPort);
  } finally {
    await app.cleanup();
  }
});

test("two fresh profiles racing for the same candidates commit distinct endpoints", async () => {
  const [firstPort, secondPort] = await availablePortPairs(2);
  const first = await fixture({
    mode: "both",
    lanPort: firstPort,
    portCandidates: [firstPort, secondPort],
  });
  const second = await fixture({
    mode: "both",
    lanPort: firstPort,
    portCandidates: [firstPort, secondPort],
  });
  try {
    await Promise.all([
      first.service.setEnabled(true),
      second.service.setEnabled(true),
    ]);
    assert.deepEqual(
      new Set([first.persisted().lanPort, second.persisted().lanPort]),
      new Set([firstPort, secondPort]),
    );
    assert.equal(first.persisted().lanPortCommitted, true);
    assert.equal(second.persisted().lanPortCommitted, true);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
});

test("a committed endpoint remains stable across restart even when alternatives are offered", async () => {
  const [committedPort, alternatePort] = await availablePortPairs(2);
  const first = await fixture({
    mode: "both",
    lanPort: committedPort,
    portCandidates: [committedPort, alternatePort],
  });
  try {
    await first.service.setEnabled(true);
    const committed = first.persisted();
    assert.equal(committed.lanPort, committedPort);
    assert.equal(committed.lanPortCommitted, true);
    await first.service.setEnabled(false);

    const restarted = await fixture({
      mode: "both",
      lanPort: alternatePort,
      portCandidates: [alternatePort],
      initial: (state) => Object.assign(state, committed, { enabled: false }),
    });
    try {
      await restarted.service.setEnabled(true);
      assert.equal(restarted.persisted().lanPort, committedPort);
      assert.deepEqual(restarted.bonjour.inputs.map((input) => input.port), [committedPort]);
    } finally {
      await restarted.cleanup();
    }
  } finally {
    await first.cleanup();
  }
});

test("committed legacy port 65535 remains restart-compatible in every connection mode", async (context) => {
  // LAN binds the IPv6 wildcard (dual stack on supported hosts), while the
  // companion Tailscale listener is IPv4 loopback. Probe the same addresses
  // as production so a host-owned IPv6 endpoint skips instead of racing us.
  if (!await canBind(65_535, "::") || !await canBind(49_221)) {
    context.skip("legacy endpoint ports are occupied on this host");
    return;
  }
  for (const mode of ["lan", "tailscale", "both"] as const) {
    const app = await fixture({
      mode,
      lanPort: 65_535,
      initial: (state) => {
        state.lanPortCommitted = true;
      },
    });
    try {
      await app.service.setEnabled(true);
      assert.equal(app.persisted().lanPort, 65_535);
      assert.equal((await app.service.status()).running, true);
    } finally {
      await app.cleanup();
    }
  }
});

test("an exact live legacy Serve owner restarts and reaches canonical migration", async () => {
  const port = await availablePortPair();
  const legacyTarget = `http://127.0.0.1:${port + 1}`;
  const app = await fixture({
    mode: "both",
    lanPort: port,
    initial: (state) => {
      state.lanPortCommitted = true;
      state.tailscaleOwnership = { path: "/api/aiden/v1", target: legacyTarget };
    },
    tailscaleServeStatus: {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "aiden.tailnet.ts.net:443": {
          Handlers: { "/api/aiden/v1": { Proxy: legacyTarget } },
        },
      },
    },
  });
  try {
    await app.service.setEnabled(true);
    assert.equal(app.persisted().lanPort, port);
    await app.service.connectTailscale();
    assert.deepEqual(app.tailscale.disconnectTargets, [legacyTarget]);
    assert.deepEqual(app.tailscale.targets, [
      `http://127.0.0.1:${port + 1}/api/aiden/v1`,
    ]);
  } finally {
    await app.cleanup();
  }
});

test("ordinary odd committed legacy ports remain restart-compatible", async () => {
  const port = await availableLegacyOddPort();
  const app = await fixture({
    mode: "both",
    lanPort: port,
    initial: (state) => {
      state.lanPortCommitted = true;
    },
  });
  try {
    await app.service.setEnabled(true);
    assert.equal(app.persisted().lanPort, port);
    assert.deepEqual(await insecureHealth(port), {
      status: 200,
      body: { ok: true, protocolVersion: 1 },
    });
  } finally {
    await app.cleanup();
  }
});

test("a paired profile fails closed with typed remediation instead of moving its endpoint", async () => {
  const [pairedPort, alternatePort] = await availablePortPairs(2);
  const blocker = await reservePort(pairedPort, "::");
  const app = await fixture({
    mode: "both",
    lanPort: pairedPort,
    portCandidates: [pairedPort, alternatePort],
  });
  try {
    await app.state.issueDevice({ name: "Previous iPhone", type: "iphone", clientVersion: "1" });
    await assert.rejects(
      app.service.setEnabled(true),
      (error: unknown) => error instanceof AidenRemotePortInUseError
        && error.code === "remote_port_in_use"
        && error.lanPort === pairedPort,
    );
    const status = await app.service.status();
    assert.equal(status.errorCode, "remote_port_in_use");
    assert.match(status.error ?? "", /Stop the other Aiden profile/u);
    assert.equal(status.error?.includes("EADDRINUSE"), false);
    assert.equal(app.persisted().lanPort, pairedPort);
    assert.equal(app.persisted().lanPortCommitted, false);
    assert.equal(app.bonjour.starts, 0);
    assert.equal(await canBind(alternatePort), true);
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("a paired profile moves only after explicit endpoint repair", async () => {
  const [pairedPort, alternatePort] = await availablePortPairs(2);
  const blocker = await reservePort(pairedPort, "::");
  const app = await fixture({
    mode: "both",
    lanPort: pairedPort,
    portCandidates: [pairedPort, alternatePort],
  });
  try {
    await app.state.issueDevice({ name: "Previous iPhone", type: "iphone", clientVersion: "1" });
    await assert.rejects(app.service.setEnabled(true), AidenRemotePortInUseError);

    await app.service.moveToAvailablePort();

    const status = await app.service.status();
    assert.equal(status.running, true);
    assert.equal(status.enabled, true);
    assert.equal(status.errorCode, undefined);
    assert.equal(app.persisted().lanPort, alternatePort);
    assert.equal(app.persisted().lanPortCommitted, true);
    assert.deepEqual(await insecureHealth(alternatePort), {
      status: 200,
      body: { ok: true, protocolVersion: 1 },
    });
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("explicit endpoint repair fails closed when Tailscale routes cannot be inventoried", async () => {
  const [pairedPort, alternatePort] = await availablePortPairs(2);
  const blocker = await reservePort(pairedPort, "::");
  const app = await fixture({
    mode: "both",
    lanPort: pairedPort,
    portCandidates: [pairedPort, alternatePort],
    tailscaleStatusFailureAtCall: 2,
  });
  try {
    await app.state.issueDevice({ name: "Previous iPhone", type: "iphone", clientVersion: "1" });
    await assert.rejects(app.service.setEnabled(true), AidenRemotePortInUseError);

    await assert.rejects(
      app.service.moveToAvailablePort(),
      /verify existing Tailscale routes/u,
    );

    const status = await app.service.status();
    assert.equal(status.errorCode, "remote_port_in_use");
    assert.equal(app.persisted().lanPort, pairedPort);
    assert.equal(await canBind(alternatePort), true);
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("explicitly disabling Remote Access clears stale port remediation", async () => {
  const [pairedPort, alternatePort] = await availablePortPairs(2);
  const blocker = await reservePort(pairedPort, "::");
  const app = await fixture({
    mode: "both",
    lanPort: pairedPort,
    portCandidates: [pairedPort, alternatePort],
  });
  try {
    await app.state.issueDevice({ name: "Previous iPhone", type: "iphone", clientVersion: "1" });
    await assert.rejects(app.service.setEnabled(true), AidenRemotePortInUseError);
    await app.service.setEnabled(false);

    const status = await app.service.status();
    assert.equal(status.errorCode, undefined);
    await assert.rejects(
      app.service.moveToAvailablePort(),
      /does not currently need a different port/u,
    );
    assert.equal(app.persisted().enabled, false);
    assert.equal(app.persisted().lanPort, pairedPort);
    assert.equal(await canBind(alternatePort), true);
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("explicit endpoint repair refuses to orphan an owned Tailscale route", async () => {
  const [pairedPort, alternatePort] = await availablePortPairs(2);
  const blocker = await reservePort(pairedPort, "::");
  const app = await fixture({
    mode: "both",
    lanPort: pairedPort,
    portCandidates: [pairedPort, alternatePort],
    initial: (state) => {
      state.tailscaleOwnership = {
        path: "/api/aiden/v1",
        target: `http://127.0.0.1:${pairedPort + 1}/api/aiden/v1`,
      };
    },
  });
  try {
    await assert.rejects(app.service.setEnabled(true), AidenRemotePortInUseError);
    await assert.rejects(
      app.service.moveToAvailablePort(),
      /Disconnect this profile's Tailscale Serve route/u,
    );
    assert.equal(app.persisted().lanPort, pairedPort);
    assert.equal(await canBind(alternatePort), true);
  } finally {
    await app.cleanup();
    await closeReservedPort(blocker);
  }
});

test("candidate exhaustion leaves a fresh profile uncommitted and publishes nothing", async () => {
  const [firstPort, secondPort] = await availablePortPairs(2);
  const firstBlocker = await reservePort(firstPort, "::");
  const secondBlocker = await reservePort(secondPort, "::");
  const app = await fixture({
    mode: "both",
    lanPort: firstPort,
    portCandidates: [firstPort, secondPort],
  });
  try {
    await assert.rejects(app.service.setEnabled(true), AidenRemotePortInUseError);
    assert.equal(app.persisted().lanPort, firstPort);
    assert.equal(app.persisted().lanPortCommitted, false);
    assert.equal(app.persisted().enabled, false);
    assert.equal(app.bonjour.starts, 0);
  } finally {
    await app.cleanup();
    await Promise.all([
      closeReservedPort(firstBlocker),
      closeReservedPort(secondBlocker),
    ]);
  }
});

test("a failed endpoint commit releases every listener and never advertises", async () => {
  const port = await availablePortPair();
  let heldSocket: Socket | undefined;
  let heldSocketClosed: Promise<void> | undefined;
  const app = await fixture({
    mode: "both",
    lanPort: port,
    portCandidates: [port],
    failSaveWhen: (document) => document.lanPortCommitted,
    afterListenerBound: async ({ transport }) => {
      if (transport !== "lan") return;
      heldSocket = await heldConnection(port);
      heldSocketClosed = socketClosed(heldSocket);
    },
  });
  try {
    await within(assert.rejects(app.service.setEnabled(true), /disk unavailable/u));
    if (heldSocketClosed) await within(heldSocketClosed);
    assert.equal(heldSocket?.destroyed, true);
    assert.equal(await canBind(port), true);
    assert.equal(await canBind(port + 1), true);
    assert.equal(app.persisted().lanPortCommitted, false);
    assert.equal(app.bonjour.starts, 0);
  } finally {
    await app.cleanup();
  }
});

test("Bonjour launch rejection rolls back listeners and never reports a running service", async () => {
  const port = await availablePortPair();
  const app = await fixture({
    mode: "both",
    lanPort: port,
    portCandidates: [port],
    failBonjourStart: true,
  });
  try {
    await assert.rejects(app.service.setEnabled(true), /dns-sd unavailable/u);
    const status = await app.service.status();
    assert.equal(status.running, false);
    assert.equal(status.error, "Local network discovery could not start. Restart Remote Access to try again.");
    assert.equal(status.error?.includes("dns-sd unavailable"), false);
    assert.equal(await canBind(port), true);
    assert.equal(await canBind(port + 1), true);
    assert.equal(app.persisted().enabled, false);
  } finally {
    await app.cleanup();
  }
});

test("unexpected Bonjour termination stops the transport and exposes safe recovery", async () => {
  const app = await fixture({ mode: "both" });
  try {
    await app.service.setEnabled(true);
    app.bonjour.failure?.(new Error("private dns-sd detail"));
    const status = await app.service.status();
    assert.equal(status.running, false);
    assert.equal(status.error, "Local network discovery stopped unexpectedly. Restart Remote Access to try again.");
    assert.equal(status.error?.includes("private dns-sd detail"), false);
  } finally {
    await app.cleanup();
  }
});

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
      tailscaleRouteState: "unavailable",
      pairedDeviceCount: 0,
      approvedRootCount: 0,
    });
    assert.equal(app.identityLoads(), 0);
    assert.equal(app.bonjour.starts, 0);
  } finally {
    await app.cleanup();
  }
});

test("Bonjour labels disambiguate duplicate Mac names with a stable bounded instance suffix", () => {
  const first = aidenRemoteBonjourServiceName("Studio Mac", "instance_aaaaaa");
  const second = aidenRemoteBonjourServiceName("Studio Mac", "instance_bbbbbb");
  assert.match(first, /^Studio Mac \[[a-f0-9]{6}\]$/u);
  assert.match(second, /^Studio Mac \[[a-f0-9]{6}\]$/u);
  assert.notEqual(first, second);
  assert.ok(Buffer.byteLength(
    aidenRemoteBonjourServiceName("🖥️".repeat(80), "instance_cccccc"),
    "utf8",
  ) <= 63);
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

test("renaming the Mac updates authenticated projection and Bonjour without rotating identity", async () => {
  const app = await fixture();
  try {
    await app.service.setEnabled(true);
    const { bootstrap } = await app.service.beginPairing("lan");
    const paired = await insecureJson<{ deviceId: string; credential: string }>(
      app.persisted().lanPort,
      "/api/aiden/v1/pairing/exchange",
      {
        method: "POST",
        body: {
          secret: bootstrap.secret,
          deviceName: "Phone",
          deviceType: "iphone",
          clientVersion: "1",
        },
      },
    );
    const identity = app.persisted().instanceId;
    const deviceId = paired.body.deviceId;
    await app.service.setDisplayName("Studio Mac");
    const projection = await insecureJson<{ instanceId: string; name: string }>(
      app.persisted().lanPort,
      "/api/aiden/v1/server",
      {
        headers: {
          authorization: `Bearer ${paired.body.credential}`,
          "aiden-protocol-version": "1",
        },
      },
    );
    assert.equal(projection.status, 200);
    assert.equal(projection.body.instanceId, identity);
    assert.equal(projection.body.name, "Studio Mac");
    assert.equal(app.persisted().instanceId, identity);
    assert.equal((await app.state.listDevices())[0]?.id, deviceId);
    assert.equal(app.bonjour.inputs[app.bonjour.inputs.length - 1]?.displayName, "Studio Mac");
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
    let legacyOwnershipWrites = 0;
    const legacySetter = app.state.setTailscaleOwnership.bind(app.state);
    app.state.setTailscaleOwnership = async (ownership) => {
      legacyOwnershipWrites += 1;
      return legacySetter(ownership);
    };
    await app.service.initialize();
    await app.service.setEnabled(true);
    await app.service.connectTailscale();
    assert.deepEqual(app.tailscale.disconnectTargets, [legacyTarget]);
    assert.deepEqual(app.tailscale.targets, [
      `${legacyTarget}/api/aiden/v1`,
    ]);
    assert.equal(app.persisted().tailscaleOwnership?.target, `${legacyTarget}/api/aiden/v1`);
    assert.equal(legacyOwnershipWrites, 0);
  } finally {
    await app.cleanup();
  }
});

test("Tailscale connect repoints an exactly owned pre-migration development route", async () => {
  const [legacyPort, migratedPort] = await availablePortPairs(2);
  const legacyTarget = `http://127.0.0.1:${legacyPort + 1}/api/aiden/v1`;
  const migratedTarget = `http://127.0.0.1:${migratedPort + 1}/api/aiden/v1`;
  const app = await fixture({
    mode: "both",
    lanPort: migratedPort,
    initial: (state) => {
      state.lanPortCommitted = true;
      state.tailscaleOwnership = { path: "/api/aiden/v1", target: legacyTarget };
    },
    tailscaleServeStatus: {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "aiden.tailnet.ts.net:443": {
          Handlers: { "/api/aiden/v1": { Proxy: legacyTarget } },
        },
      },
    },
  });
  try {
    await app.service.setEnabled(true);
    await app.service.connectTailscale();
    assert.deepEqual(app.tailscale.disconnectTargets, [legacyTarget]);
    assert.deepEqual(app.tailscale.targets, [migratedTarget]);
    assert.equal(app.persisted().tailscaleOwnership?.target, migratedTarget);
  } finally {
    await app.cleanup();
  }
});

test("Tailscale disconnect clears an exactly owned pre-migration development route", async () => {
  const [legacyPort, migratedPort] = await availablePortPairs(2);
  const legacyTarget = `http://127.0.0.1:${legacyPort + 1}/api/aiden/v1`;
  const app = await fixture({
    mode: "both",
    lanPort: migratedPort,
    initial: (state) => {
      state.lanPortCommitted = true;
      state.tailscaleOwnership = { path: "/api/aiden/v1", target: legacyTarget };
    },
    tailscaleServeStatus: {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "aiden.tailnet.ts.net:443": {
          Handlers: { "/api/aiden/v1": { Proxy: legacyTarget } },
        },
      },
    },
  });
  try {
    await app.service.setEnabled(true);
    await app.service.disconnectTailscale();
    assert.deepEqual(app.tailscale.disconnectTargets, [legacyTarget]);
    assert.equal(app.persisted().tailscaleOwnership, undefined);
  } finally {
    await app.cleanup();
  }
});

test("Tailscale takeover review stays main-owned and persists only after confirmed takeover", async () => {
  const app = await fixture({ mode: "both", enableTailscaleTakeover: true });
  try {
    await app.service.setEnabled(true);
    assert.equal((await app.service.status()).tailscaleRouteState, "other_aiden_stale");
    const review = await app.service.reviewTailscaleTakeover();
    assert.equal(app.persisted().tailscaleOwnership, undefined);
    await app.service.takeOverTailscale(review.token);
    assert.equal(app.persisted().tailscaleOwnership?.path, "/api/aiden/v1");
    assert.equal(
      app.persisted().tailscaleOwnership?.target,
      `http://127.0.0.1:${app.persisted().lanPort + 1}/api/aiden/v1`,
    );
  } finally {
    await app.cleanup();
  }
});

test("service status consumes one atomic Tailscale route inspection", async () => {
  const serveStatus: AidenTailscaleStatus = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      "aiden.tailnet.ts.net:443": {
        Handlers: {
          "/api/aiden/v1": {
            Proxy: "http://127.0.0.1:49221/api/aiden/v1",
          },
        },
      },
    },
  };
  const app = await fixture({
    mode: "both",
    tailscaleInspection: {
      connectionStatus: {
        installed: true,
        dnsName: "aiden.tailnet.ts.net",
        httpsAvailable: true,
        serveStatus,
      },
      assessment: { state: "other_aiden_live" },
    },
  });
  try {
    await app.service.setEnabled(true);
    app.tailscale.statusCalls = 0;
    app.tailscale.assessmentCalls = 0;
    app.tailscale.inspectionCalls = 0;
    const status = await app.service.status();
    assert.equal(status.tailscaleRouteState, "other_aiden_live");
    assert.equal(status.tailscaleInstalled, true);
    assert.equal(status.tailscaleEndpoint, "https://aiden.tailnet.ts.net/api/aiden/v1");
    assert.equal(app.tailscale.inspectionCalls, 1);
    assert.equal(app.tailscale.statusCalls, 0);
    assert.equal(app.tailscale.assessmentCalls, 0);
  } finally {
    await app.cleanup();
  }
});

test("Funnel and unavailable owned routes are not presented or paired as connected", async () => {
  for (const assessment of [
    { state: "funnel_conflict" as const },
    { state: "owned" as const, errorCode: "not_connected" as const },
    { state: "owned" as const, errorCode: "https_unavailable" as const },
  ]) {
    const app = await fixture({
      mode: "both",
      tailscaleAssessment: assessment,
      initial: (state) => {
        state.tailscaleOwnership = {
          path: "/api/aiden/v1",
          target: `http://127.0.0.1:${state.lanPort + 1}/api/aiden/v1`,
        };
      },
    });
    try {
      await app.service.setEnabled(true);
      const status = await app.service.status();
      assert.equal(status.tailscaleRouteState, assessment.state);
      assert.equal(status.tailscaleConnected, false);
      await assert.rejects(
        app.service.beginPairing("tailscale"),
        /not privately connected/u,
      );
    } finally {
      await app.cleanup();
    }
  }
});

test("a persisted Tailscale handler without TCP 443 HTTPS is neither connected nor pairable", async () => {
  let target = "";
  const app = await fixture({
    mode: "both",
    initial: (state) => {
      target = `http://127.0.0.1:${state.lanPort + 1}/api/aiden/v1`;
      state.tailscaleOwnership = { path: "/api/aiden/v1", target };
    },
    tailscaleServeStatus: {
      Web: {
        "aiden.tailnet.ts.net:443": {
          Handlers: { "/api/aiden/v1": { Proxy: target } },
        },
      },
    },
  });
  try {
    await app.service.setEnabled(true);
    const status = await app.service.status();
    assert.equal(status.tailscaleConnected, false);
    assert.equal(status.tailscaleRouteState, "unavailable");
    await assert.rejects(
      app.service.beginPairing("tailscale"),
      /not privately connected/u,
    );
  } finally {
    await app.cleanup();
  }
});

test("a durable unknown Tailscale outcome blocks pairing until explicit reconciliation", async () => {
  let target = "";
  const app = await fixture({
    mode: "both",
    initial: (state) => {
      target = `http://127.0.0.1:${state.lanPort + 1}/api/aiden/v1`;
      state.tailscalePendingOutcome = {
        operation: "connect",
        target,
        beforeFingerprint: "a".repeat(64),
        preservedFingerprint: "b".repeat(64),
        normalizeListenerScaffolding: false,
        createdAt: 1_000,
      };
    },
  });
  try {
    await app.service.setEnabled(true);
    assert.equal((await app.service.status()).tailscaleRouteState, "reconciliation_required");
    await assert.rejects(app.service.beginPairing("tailscale"), /Verify the previous Tailscale route update/u);
    await app.service.reconcileTailscale();
    assert.equal(app.tailscale.reconciles, 1);
    assert.deepEqual(app.persisted().tailscaleOwnership, { path: "/api/aiden/v1", target });
    assert.equal(app.persisted().tailscalePendingOutcome, undefined);
  } finally {
    await app.cleanup();
  }
});

test("a pending disconnect blocks every direct Tailscale operation and pairing until reconciliation", async () => {
  let target = "";
  const app = await fixture({
    mode: "both",
    initial: (state) => {
      target = `http://127.0.0.1:${state.lanPort + 1}/api/aiden/v1`;
      state.tailscaleOwnership = { path: "/api/aiden/v1", target };
      state.tailscalePendingOutcome = {
        operation: "disconnect",
        target,
        previousTarget: target,
        beforeFingerprint: "a".repeat(64),
        preservedFingerprint: "b".repeat(64),
        normalizeListenerScaffolding: false,
        createdAt: 1_000,
      };
    },
  });
  try {
    await app.service.setEnabled(true);
    for (const action of [
      () => app.service.connectTailscale(),
      () => app.service.disconnectTailscale(),
      () => app.service.reviewTailscaleTakeover(),
      () => app.service.takeOverTailscale("A".repeat(32)),
    ]) {
      await assert.rejects(action(), /tailscale_reconciliation_required/u);
    }
    await assert.rejects(
      app.service.beginPairing("tailscale"),
      /Verify the previous Tailscale route update/u,
    );
    await app.service.reconcileTailscale();
    assert.equal(app.persisted().tailscaleOwnership, undefined);
    assert.equal(app.persisted().tailscalePendingOutcome, undefined);
  } finally {
    await app.cleanup();
  }
});

test("pairing windows expose no secret until a local desktop action begins one", async () => {
  const app = await fixture();
  try {
    await app.service.setEnabled(true);
    const pairing = await app.service.beginPairing("lan");
    const { bootstrap } = pairing;
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
    const { bootstrap: firstBootstrap } = await app.service.beginPairing("lan");
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

    const { bootstrap: repairBootstrap } = await app.service.beginPairing("lan");
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

test("two paired devices authenticate independently and revoking one leaves the other active", async () => {
  const app = await fixture();
  try {
    await app.service.setEnabled(true);
    const pairDevice = async (deviceName: string) => {
      const { bootstrap } = await app.service.beginPairing("lan");
      const exchange = await insecureJson<{ deviceId: string; credential: string }>(
        app.persisted().lanPort,
        "/api/aiden/v1/pairing/exchange",
        {
          method: "POST",
          body: {
            secret: bootstrap.secret,
            deviceName,
            deviceType: "iphone",
            clientVersion: "1.0",
          },
        },
      );
      assert.equal(exchange.status, 200);
      return exchange.body;
    };
    const first = await pairDevice("Personal iPhone");
    const second = await pairDevice("Travel iPhone");
    assert.notEqual(first.deviceId, second.deviceId);
    assert.notEqual(first.credential, second.credential);

    const authenticate = (credential: string) => insecureJson<{ instanceId: string }>(
      app.persisted().lanPort,
      "/api/aiden/v1/server",
      {
        headers: {
          authorization: `Bearer ${credential}`,
          "aiden-protocol-version": "1",
        },
      },
    );
    const [firstServer, secondServer] = await Promise.all([
      authenticate(first.credential),
      authenticate(second.credential),
    ]);
    assert.equal(firstServer.status, 200);
    assert.equal(secondServer.status, 200);
    assert.equal(firstServer.body.instanceId, app.persisted().instanceId);
    assert.equal(secondServer.body.instanceId, app.persisted().instanceId);

    assert.equal(await revokeAidenRemoteRuntimeDevice({
      state: app.state,
      workspaceOwners: { revokeDevice: () => undefined },
    }, first.deviceId), true);
    const revoked = await insecureJson<{ error: { code: string } }>(
      app.persisted().lanPort,
      "/api/aiden/v1/server",
      {
        headers: {
          authorization: `Bearer ${first.credential}`,
          "aiden-protocol-version": "1",
        },
      },
    );
    const unaffected = await authenticate(second.credential);
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.error.code, "credential_revoked");
    assert.equal(unaffected.status, 200);
    assert.equal(unaffected.body.instanceId, app.persisted().instanceId);

    const devices = (await app.state.snapshot()).devices;
    const firstDevice = devices.find(({ id }) => id === first.deviceId);
    const secondDevice = devices.find(({ id }) => id === second.deviceId);
    assert.ok(firstDevice?.revokedAt);
    assert.ok((firstDevice?.lastSeenAt ?? 0) > 0);
    assert.equal(secondDevice?.revokedAt, undefined);
    assert.ok((secondDevice?.lastSeenAt ?? 0) > 0);

    const serialized = JSON.stringify(app.persisted());
    assert.equal(serialized.includes(first.credential), false);
    assert.equal(serialized.includes(second.credential), false);
  } finally {
    await app.cleanup();
  }
});
