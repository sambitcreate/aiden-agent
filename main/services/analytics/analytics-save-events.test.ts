import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { McpServer, StoredProvider } from "../types.js";
import * as featureReports from "./analytics-feature-reports.js";
import * as analyticsReport from "./analytics-report.js";
import { captureAnalyticsEvents } from "./test-support.js";

const nodeRequire = createRequire(import.meta.url);

// These services reach Electron through `platform.ts`, so each runs here as a
// bundle: the service file itself is real, and its direct imports listed in
// `ports` are replaced. The report path and the registry filter are the real ones.
async function load<T>(relativeEntry: string, ports: Record<string, unknown>): Promise<T> {
  const entry = fileURLToPath(new URL(relativeEntry, import.meta.url));
  const everyPort: Record<string, unknown> = {
    ...ports,
    "./analytics/analytics-feature-reports.js": featureReports,
    "../platform.js": { logger: { warn: () => undefined, error: () => undefined, info: () => undefined } },
  };
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [{
      name: "service-ports",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) =>
          args.importer === entry && args.path in everyPort ? { path: args.path, external: true } : undefined);
      },
    }],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    (id: string) => everyPort[id] ?? nodeRequire(id),
    module,
    module.exports,
  );
  return module.exports as T;
}

async function providerRotation(saveFails = false) {
  const providers = new Map<string, StoredProvider>();
  return load<typeof import("../provider-credential-rotation.js")>("../provider-credential-rotation.ts", {
    "./config-store.js": {
      configStore: {
        listProviders: async () => [...providers.values()],
        portableConfigSafeForCredentialReconciliation: async () => true,
        cachedPortableConfigSafeForCredentialReconciliation: async () => true,
        getProvider: async (id: string) => providers.get(id),
        saveProvider: async (provider: StoredProvider) => {
          if (saveFails) throw new Error("disk full");
          providers.set(provider.id, provider);
          return provider;
        },
      },
    },
    // An empty keychain: every read finds nothing and every write succeeds.
    "./secrets.js": { secrets: new Proxy({}, { get: () => async () => null }) },
    "./portable-credential-snapshot.js": { mutatePortableConfigAndSync: (operation: () => unknown) => operation() },
  });
}

const provider = (fields: Partial<StoredProvider> = {}) =>
  ({
    id: "custom-office",
    kind: "openai",
    label: "Office gateway",
    baseUrl: "https://llm.example.test/v1",
    models: [],
    needsKey: true,
    ...fields,
  }) as StoredProvider;

test("adding a custom provider counts once; editing it or a failed save counts nothing", async (t) => {
  const sent = captureAnalyticsEvents(t);
  const { saveProviderWithCredentialRotation } = await providerRotation();
  await saveProviderWithCredentialRotation(provider(), "secret-key");
  assert.deepEqual(sent, [{ event: "provider_connected", props: { provider_id: "custom", auth: "key" } }]);

  await saveProviderWithCredentialRotation(provider({ label: "Renamed" }), null);
  assert.equal(sent.length, 1);

  const failing = await providerRotation(true);
  await assert.rejects(failing.saveProviderWithCredentialRotation(provider({ id: "custom-other" }), "key"), /disk full/u);
  assert.equal(sent.length, 1);
});

async function connectorSave(options: { saveFails?: boolean; launchApproved?: boolean } = {}) {
  const servers = new Map<string, McpServer>();
  const mutate = async (
    serverId: string,
    plan: (current: McpServer | undefined) => unknown,
    apply: (current: McpServer | undefined) => Promise<McpServer>,
  ) => {
    plan(servers.get(serverId));
    return apply(servers.get(serverId));
  };
  return load<typeof import("../mcp-server-save.js")>("../mcp-server-save.ts", {
    "./mcp-launch-review.js": { confirmMcpLaunch: async () => options.launchApproved ?? true },
    "./config-store.js": {
      configStore: {
        listMcpServers: async () => [...servers.values()],
        saveMcpServer: async (server: McpServer) => {
          if (options.saveFails) throw new Error("disk full");
          servers.set(server.id, server);
          return server;
        },
      },
    },
    "./mcp.js": { mcpManager: { disconnect: async () => undefined } },
    "./mcp-credential-cleanup.js": { mutateMcpWithCredentialCleanup: mutate },
    "./mcp-credential-cleanup-core.js": { pendingMcpCredentialCleanupForSave: () => null },
    "./mcp-config-lease.js": { withMcpConfigurationPublication: (_id: string, publish: () => unknown) => publish() },
    "./mcp-field-secrets-core.js": {
      hasPlaintextMcpFields: () => false,
      mcpFieldSecretCleanupBaseline: () => undefined,
      mcpStdioLaunchFingerprint: (server: McpServer) => server.id,
    },
    "./mcp-field-secrets.js": {
      mcpStdioApprovals: { isApproved: async () => false },
      planMcpServerFieldSecrets: (server: McpServer) => ({ server }),
      pruneStoredMcpFieldSecrets: async () => undefined,
      stageStoredMcpFieldSecrets: async (_id: string, plan: { server: McpServer }) => plan.server,
      storedMcpFieldSecretValues: async () => ({}),
      resolveStoredMcpFieldSecrets: async (server: McpServer) => server,
    },
    "./mcp-stdio-approvals.js": {
      publishWithLaunchApproval: (_approvals: unknown, _server: unknown, _approved: unknown, publish: () => unknown) => publish(),
    },
  });
}

const connector = (fields: Partial<McpServer> = {}) =>
  ({ id: "my-own-server", name: "Mine", transport: "http", url: "https://mcp.example.test", enabled: true, ...fields }) as McpServer;

test("adding a connector counts once; editing it, a failed save or a declined launch counts nothing", async (t) => {
  const sent = captureAnalyticsEvents(t);
  const { saveConfiguredMcpServer } = await connectorSave();
  await saveConfiguredMcpServer(connector(), () => true);
  assert.deepEqual(sent, [{ event: "connector_added", props: { preset_id: "custom", transport: "http" } }]);

  await saveConfiguredMcpServer(connector({ name: "Renamed" }), () => true);
  assert.equal(sent.length, 1);

  const failing = await connectorSave({ saveFails: true });
  await assert.rejects(failing.saveConfiguredMcpServer(connector(), () => true), /disk full/u);
  const declined = await connectorSave({ launchApproved: false });
  await assert.rejects(
    declined.saveConfiguredMcpServer(connector({ transport: "stdio" }), () => true, { approveLaunch: true }),
    /Launch review cancelled/u,
  );
  assert.equal(sent.length, 1);
});

test("the desktop binding connects shared services to the analytics service", async (t) => {
  // Electron adds this to `process`; plain Node has no such method.
  const electronProcess = process as { getSystemVersion?: () => string };
  electronProcess.getSystemVersion = () => "26.0";
  t.after(() => {
    delete electronProcess.getSystemVersion;
    analyticsReport.setAnalyticsReporter(undefined);
  });
  const tracked: string[] = [];
  const { analyticsService } = await load<typeof import("./analytics-main.js")>("./analytics-main.ts", {
    "../../platform.js": {
      app: { getVersion: () => "1.0.0", getAppPath: () => "/app", getPath: () => "/data", isPackaged: true },
      logger: { warn: () => undefined, info: () => undefined },
    },
    "../config-store.js": { configStore: {} },
    "../provider-registry.js": { providerRegistry: {} },
    "./analytics-build-config.js": { ANALYTICS_BUILD_CONFIG: {} },
    "./analytics-client.js": {},
    "./analytics-report.js": analyticsReport,
    "./analytics-service.js": {
      createAnalyticsService: () => ({ track: (event: string) => tracked.push(event) }),
    },
  });
  analyticsReport.reportAnalyticsEvent("terminal_opened", {});
  assert.deepEqual(tracked, [], "nothing is connected until the service exists");
  analyticsService();
  analyticsReport.reportAnalyticsEvent("terminal_opened", {});
  assert.deepEqual(tracked, ["terminal_opened"]);
});
