import assert from "node:assert/strict";
import test from "node:test";
import type { CuaDriverHostLike, CuaDriverSessionLike } from "./controller.js";
import {
  computerUsePlatformSupported,
  CUA_DRIVER_TCC_HOST_BUNDLE_ID,
  CuaDriverError,
} from "./contract.js";
import { ComputerUseStatusService } from "./status-core.js";

function toolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: "status" }],
    structuredContent,
  };
}

function health(overrides: Record<string, unknown> = {}) {
  return toolResult({
    overall: "ok",
    platform: "darwin",
    schema_version: "1",
    driver_version: "0.8.3",
    checks: [
      { name: "binary_version", status: "pass" },
      { name: "platform_supported", status: "pass" },
      { name: "session_active", status: "pass" },
    ],
    ...overrides,
  });
}

function permissions(
  accessibility: boolean,
  screenRecording: boolean,
  overrides: Record<string, unknown> = {},
) {
  return toolResult({
    accessibility,
    screen_recording: screenRecording,
    screen_recording_capturable: screenRecording,
    source: {
      attribution: "host",
      embedded: true,
      host_bundle_id: CUA_DRIVER_TCC_HOST_BUNDLE_ID,
      disclaim_env: false,
    },
    ...overrides,
  });
}

function fakeHost(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  handler: (name: string, args: Record<string, unknown>) => unknown,
  onShutdown: () => void = () => {},
): CuaDriverHostLike {
  const session = {
    ready: true,
    toolCatalog: new Map(),
    supports: () => false,
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return handler(name, args);
    },
    close: async () => {},
  } satisfies CuaDriverSessionLike;
  return {
    createSession: async () => session,
    shutdown: async () => onShutdown(),
  };
}

test("keeps the disabled beta inert without constructing a privileged host", async () => {
  let hosts = 0;
  const service = new ComputerUseStatusService({
    isEnabled: async () => false,
    createHost: async () => {
      hosts += 1;
      throw new Error("must not run");
    },
  });

  const status = await service.status();
  assert.equal(status.state, "disabled");
  assert.equal(status.ready, false);
  assert.equal(hosts, 0);
});

test("gates the helper at the exact macOS 14.4 boundary", () => {
  assert.equal(computerUsePlatformSupported("darwin", "14.3.9"), false);
  assert.equal(computerUsePlatformSupported("darwin", "14.4"), true);
  assert.equal(computerUsePlatformSupported("darwin", "15.0"), true);
  assert.equal(computerUsePlatformSupported("linux", "14.4"), false);
  assert.equal(computerUsePlatformSupported("darwin", "unknown"), false);
});

test("accepts only the pinned healthy driver with both macOS permissions", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let hosts = 0;
  let shutdowns = 0;
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () => {
      hosts += 1;
      return fakeHost(
        calls,
        (name) => (name === "health_report" ? health() : permissions(true, true)),
        () => {
          shutdowns += 1;
        },
      );
    },
  });

  const [first, concurrent] = await Promise.all([service.status(), service.status()]);
  const cached = await service.status();
  assert.equal(first.state, "ready");
  assert.equal(first.ready, true);
  assert.equal(first.driverVersion, "0.8.3");
  assert.equal(cached, first);
  assert.equal(concurrent, first);
  assert.equal(hosts, 1);
  assert.equal(shutdowns, 1);
  assert.deepEqual(calls, [
    {
      name: "health_report",
      args: { include: ["binary_version", "platform_supported", "session_active"] },
    },
    { name: "check_permissions", args: { prompt: false } },
  ]);
});

test("invalidating an in-flight probe prevents stale readiness from crossing the global gate", async () => {
  let enabled = true;
  let hosts = 0;
  const service = new ComputerUseStatusService({
    isEnabled: async () => enabled,
    createHost: async () => {
      hosts += 1;
      if (hosts === 1) {
        return {
          createSession: async (signal?: AbortSignal) =>
            new Promise<CuaDriverSessionLike>((_resolve, reject) => {
              const fail = () => reject(new CuaDriverError("cancelled", "cancelled"));
              signal?.addEventListener("abort", fail, { once: true });
              if (signal?.aborted) fail();
            }),
          shutdown: async () => {},
        };
      }
      return fakeHost([], (name) =>
        name === "health_report" ? health() : permissions(true, true),
      );
    },
  });

  const stale = service.status();
  await new Promise((resolve) => setImmediate(resolve));
  enabled = false;
  service.invalidate();
  assert.equal((await service.status()).state, "disabled");
  assert.equal((await stale).state, "disabled");

  enabled = true;
  service.invalidate();
  assert.equal((await service.status()).state, "ready");
  assert.equal(hosts, 2);
});

test("reports exact missing permissions and prompts only on an explicit request", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let accessibilityGranted = false;
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () =>
      fakeHost(calls, (name, args) => {
        if (name === "health_report") return health();
        if (args.prompt === true) accessibilityGranted = true;
        return permissions(accessibilityGranted, false);
      }),
  });

  const initial = await service.status();
  assert.equal(initial.state, "permission_required");
  assert.equal(initial.canRequestPermissions, true);
  assert.equal(initial.permissions.accessibility, false);
  assert.match(initial.detail, /Accessibility and Screen Recording permissions are required/u);

  const requested = await service.requestPermissions();
  assert.equal(requested.state, "permission_required");
  assert.equal(requested.permissions.accessibility, true);
  assert.equal(requested.permissions.screenRecording, false);
  assert.deepEqual(
    calls.filter((call) => call.name === "check_permissions").map((call) => call.args.prompt),
    [false, true, false],
  );
});

test("requires the live ScreenCaptureKit capability rather than a stale preflight grant", async () => {
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () =>
      fakeHost([], (name) =>
        name === "health_report"
          ? health()
          : permissions(true, true, { screen_recording_capturable: false }),
      ),
  });

  const status = await service.status();
  assert.equal(status.state, "permission_required");
  assert.equal(status.ready, false);
  assert.equal(status.permissions.screenRecording, false);
});

test("rejects a permission report that is not attributed to the pinned embedded host", async () => {
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () =>
      fakeHost([], (name) =>
        name === "health_report"
          ? health()
          : permissions(true, true, {
              source: {
                attribution: "caller",
                embedded: false,
                host_bundle_id: "com.example.other",
                disclaim_env: false,
              },
            }),
      ),
  });

  assert.equal((await service.status()).state, "incompatible");
});

test("a delayed enabled snapshot cannot launch or cache a probe after gate invalidation", async () => {
  let resolveEnabled!: (value: boolean) => void;
  let hosts = 0;
  const service = new ComputerUseStatusService({
    isEnabled: () => new Promise<boolean>((resolve) => (resolveEnabled = resolve)),
    createHost: async () => {
      hosts += 1;
      return fakeHost([], (name) =>
        name === "health_report" ? health() : permissions(true, true),
      );
    },
  });

  const stale = service.status();
  await new Promise((resolve) => setImmediate(resolve));
  service.setRuntimeEnabled(false);
  resolveEnabled(true);

  assert.equal((await stale).state, "disabled");
  assert.equal(hosts, 0);
});

test("permission prompting cannot resume after disable while a stale probe drains", async () => {
  let hosts = 0;
  let permissionCalls = 0;
  let releaseShutdown!: () => void;
  const draining = new Promise<void>((resolve) => (releaseShutdown = resolve));
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () => {
      hosts += 1;
      if (hosts === 1) {
        return {
          createSession: async (signal?: AbortSignal) =>
            new Promise<CuaDriverSessionLike>((_resolve, reject) => {
              const fail = () => reject(new CuaDriverError("cancelled", "cancelled"));
              signal?.addEventListener("abort", fail, { once: true });
              if (signal?.aborted) fail();
            }),
          shutdown: async () => draining,
        };
      }
      return fakeHost([], (name) => {
        if (name === "health_report") return health();
        permissionCalls += 1;
        return permissions(true, true);
      });
    },
  });

  const stale = service.status();
  await new Promise((resolve) => setImmediate(resolve));
  const request = service.requestPermissions();
  await new Promise((resolve) => setImmediate(resolve));
  service.setRuntimeEnabled(false);
  releaseShutdown();

  assert.equal((await request).state, "disabled");
  assert.equal((await stale).state, "disabled");
  assert.equal(hosts, 1);
  assert.equal(permissionCalls, 0);
});

test("caller cancellation rejects permission prompting without relaunching a helper", async () => {
  let hosts = 0;
  let prompts = 0;
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () => {
      hosts += 1;
      const session = {
        ready: true,
        toolCatalog: new Map(),
        supports: () => false,
        callTool: async (
          name: string,
          args: Record<string, unknown> = {},
          options: { signal?: AbortSignal } = {},
        ) => {
          if (name === "health_report") return health();
          if (args.prompt === true) prompts += 1;
          return new Promise<unknown>((_resolve, reject) => {
            const fail = () => reject(new CuaDriverError("cancelled", "cancelled"));
            options.signal?.addEventListener("abort", fail, { once: true });
            if (options.signal?.aborted) fail();
          });
        },
        close: async () => {},
      } satisfies CuaDriverSessionLike;
      return {
        createSession: async () => session,
        shutdown: async () => {},
      };
    },
  });

  const controller = new AbortController();
  const request = service.requestPermissions({ signal: controller.signal });
  while (prompts === 0) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new CuaDriverError("cancelled", "document replaced"));

  await assert.rejects(request, /document replaced|cancelled/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hosts, 1);
  assert.equal(prompts, 1);
});

test("shutdown aborts and awaits a probe-owned helper without permitting relaunch", async () => {
  let shutdowns = 0;
  let hosts = 0;
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () => {
      hosts += 1;
      return {
        createSession: async (signal?: AbortSignal) =>
          new Promise<CuaDriverSessionLike>((_resolve, reject) => {
            const fail = () => reject(new CuaDriverError("cancelled", "cancelled"));
            signal?.addEventListener("abort", fail, { once: true });
            if (signal?.aborted) fail();
          }),
        shutdown: async () => {
          shutdowns += 1;
        },
      };
    },
  });

  const probing = service.status();
  await new Promise((resolve) => setImmediate(resolve));
  await service.shutdown();
  await probing;
  assert.equal(hosts, 1);
  assert.equal(shutdowns, 1);
  assert.equal((await service.status()).state, "error");
  assert.equal(hosts, 1);
});

test("fails closed when health or permission payloads drift", async () => {
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () =>
      fakeHost([], (name) =>
        name === "health_report" ? health({ driver_version: "0.8.4" }) : permissions(true, true),
      ),
  });

  const status = await service.status();
  assert.equal(status.state, "incompatible");
  assert.equal(status.ready, false);
  assert.equal(status.retryable, false);
});

test("does not expose helper diagnostics through public readiness errors", async () => {
  const secret = "PRIVATE-BROKER-DIAGNOSTIC";
  const service = new ComputerUseStatusService({
    isEnabled: async () => true,
    createHost: async () => {
      throw new CuaDriverError("host_identity_invalid", `signature failure: ${secret}`);
    },
  });

  const status = await service.status();
  assert.equal(status.state, "production_build_required");
  assert.doesNotMatch(status.detail, new RegExp(secret, "u"));
});
