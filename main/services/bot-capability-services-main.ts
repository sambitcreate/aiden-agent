import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "../platform.js";
import { createBotCapabilityCatalogMainService } from "./bot-capability-catalog-main.js";
import { createBotCapabilityInventoryPorts } from "./bot-capability-inventory-ports.js";
import { createBotCapabilityIncarnationStore } from "./bot-capability-incarnation-store.js";
import {
  botMcpCredentialSignature,
  createBotProviderCredentialSignature,
} from "./bot-capability-credential-signatures.js";
import { createBotCapabilityOpaqueKeyStore } from "./bot-capability-key-store.js";
import {
  botCapabilityKeychainAccountForCanonicalRoot,
  createBotCapabilityKeychainAnchor,
  createBotCapabilityKeychainBootstrapMarker,
} from "./bot-capability-keychain-anchor.js";
import { createBotCapabilityMigrationSeal } from "./bot-capability-migration-seal.js";
import { createBotCapabilityStore } from "./bot-capability-store.js";
import { createBotCapabilityStateCheckpoint } from "./bot-capability-state-checkpoint.js";
import { createBotLifecycleJournal } from "./bot-lifecycle-journal.js";
import { createBotManagedWorkspaceService } from "./bot-managed-workspace.js";
import { configStore } from "./config-store.js";
import { listConfiguredProviders } from "./provider-list-main.js";
import { inspectConfiguredMcpToolsForBotCatalog } from "./mcp.js";
import { resolveBotMcpConnectionIdentities, resolveBotMcpInventory } from "./bot-mcp-inventory.js";
import {
  resolveBotCapabilitySkills,
  resolveBotRuntimeSkillBindings,
} from "./bot-skill-inventory.js";
import { discoverSkillCandidates } from "./skills-discovery.js";
import { subagentsEnabled } from "./subagents/feature-flag.js";
import { botCapabilityFactsFingerprint } from "./bot-capability-catalog-core.js";
import { botStore } from "./bot-store.js";
import { chatStore } from "./chat-store.js";
import {
  botRuntimeInventoryLeases,
  invalidateBotRuntimeInventoryAuthority,
} from "./bot-runtime-inventory-lease.js";
import { BotSkillContentWatcher } from "./bot-skill-content-watcher.js";
import { skillRegistry } from "./skill-registry-main.js";
import { webSearchService } from "./web-search-main.js";
import { hostPlatformCapabilities } from "./host-platform-capabilities.js";

export const BOT_SERVICE_DIRECTORY = "bot-service";

export function botServiceRoot(): string {
  return path.join(app.getPath("userData"), BOT_SERVICE_DIRECTORY);
}

/** Establish the shared private root before any independent store opens it. */
export async function prepareBotServiceStorage(): Promise<void> {
  const root = botServiceRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Bot service storage is not a private directory.");
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && info.uid !== getuid()) {
    throw new Error("Bot service storage is not owned by the current user.");
  }
  await fs.chmod(root, 0o700);
}

const opaqueKeyStore = createBotCapabilityOpaqueKeyStore({
  root: botServiceRoot,
});

export const botSkillContentWatcher = new BotSkillContentWatcher(() => {
  skillRegistry.invalidate();
  invalidateBotRuntimeInventoryAuthority("skill_content");
});

/** Main-only join from exact Bot grants to the existing runtime skill registry. */
export async function resolveBotRuntimeSkills(botId: string) {
  const skills = await resolveBotRuntimeSkillBindings({
    loadIdentityKey: () => opaqueKeyStore.load(),
    listConfigured: () => configStore.listSkills(),
    botId,
    loadBotHomePath: async () => (await botManagedWorkspace.resolve(botId)).homePath,
    discover: (workspaceRoot) => discoverSkillCandidates(workspaceRoot),
  });
  await botSkillContentWatcher.watchSkillFiles(
    skills.flatMap(({ runtimePath }) => (runtimePath ? [runtimePath] : [])),
  );
  return skills;
}

let capabilityKeychainAccountPromise: Promise<string> | undefined;
const capabilityKeychainAccount = (): Promise<string> => {
  capabilityKeychainAccountPromise ??= fs
    .realpath(app.getPath("userData"))
    .then(botCapabilityKeychainAccountForCanonicalRoot)
    .catch((error) => {
      capabilityKeychainAccountPromise = undefined;
      throw error;
    });
  return capabilityKeychainAccountPromise;
};
const capabilityStateCheckpoint = createBotCapabilityStateCheckpoint({
  root: botServiceRoot,
  keyStore: opaqueKeyStore,
  anchor: createBotCapabilityKeychainAnchor({
    account: capabilityKeychainAccount,
  }),
  bootstrapMarker: createBotCapabilityKeychainBootstrapMarker({
    account: capabilityKeychainAccount,
  }),
  inspectInitialBootstrap: async () => {
    const [bots, chats] = await Promise.all([botStore.list(true), chatStore.list()]);
    const botIds = new Set(bots.map(({ id }) => id));
    const botChats = chats.filter(({ botId }) => botId !== undefined);
    if (bots.length === 0 && botChats.length === 0) return "clean";
    return botChats.every(({ botId }) => botId !== undefined && botIds.has(botId))
      ? "legacy"
      : "deny";
  },
});

export const botCapabilityStore = createBotCapabilityStore({
  root: botServiceRoot,
  checkpoint: capabilityStateCheckpoint,
});
const capabilityIncarnations = createBotCapabilityIncarnationStore(botCapabilityStore);

/** Fresh durable identities for the exact Bot-to-child MCP authority join. */
export function resolveBotRuntimeMcpConnectionIdentities(signal: AbortSignal) {
  return resolveBotMcpConnectionIdentities(signal, {
    listServers: () => configStore.listMcpServers(),
    credentialSignature: async (server, currentSignal) => {
      if (currentSignal.aborted) throw currentSignal.reason;
      return botMcpCredentialSignature(server, await opaqueKeyStore.load());
    },
    incarnations: capabilityIncarnations,
  });
}
export const botManagedWorkspace = createBotManagedWorkspaceService({
  root: botServiceRoot,
});
export const botLifecycleJournal = createBotLifecycleJournal({
  root: botServiceRoot,
});
export const botCapabilityMigrationSeal = createBotCapabilityMigrationSeal({
  root: botServiceRoot,
});

const botProviderCredentialSignature = createBotProviderCredentialSignature();

export const botCapabilityCatalog = createBotCapabilityCatalogMainService(
  createBotCapabilityInventoryPorts({
    loadOpaqueSelectionKey: () => opaqueKeyStore.load(),
    loadNoticeStatus: (audienceId) => botCapabilityStore.noticeStatus(audienceId),
    // Bots and ordinary chats must see the same main-owned provider authority.
    // The inventory adapter below removes unconfigured connections and applies
    // the narrower Bot protocol bounds before anything reaches iOS.
    listProviders: listConfiguredProviders,
    providerCredentialSignature: async (provider, signal) => {
      if (signal.aborted) throw signal.reason;
      return botProviderCredentialSignature(provider, await opaqueKeyStore.load(), signal);
    },
    listMcpServers: () => configStore.listMcpServers(),
    inspectMcpScopes: (signal) =>
      resolveBotMcpInventory(signal, {
        listServers: () => configStore.listMcpServers(),
        credentialSignature: async (server, currentSignal) => {
          if (currentSignal.aborted) throw currentSignal.reason;
          return botMcpCredentialSignature(server, await opaqueKeyStore.load());
        },
        inspectTools: inspectConfiguredMcpToolsForBotCatalog,
        incarnations: capabilityIncarnations,
      }),
    listSkills: (target) =>
      resolveBotCapabilitySkills({
        loadIdentityKey: () => opaqueKeyStore.load(),
        listConfigured: () => configStore.listSkills(),
        ...(target
          ? {
              botId: target.botId,
              loadBotHomePath: async () =>
                (await botManagedWorkspace.resolve(target.botId)).homePath,
            }
          : {}),
        discover: (workspaceRoot) => discoverSkillCandidates(workspaceRoot),
      }),
    listApprovedLocations: async () => {
      // Dynamic import avoids coupling Bot storage initialization to Remote startup.
      const { getAidenRemoteRuntime } = await import("./aiden-remote-service-main.js");
      const roots = (await (await getAidenRemoteRuntime()).state.snapshot()).approvedRoots;
      return roots.map((root) => ({
        sourceId: root.id,
        label: root.label,
        description: "A folder approved on this Mac.",
        available: true,
        scopeFingerprint: botCapabilityFactsFingerprint({
          device: root.device,
          inode: root.inode,
          policyRevision: root.policyRevision,
        }),
      }));
    },
    incarnations: capabilityIncarnations,
    getSettings: () => configStore.getSettings(),
    webSearchAvailability: async () => {
      const availability = await webSearchService.availability();
      return { ready: availability.ready };
    },
    subagentsAvailable: () => subagentsEnabled(),
    computerUseSupported: () => hostPlatformCapabilities().computerUse,
  }),
  {
    onRuntimeSnapshot: (botId, snapshot) => {
      botRuntimeInventoryLeases.publishFingerprint(
        botId === undefined ? "global" : `bot:${botId}`,
        snapshot.catalog.revision,
      );
    },
  },
);
