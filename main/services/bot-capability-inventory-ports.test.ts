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
