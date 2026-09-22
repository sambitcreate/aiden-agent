import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import test from "node:test";
import {
  AidenRemoteTailscaleController,
  createSystemTailscaleCommandRunner,
  withAidenTailscaleRouteLock,
  type AidenTailscaleCommandRunner,
  type AidenTailscaleStatusReadFailureCategory,
} from "./aiden-remote-tailscale.js";

const target = "http://127.0.0.1:43177/api/aiden/v1";

test("system Tailscale runner forces CLI mode for Finder-style production launches", async () => {
  const executions: Array<{
    binary: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv | undefined;
  }> = [];
  const runner = await createSystemTailscaleCommandRunner({
    environment: {
      HOME: "/test-home",
      TAILSCALE_BE_CLI: "0",
    },
    resolveBinary: async () => "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    execute: async (binary, args, options) => {
      executions.push({ binary, args: [...args], environment: options.env });
      if (options.env?.TAILSCALE_BE_CLI !== "1") {
        return { stdout: "The Tailscale GUI failed to start." };
      }
      return {
        stdout: args[0] === "status"
          ? JSON.stringify({
            Self: { DNSName: "aiden.tailnet.ts.net." },
            CertDomains: ["aiden.tailnet.ts.net"],
          })
          : "{}",
      };
    },
  });
  assert.ok(runner);

  const inspection = await new AidenRemoteTailscaleController(runner).inspectRoute(target);
  assert.equal(inspection.connectionStatus.dnsName, "aiden.tailnet.ts.net");
  assert.equal(inspection.assessment.state, "available");
  assert.equal(executions.length, 2);
  for (const execution of executions) {
    assert.equal(execution.binary, "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    assert.equal(execution.environment?.HOME, "/test-home");
    assert.equal(execution.environment?.TERM, undefined);
    assert.equal(execution.environment?.TAILSCALE_BE_CLI, "1");
  }
});

async function availableLoopbackPort(): Promise<number> {
  const socket = createSocket({ type: "udp4", reuseAddr: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind({ address: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

function fixture(options: { emptyServeStatus?: boolean; certDomains?: unknown } = {}) {
  const calls: string[][] = [];
  let connected = false;
  const runner: AidenTailscaleCommandRunner = {
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return JSON.stringify({
          Self: { DNSName: "aiden.tailnet.ts.net." },
          CertDomains: options.certDomains ?? ["aiden.tailnet.ts.net"],
        });
      }
      if (args[0] === "serve" && args[1] === "status") {
        if (options.emptyServeStatus && !connected) return "{}";
        return JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: {
            "aiden.tailnet.ts.net:443": {
              Handlers: connected
                ? {
                    "/api/aiden/v1": { Proxy: target },
                    ...(options.emptyServeStatus ? {} : { "/other": { Proxy: "http://127.0.0.1:9" } }),
                  }
                : { "/other": { Proxy: "http://127.0.0.1:9" } },
            },
          },
        });
      }
      if (args.includes("off")) connected = false;
      else connected = true;
      return "";
    },
  };
  return { controller: new AidenRemoteTailscaleController(runner), calls };
}

test("Tailscale controller connects and verifies only Aiden's route", async () => {
  const app = fixture();
  const ownership = await app.controller.connect(target);
  assert.deepEqual(ownership, { path: "/api/aiden/v1", target });
  assert.deepEqual(app.calls.find((args) => args.includes("--set-path=/api/aiden/v1") && !args.includes("off")), [
    "serve", "--yes", "--bg", "--https=443", "--set-path=/api/aiden/v1", target,
  ]);
  assert.equal(app.calls.some((args) => args.includes("reset")), false);
  assert.equal(app.calls.some((args) => args.includes("funnel")), false);

  await app.controller.disconnect(target, ownership);
  assert.deepEqual(app.calls[app.calls.length - 2], [
    "serve", "--https=443", "--set-path=/api/aiden/v1", "off",
  ]);
});

test("Tailscale controller reports stable URL identity without mutating configuration", async () => {
  const app = fixture();
  assert.deepEqual(await app.controller.status(), {
    installed: true,
    dnsName: "aiden.tailnet.ts.net",
    httpsAvailable: true,
    serveStatus: {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "aiden.tailnet.ts.net:443": {
          Handlers: { "/other": { Proxy: "http://127.0.0.1:9" } },
        },
      },
    },
  });
  assert.equal(app.calls.length, 2);
  assert.deepEqual(app.calls.find((args) => args[0] === "status"), [
    "status", "--json", "--peers=false",
  ]);
});

test("combined route inspection uses one coherent node and Serve snapshot", async () => {
  const app = takeoverFixture({ incumbent: target, healthy: true });
  const inspection = await app.controller.inspectRoute(target);
  assert.equal(inspection.connectionStatus.dnsName, "aiden.tailnet.ts.net");
  assert.equal(inspection.assessment.state, "other_aiden_live");
  assert.deepEqual(app.calls, [
    ["status", "--json", "--peers=false"],
    ["serve", "status", "--json"],
  ]);
});

test("combined route inspection retries a transient CLI read and recovers", async () => {
  const calls: string[][] = [];
  let nodeAttempts = 0;
  const controller = new AidenRemoteTailscaleController({
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "status" && ++nodeAttempts === 1) {
        throw new Error("transient node status failure");
      }
      if (args[0] === "status") {
        return JSON.stringify({
          Self: { DNSName: "aiden.tailnet.ts.net." },
          CertDomains: ["aiden.tailnet.ts.net"],
        });
      }
      return "{}";
    },
  });
  const inspection = await controller.inspectRoute(target);
  assert.equal(inspection.connectionStatus.dnsName, "aiden.tailnet.ts.net");
  assert.equal(inspection.assessment.state, "available");
  assert.deepEqual(calls, [
    ["status", "--json", "--peers=false"],
    ["status", "--json", "--peers=false"],
    ["serve", "status", "--json"],
  ]);
});

test("combined route inspection fails closed after bounded CLI retries", async () => {
  const calls: string[][] = [];
  const diagnostics: Array<{
    phase: "node" | "serve";
    attempt: number;
    final: boolean;
    category: AidenTailscaleStatusReadFailureCategory;
  }> = [];
  const controller = new AidenRemoteTailscaleController({
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "status") throw new Error("transient node status failure");
      return "{}";
    },
  }, { onStatusReadFailure: (input) => diagnostics.push(input) });
  assert.deepEqual(await controller.inspectRoute(target), {
    connectionStatus: { installed: true, errorCode: "status_unavailable" },
    assessment: { state: "unavailable", errorCode: "status_unavailable" },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(diagnostics, [
    { phase: "node", attempt: 1, final: false, category: "command-failed" },
    { phase: "node", attempt: 2, final: false, category: "command-failed" },
    { phase: "node", attempt: 3, final: true, category: "command-failed" },
  ]);
});

test("combined route inspection categorizes zero-exit non-JSON CLI output without retaining it", async () => {
  const diagnostics: Array<{
    phase: "node" | "serve";
    attempt: number;
    final: boolean;
    category: AidenTailscaleStatusReadFailureCategory;
  }> = [];
  const controller = new AidenRemoteTailscaleController({
    run: async () => "The Tailscale GUI failed to start with private details.",
  }, { onStatusReadFailure: (input) => diagnostics.push(input) });

  assert.equal((await controller.inspectRoute(target)).assessment.errorCode, "status_unavailable");
  assert.deepEqual(diagnostics, [
    { phase: "node", attempt: 1, final: false, category: "invalid-response" },
    { phase: "node", attempt: 2, final: false, category: "invalid-response" },
    { phase: "node", attempt: 3, final: true, category: "invalid-response" },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private details/u);
});

test("combined route inspection categorizes both Node CLI timeout shapes", async () => {
  const timeoutErrors = [
    Object.assign(new Error("deadline exceeded"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("process terminated"), { killed: true }),
  ];

  for (const timeoutError of timeoutErrors) {
    const diagnostics: Array<{
      phase: "node" | "serve";
      attempt: number;
      final: boolean;
      category: AidenTailscaleStatusReadFailureCategory;
    }> = [];
    const controller = new AidenRemoteTailscaleController({
      run: async () => {
        throw timeoutError;
      },
    }, { onStatusReadFailure: (input) => diagnostics.push(input) });

    assert.equal((await controller.inspectRoute(target)).assessment.errorCode, "status_unavailable");
    assert.deepEqual(diagnostics, [
      { phase: "node", attempt: 1, final: false, category: "timed-out" },
      { phase: "node", attempt: 2, final: false, category: "timed-out" },
      { phase: "node", attempt: 3, final: true, category: "timed-out" },
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /deadline exceeded|process terminated/u);
  }
});

test("concurrent settings reads share one node and Serve snapshot", async () => {
  const app = fixture();
  const [status, inspection] = await Promise.all([
    app.controller.status(),
    app.controller.inspectRoute(target),
  ]);
  assert.equal(status.dnsName, "aiden.tailnet.ts.net");
  assert.equal(inspection.connectionStatus.dnsName, "aiden.tailnet.ts.net");
  assert.equal(app.calls.length, 2);
});

test("Tailscale controller creates the first HTTPS listener only after exact certificate-domain proof", async () => {
  const app = fixture({ emptyServeStatus: true });
  const ownership = await app.controller.connect(target);
  assert.deepEqual(ownership, { path: "/api/aiden/v1", target });
  assert.deepEqual(app.calls.find((args) => args.includes("--set-path=/api/aiden/v1") && !args.includes("off")), [
    "serve", "--yes", "--bg", "--https=443", "--set-path=/api/aiden/v1", target,
  ]);
});

test("first-listener verification rejects a route without explicit TCP 443 HTTPS state", async () => {
  const calls: string[][] = [];
  const brokenStatus = {
    Web: {
      "aiden.tailnet.ts.net:443": {
        Handlers: {} as Record<string, { Proxy: string }>,
      },
    },
  };
  const runner: AidenTailscaleCommandRunner = {
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return JSON.stringify({
          Self: { DNSName: "aiden.tailnet.ts.net." },
          CertDomains: ["aiden.tailnet.ts.net"],
        });
      }
      if (args[0] === "serve" && args[1] === "status") {
        return calls.filter((call) => call.includes("--set-path=/api/aiden/v1")).length === 0
          ? "{}"
          : JSON.stringify(brokenStatus);
      }
      const nextTarget = args[args.length - 1];
      if (nextTarget !== "off") {
        brokenStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"] = {
          Proxy: nextTarget!,
        };
      }
      return "";
    },
  };
  const controller = new AidenRemoteTailscaleController(runner);
  let persistCalls = 0;
  await assert.rejects(
    controller.connect(target, undefined, async () => { persistCalls += 1; }),
    /tailscale_route_(verification|recovery)_failed/u,
  );
  assert.equal(persistCalls, 0);
});

test("Tailscale controller refuses first-listener mutation without exact HTTPS eligibility", async () => {
  for (const certDomains of [[], ["other.tailnet.ts.net"], ["aiden.tailnet.ts.net.evil"]]) {
    const app = fixture({ emptyServeStatus: true, certDomains });
    await assert.rejects(app.controller.connect(target), /tailscale_https_unavailable/u);
    assert.equal(app.calls.some((args) => args.includes("--set-path=/api/aiden/v1")), false);
  }
});

test("an owned handler without TCP 443 HTTPS is never accepted as a connected no-op", async () => {
  const app = takeoverFixture({ incumbent: target });
  delete (app.serveStatus as { TCP?: unknown }).TCP;
  const ownership = { path: "/api/aiden/v1" as const, target };
  assert.deepEqual(
    await app.controller.assessRoute(target, ownership),
    { state: "unrelated_conflict" },
  );
  await assert.rejects(
    app.controller.connect(target, ownership),
    /tailscale_route_conflict/u,
  );
});

test("missing Tailscale is explicit and cannot mutate routes", async () => {
  const controller = new AidenRemoteTailscaleController(null);
  assert.deepEqual(await controller.status(), {
    installed: false,
    errorCode: "not_installed",
  });
  await assert.rejects(controller.connect(target), /tailscale_not_installed/u);
});

function takeoverFixture(options: {
  incumbent?: string;
  healthy?: boolean;
  now?: number;
  failMutation?: boolean;
} = {}) {
  const incumbent = options.incumbent ?? "http://127.0.0.1:43179/api/aiden/v1";
  const calls: string[][] = [];
  let healthy = options.healthy ?? false;
  let now = options.now ?? 1_000;
  let monotonicNow = options.now ?? 1_000;
  let failMutation = options.failMutation ?? false;
  let failAfterMutation = false;
  let dropTcpAfterMutation = false;
  let postMutationStatusFailures = 0;
  let mutationApplied = false;
  let mutateAfterNextStatusRead: string | undefined;
  let pendingOutcome: import("./aiden-remote-tailscale.js").AidenTailscalePendingRouteOutcome | undefined;
  let reconciledOwnership: { path: "/api/aiden/v1"; target: string } | undefined;
  const serveStatus = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      "aiden.tailnet.ts.net:443": {
        Handlers: {
          "/api/aiden/v1": { Proxy: incumbent },
          "/other": { Proxy: "http://127.0.0.1:9" },
        },
      },
    },
  };
  const runner: AidenTailscaleCommandRunner = {
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return JSON.stringify({
          Self: { DNSName: "aiden.tailnet.ts.net." },
          CertDomains: ["aiden.tailnet.ts.net"],
        });
      }
      if (args[0] === "serve" && args[1] === "status") {
        if (mutationApplied && postMutationStatusFailures > 0) {
          postMutationStatusFailures -= 1;
          throw new Error("tailscaled status unavailable");
        }
        const serialized = JSON.stringify(serveStatus);
        if (mutateAfterNextStatusRead) {
          (serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers as Record<string, { Proxy: string }>)["/api/aiden/v1"] = {
            Proxy: mutateAfterNextStatusRead,
          };
          mutateAfterNextStatusRead = undefined;
        }
        return serialized;
      }
      if (failMutation) throw new Error("command failed");
      const nextTarget = args[args.length - 1];
      if (nextTarget === "off") {
        delete (serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers as Record<string, { Proxy: string }>)["/api/aiden/v1"];
      } else {
        (serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers as Record<string, { Proxy: string }>)["/api/aiden/v1"] = { Proxy: nextTarget! };
      }
      mutationApplied = true;
      if (dropTcpAfterMutation) delete (serveStatus as { TCP?: unknown }).TCP;
      if (failAfterMutation) throw new Error("command outcome unknown");
      return "";
    },
  };
  const controller = new AidenRemoteTailscaleController(runner, {
    now: () => now,
    monotonicNow: () => monotonicNow,
    randomToken: () => "A".repeat(32),
    probeHealth: async () => healthy,
    outcomeStore: {
      begin: async (outcome) => { pendingOutcome = structuredClone(outcome); },
      snapshot: async () => structuredClone(pendingOutcome),
      commit: async (ownership) => {
        reconciledOwnership = ownership;
        pendingOutcome = undefined;
      },
      clear: async () => { pendingOutcome = undefined; },
    },
  });
  return {
    controller,
    runner,
    calls,
    serveStatus,
    setHealthy: (value: boolean) => { healthy = value; },
    setNow: (value: number) => { now = value; monotonicNow = value; },
    setWallClock: (value: number) => { now = value; },
    setFailMutation: (value: boolean) => { failMutation = value; },
    setFailAfterMutation: (value: boolean) => { failAfterMutation = value; },
    setDropTcpAfterMutation: (value: boolean) => { dropTcpAfterMutation = value; },
    failNextPostMutationStatusReads: (count: number) => { postMutationStatusFailures = count; },
    pendingOutcome: () => structuredClone(pendingOutcome),
    reconciledOwnership: () => structuredClone(reconciledOwnership),
    setRouteTarget: (value: string) => {
      (serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers as Record<string, { Proxy: string }>)["/api/aiden/v1"] = { Proxy: value };
    },
    mutateRouteAfterNextStatusRead: (value: string) => { mutateAfterNextStatusRead = value; },
  };
}

test("live Aiden route is classified and cannot produce a takeover review", async () => {
  const app = takeoverFixture({ healthy: true });
  assert.deepEqual(await app.controller.assessRoute(target), { state: "other_aiden_live" });
  await assert.rejects(app.controller.reviewTakeover(target), /tailscale_route_live/u);
  assert.equal(app.calls.some((args) => args.includes("--set-path=/api/aiden/v1")), false);
});

test("unrelated handlers and Funnel conflicts never offer takeover", async () => {
  const unrelated = takeoverFixture();
  unrelated.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy = "http://127.0.0.1:43179/private";
  assert.deepEqual(await unrelated.controller.assessRoute(target), { state: "unrelated_conflict" });
  await assert.rejects(unrelated.controller.reviewTakeover(target), /tailscale_takeover_unavailable/u);

  const funnel = takeoverFixture();
  (funnel.serveStatus.Web["aiden.tailnet.ts.net:443"] as { Funnel?: boolean }).Funnel = true;
  assert.deepEqual(await funnel.controller.assessRoute(target), { state: "funnel_conflict" });
  await assert.rejects(funnel.controller.reviewTakeover(target), /tailscale_takeover_unavailable/u);
  assert.equal(funnel.calls.some((args) => args.includes("--set-path=/api/aiden/v1")), false);
});

test("stale Aiden route requires a one-use review and preserves unrelated Serve state", async () => {
  const app = takeoverFixture();
  assert.deepEqual(await app.controller.assessRoute(target), { state: "other_aiden_stale" });
  const unrelatedBefore = JSON.stringify(
    app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/other"],
  );
  const review = await app.controller.reviewTakeover(target);
  assert.equal(review.token, "A".repeat(32));
  let persisted: unknown;
  await app.controller.takeOver(target, review.token, async (ownership) => {
    persisted = ownership;
  });
  assert.deepEqual(persisted, { path: "/api/aiden/v1", target });
  assert.equal(
    app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy,
    target,
  );
  assert.equal(
    JSON.stringify(app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/other"]),
    unrelatedBefore,
  );
  assert.equal(app.calls.some((args) => args.includes("reset") || args.includes("funnel")), false);
  await assert.rejects(
    app.controller.takeOver(target, review.token, async () => undefined),
    /tailscale_takeover_expired/u,
  );
});

test("takeover fails closed when Serve state or incumbent health changes after review", async () => {
  const changed = takeoverFixture();
  const changedReview = await changed.controller.reviewTakeover(target);
  changed.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/other"].Proxy = "http://127.0.0.1:10";
  await assert.rejects(
    changed.controller.takeOver(target, changedReview.token, async () => undefined),
    /tailscale_takeover_changed/u,
  );
  assert.equal(changed.calls.some((args) => args.includes("--set-path=/api/aiden/v1")), false);

  const revived = takeoverFixture();
  const revivedReview = await revived.controller.reviewTakeover(target);
  revived.setHealthy(true);
  await assert.rejects(
    revived.controller.takeOver(target, revivedReview.token, async () => undefined),
    /tailscale_route_live/u,
  );
  assert.equal(revived.calls.some((args) => args.includes("--set-path=/api/aiden/v1")), false);
});

test("expired takeover reviews and failed commands never persist ownership", async () => {
  const expired = takeoverFixture({ now: 10 });
  const review = await expired.controller.reviewTakeover(target);
  expired.setNow(review.expiresAt);
  await assert.rejects(
    expired.controller.takeOver(target, review.token, async () => undefined),
    /tailscale_takeover_expired/u,
  );

  const failed = takeoverFixture({ failMutation: true });
  const failedReview = await failed.controller.reviewTakeover(target);
  let persistCalls = 0;
  await assert.rejects(
    failed.controller.takeOver(target, failedReview.token, async () => { persistCalls += 1; }),
    /tailscale_route_outcome_unknown/u,
  );
  assert.equal(persistCalls, 0);
});

test("ownership persistence failure restores the exact stale incumbent route", async () => {
  const incumbent = "http://127.0.0.1:43179/api/aiden/v1";
  const app = takeoverFixture({ incumbent });
  const review = await app.controller.reviewTakeover(target);
  await assert.rejects(
    app.controller.takeOver(target, review.token, async () => { throw new Error("disk full"); }),
    /tailscale_ownership_commit_failed/u,
  );
  assert.equal(
    app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy,
    incumbent,
  );
});

test("persistence rollback never overwrites a route changed by an external successor", async () => {
  const successor = "http://127.0.0.1:43183/api/aiden/v1";

  const connect = takeoverFixture();
  delete (connect.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers as Record<string, { Proxy: string }>)["/api/aiden/v1"];
  await assert.rejects(
    connect.controller.connect(target, undefined, async () => {
      await connect.runner.run(["serve", "--yes", "--bg", "--https=443", "--set-path=/api/aiden/v1", successor]);
      throw new Error("disk full");
    }),
    /tailscale_route_recovery_failed/u,
  );
  assert.equal(connect.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy, successor);

  const takeover = takeoverFixture();
  const takeoverReview = await takeover.controller.reviewTakeover(target);
  await assert.rejects(
    takeover.controller.takeOver(target, takeoverReview.token, async () => {
      await takeover.runner.run(["serve", "--yes", "--bg", "--https=443", "--set-path=/api/aiden/v1", successor]);
      throw new Error("disk full");
    }),
    /tailscale_route_recovery_failed/u,
  );
  assert.equal(takeover.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy, successor);

  const disconnect = takeoverFixture({ incumbent: target });
  await assert.rejects(
    disconnect.controller.disconnect(target, { path: "/api/aiden/v1", target }, async () => {
      await disconnect.runner.run(["serve", "--yes", "--bg", "--https=443", "--set-path=/api/aiden/v1", successor]);
      throw new Error("disk full");
    }),
    /tailscale_route_recovery_failed/u,
  );
  assert.equal(disconnect.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy, successor);
});

test("an ambiguous CLI error is reconciled when the exact route was safely applied", async () => {
  const app = takeoverFixture();
  const review = await app.controller.reviewTakeover(target);
  app.setFailAfterMutation(true);
  let persisted = false;
  await app.controller.takeOver(target, review.token, async () => { persisted = true; });
  assert.equal(persisted, true);
  assert.equal(app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy, target);
});

test("post-mutation status retries transient failures and durably reconciles an unknown exact outcome", async () => {
  const transient = takeoverFixture();
  const transientReview = await transient.controller.reviewTakeover(target);
  transient.failNextPostMutationStatusReads(2);
  let transientPersisted = false;
  await transient.controller.takeOver(target, transientReview.token, async () => {
    transientPersisted = true;
  });
  assert.equal(transientPersisted, true);

  const unknown = takeoverFixture();
  const unknownReview = await unknown.controller.reviewTakeover(target);
  unknown.failNextPostMutationStatusReads(3);
  let persistCalls = 0;
  await assert.rejects(
    unknown.controller.takeOver(target, unknownReview.token, async () => { persistCalls += 1; }),
    /tailscale_route_outcome_unknown/u,
  );
  assert.equal(persistCalls, 0);
  assert.equal(unknown.pendingOutcome()?.operation, "takeover");
  unknown.setHealthy(true);
  assert.equal(await unknown.controller.reconcilePendingOutcome(), "connected");
  assert.deepEqual(unknown.reconciledOwnership(), { path: "/api/aiden/v1", target });
  assert.equal(unknown.pendingOutcome(), undefined);
});

test("not-applied reconciliation retains its durable record when a delayed mutation appears", async () => {
  const incumbent = "http://127.0.0.1:43179/api/aiden/v1";
  const app = takeoverFixture({ incumbent });
  const review = await app.controller.reviewTakeover(target);
  app.failNextPostMutationStatusReads(3);
  await assert.rejects(
    app.controller.takeOver(target, review.token, async () => undefined),
    /tailscale_route_outcome_unknown/u,
  );
  app.setRouteTarget(incumbent);
  app.mutateRouteAfterNextStatusRead(target);
  await assert.rejects(
    app.controller.reconcilePendingOutcome(),
    /tailscale_reconciliation_conflict/u,
  );
  assert.equal(app.pendingOutcome()?.operation, "takeover");
});

test("applied-disconnect reconciliation retains its record when a route reappears", async () => {
  const app = takeoverFixture({ incumbent: target });
  app.failNextPostMutationStatusReads(3);
  await assert.rejects(
    app.controller.disconnect(target, { path: "/api/aiden/v1", target }),
    /tailscale_route_outcome_unknown/u,
  );
  app.mutateRouteAfterNextStatusRead(target);
  await assert.rejects(
    app.controller.reconcilePendingOutcome(),
    /tailscale_reconciliation_conflict/u,
  );
  assert.equal(app.pendingOutcome()?.operation, "disconnect");
});

test("takeover verification rejects removal of TCP 443 needed by unrelated handlers", async () => {
  const app = takeoverFixture();
  const review = await app.controller.reviewTakeover(target);
  app.setDropTcpAfterMutation(true);
  let persistCalls = 0;
  await assert.rejects(
    app.controller.takeOver(target, review.token, async () => { persistCalls += 1; }),
    /tailscale_route_(verification|recovery)_failed/u,
  );
  assert.equal(persistCalls, 0);
});

test("takeover re-reads Serve immediately after the health probe", async () => {
  const app = takeoverFixture();
  let probes = 0;
  const successor = "http://127.0.0.1:43183/api/aiden/v1";
  const controller = new AidenRemoteTailscaleController(app.runner, {
    now: () => 1_000,
    monotonicNow: () => 1_000,
    randomToken: () => "C".repeat(32),
    probeHealth: async () => {
      probes += 1;
      if (probes === 2) {
        app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy = successor;
      }
      return false;
    },
  });
  const review = await controller.reviewTakeover(target);
  await assert.rejects(
    controller.takeOver(target, review.token, async () => undefined),
    /tailscale_takeover_changed/u,
  );
  assert.equal(app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy, successor);
});

test("takeover expiry uses monotonic time even when the wall clock moves backward", async () => {
  const app = takeoverFixture({ now: 5_000 });
  const review = await app.controller.reviewTakeover(target);
  app.setWallClock(-50_000);
  app.setNow(review.expiresAt);
  app.setWallClock(-50_000);
  await assert.rejects(
    app.controller.takeOver(target, review.token, async () => undefined),
    /tailscale_takeover_expired/u,
  );
});

test("an old owner cannot disconnect a successor route", async () => {
  const successor = "http://127.0.0.1:43179/api/aiden/v1";
  const app = takeoverFixture({ incumbent: successor });
  await assert.rejects(
    app.controller.disconnect(target, { path: "/api/aiden/v1", target }),
    /tailscale_route_conflict/u,
  );
  assert.equal(
    app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy,
    successor,
  );
});

test("separate Aiden controllers serialize competing takeovers across the Mac", async () => {
  const app = takeoverFixture();
  const second = new AidenRemoteTailscaleController(app.runner, {
    now: () => 1_000,
    randomToken: () => "B".repeat(32),
    probeHealth: async () => false,
  });
  const [firstReview, secondReview] = await Promise.all([
    app.controller.reviewTakeover(target),
    second.reviewTakeover("http://127.0.0.1:43181/api/aiden/v1"),
  ]);
  const persisted: string[] = [];
  const results = await Promise.allSettled([
    app.controller.takeOver(target, firstReview.token, async (ownership) => {
      persisted.push(ownership.target);
    }),
    second.takeOver(
      "http://127.0.0.1:43181/api/aiden/v1",
      secondReview.token,
      async (ownership) => { persisted.push(ownership.target); },
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(
    app.serveStatus.Web["aiden.tailnet.ts.net:443"].Handlers["/api/aiden/v1"].Proxy,
    persisted[0],
  );
});

test("kernel-owned route lock blocks concurrent owners and releases cleanly", async () => {
  const port = await availableLoopbackPort();
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const didAcquire = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withAidenTailscaleRouteLock(async () => {
    acquired();
    return held;
  }, { port, attempts: 1, retryMs: 1 });
  await didAcquire;
  await assert.rejects(
    withAidenTailscaleRouteLock(async () => undefined, { port, attempts: 1, retryMs: 1 }),
    /tailscale_route_busy/u,
  );
  release();
  await holder;
  await withAidenTailscaleRouteLock(async () => undefined, { port, attempts: 1, retryMs: 1 });
});

test("route lock cannot collide with a retained Aiden TCP listener on the same port", async () => {
  const port = await availableLoopbackPort();
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  try {
    await withAidenTailscaleRouteLock(async () => undefined, {
      port,
      attempts: 1,
      retryMs: 1,
    });
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
