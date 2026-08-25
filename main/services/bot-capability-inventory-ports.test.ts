import assert from "node:assert/strict";
import test from "node:test";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../renderer/shared/bot-capabilities.js";
import { createBotCapabilityInventoryPorts } from "./bot-capability-inventory-ports.js";

const HASH = "a".repeat(64);

test("inventory ports project safe exact facts and conservative unavailable connections", async () => {
  const ports = createBotCapabilityInventoryPorts({
    loadOpaqueSelectionKey: async () => new Uint8Array(32),
    loadNoticeStatus: async () => ({
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: true,
    }),
    listProviders: async () => [
      {
        id: "provider",
        kind: "openai",
        label: "Provider",
        baseUrl: "https://example.invalid/v1",
        models: ["chat", "embed"],
        modelMetadata: { embed: { source: "provider", type: "embedding" } },
        needsKey: true,
        hasKey: true,
      },
    ],
    providerCredentialSignature: async () => HASH,
    listMcpServers: async () => [
      { id: "live", name: "Live", transport: "http", url: "https://mcp.invalid", enabled: true },
      { id: "down", name: "Down", transport: "stdio", command: "secret-command", enabled: true },
    ],
    inspectMcpScopes: async () => [
      {
        serverId: "live",
        connectionFingerprint: HASH,
        tools: [{ toolName: "read", schemaHash: HASH, effect: "read" }],
      },
    ],
    listSkills: async () => [
      { sourceId: "skill:resolved", label: "Skill", description: "Does work", instructions: "Private", available: true },
    ],
    listApprovedLocations: async () => [{
      sourceId: "root_approved",
      label: "Documents",
      available: true,
      scopeFingerprint: HASH,
    }],
    incarnations: {
      reconcileNamespace: async (_namespace, resources) => resources.map(({ sourceId }) => ({
        sourceId,
        resourceIncarnation: "a".repeat(43),
        credentialIncarnation: "b".repeat(43),
      })),
    },
    getSettings: async () => ({ exaEnabled: true, computerUseEnabled: false }),
    hasWebCredential: async () => true,
    subagentsAvailable: () => true,
    shellFingerprint: HASH,
    fullMacScopeFingerprint: HASH,
    botHomeScopeFingerprint: HASH,
  });
  const signal = new AbortController().signal;
  const [providers, files, shell, connections, skills, other] = await Promise.all([
    ports.listProviders(signal),
    ports.inspectMacFiles(signal),
    ports.inspectShell(signal),
    ports.inspectConnections(signal),
    ports.inspectSkills(signal),
    ports.inspectOtherCapabilities(signal),
  ]);
  assert.equal(providers[0]?.models.length, 1);
  assert.equal(files.fullMac.scopeFingerprint, HASH);
  assert.equal(files.approvedLocations[0]?.label, "Documents");
  assert.equal(shell.shellFingerprint, HASH);
  assert.equal(connections[0]?.available, true);
  assert.equal(connections[1]?.available, false);
  assert.equal(connections[1]?.tools.length, 0);
  assert.equal(skills[0]?.available, true);
  assert.equal(other.find(({ kind }) => kind === "web")?.available, true);
  assert.equal(other.find(({ kind }) => kind === "browser")?.available, false);
  assert.equal(other.find(({ kind }) => kind === "schedules")?.available, false);
  assert.match(
    other.find(({ kind }) => kind === "schedules")?.description ?? "",
    /re-check this Bot's access/u,
  );
  const serialized = JSON.stringify({ providers, files, shell, connections, skills, other });
  assert.doesNotMatch(serialized, /secret-command|Private|https:\/\//u);
});

test("inventory ports use configured chat providers within Bot wire limits", async () => {
  const signed: string[] = [];
  let hiddenModelsByProvider: Record<string, string[]> | undefined;
  const modelIds = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  const ports = createBotCapabilityInventoryPorts({
    loadOpaqueSelectionKey: async () => new Uint8Array(32),
    loadNoticeStatus: async () => ({
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: true,
    }),
    listProviders: async () => [
      {
        id: "not-connected",
        kind: "openai",
        label: "Not connected",
        baseUrl: "https://unavailable.invalid/v1",
        models: ["hidden"],
        needsKey: true,
        hasKey: false,
      },
      {
        id: "ambient-only",
        kind: "openai",
        label: "Ambient only",
        baseUrl: "https://ambient.invalid/v1",
        models: ["ambient-chat"],
        needsKey: true,
        hasKey: true,
        isBuiltin: true,
      },
      {
        id: "local",
        kind: "openai",
        label: "Local",
        baseUrl: "http://127.0.0.1:1234/v1",
        models: [
          "explicit-embedding",
          "explicit-reranker",
          "explicit-image",
          "explicit-audio",
          "explicit-video",
          "text-embedding-3-small",
          "bge-m3",
          "rerank-v3",
          "chat",
          "chat",
        ],
        modelMetadata: {
          "explicit-embedding": { source: "provider", type: "embedding" },
          "explicit-reranker": { source: "provider", type: "reranker" },
          "explicit-image": { source: "provider", type: "image" },
          "explicit-audio": { source: "provider", type: "audio" },
          "explicit-video": { source: "provider", type: "video" },
        },
        needsKey: false,
        hasKey: false,
      },
      {
        id: "large-a",
        kind: "openai",
        label: "Large A",
        baseUrl: "https://a.invalid/v1",
        models: modelIds("a", 300),
        needsKey: true,
        hasKey: true,
      },
      {
        id: "large-b",
        kind: "openai",
        label: "Large B",
        baseUrl: "https://b.invalid/v1",
        models: modelIds("b", 300),
        needsKey: true,
        hasKey: true,
      },
    ],
    providerCredentialSignature: async (provider) => {
      signed.push(provider.id);
      if (provider.id === "ambient-only") return undefined;
      return HASH;
    },
    listMcpServers: async () => [],
    inspectMcpScopes: async () => [],
    listSkills: async () => [],
    listApprovedLocations: async () => [],
    incarnations: {
      reconcileNamespace: async (_namespace, resources) => resources.map(({ sourceId }) => ({
        sourceId,
        resourceIncarnation: "a".repeat(43),
        credentialIncarnation: "b".repeat(43),
      })),
    },
    getSettings: async () => ({ hiddenModelsByProvider }),
    hasWebCredential: async () => false,
    subagentsAvailable: () => false,
  });

  const providers = await ports.listProviders(new AbortController().signal);
  assert.deepEqual(signed, ["ambient-only", "local", "large-a", "large-b"]);
  assert.deepEqual(providers.map(({ sourceId }) => sourceId), ["local", "large-a", "large-b"]);
  assert.deepEqual(providers.map(({ models }) => models.length), [1, 256, 255]);
  assert.equal(providers.reduce((total, provider) => total + provider.models.length, 0), 512);
  assert.deepEqual(providers[0]?.models.map(({ sourceId }) => sourceId), ["chat"]);

  signed.length = 0;
  hiddenModelsByProvider = { "large-b": ["b-299"] };
  const retained = await ports.listProviders(new AbortController().signal, [{
    sourceProviderId: "large-b",
    sourceModelId: "b-299",
  }]);
  assert.deepEqual(signed, ["ambient-only", "local", "large-a", "large-b"]);
  assert.deepEqual(retained.map(({ sourceId }) => sourceId), ["large-b", "local", "large-a"]);
  assert.equal(retained[0]?.models[0]?.sourceId, "b-299");
  assert.equal(retained[0]?.models.length, 256);
  assert.equal(retained.reduce((total, provider) => total + provider.models.length, 0), 512);

  const removed = await ports.listProviders(new AbortController().signal, [{
    sourceProviderId: "large-b",
    sourceModelId: "removed-model",
  }]);
  assert.equal(
    removed.some(({ models }) => models.some(({ sourceId }) => sourceId === "removed-model")),
    false,
  );
  assert.equal(removed[0]?.sourceId, "local");

  hiddenModelsByProvider = { local: ["chat"] };
  const withoutHidden = await ports.listProviders(new AbortController().signal);
  assert.equal(withoutHidden.some(({ sourceId }) => sourceId === "local"), false);
});

test("inventory ports honor aborts", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  const ports = createBotCapabilityInventoryPorts({
    loadOpaqueSelectionKey: async () => new Uint8Array(32),
    loadNoticeStatus: async () => ({
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: true,
    }),
    listProviders: async () => [],
    providerCredentialSignature: async () => HASH,
    listMcpServers: async () => [],
    inspectMcpScopes: async () => [],
    listSkills: async () => [],
    listApprovedLocations: async () => [],
    incarnations: {
      reconcileNamespace: async () => [],
    },
    getSettings: async () => ({}),
    hasWebCredential: async () => false,
    subagentsAvailable: () => false,
  });
  await assert.rejects(ports.listProviders(controller.signal), /stopped/u);
});
