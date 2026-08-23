import { initializeBotApplicationService } from "./bot-application-service-main.js";
import {
  botCapabilityCatalog,
  botCapabilityStore,
  botManagedWorkspace,
} from "./bot-capability-services-main.js";
import { botStore } from "./bot-store.js";
import { chatStore } from "./chat-store.js";
import { createBotRuntimeAuthorityResolver } from "./bot-runtime-authority.js";
import {
  assertBotRuntimeProviderSelection,
  type BotRuntimeEffectiveAuthority,
} from "./bot-runtime-authority.js";
import { botCapabilityFactsFingerprint } from "./bot-capability-catalog-core.js";
import * as fs from "node:fs/promises";
import { botRuntimeInventoryLeases } from "./bot-runtime-inventory-lease.js";

const resolver = createBotRuntimeAuthorityResolver({
  botStore,
  chatStore,
  capabilityStore: botCapabilityStore,
  catalog: botCapabilityCatalog,
  managedWorkspace: botManagedWorkspace,
  inventoryLeases: botRuntimeInventoryLeases,
});

export const BOT_DESKTOP_AUDIENCE_ID = "desktop:local";

/** The sole production admission path for Bot turns and effects. */
export const botRuntimeAuthority = {
  async admit(input: { audienceId: string; botId: string; chatId: string }) {
    await initializeBotApplicationService();
    return resolver.admit(input);
  },
};

export interface BotTurnAuthorityPreflightInput {
  audienceId: string;
  botId: string;
  chatId: string;
  providerId: string;
  model: string;
}

/**
 * Main-owned, mutation-free admission used by non-desktop delivery surfaces
 * before they reserve a turn, consume attachments, or append a user message.
 * The generation path admits again and retains its own lease for effects.
 */
export async function preflightBotTurnAuthority(
  input: Readonly<BotTurnAuthorityPreflightInput>,
): Promise<void> {
  const admission = await botRuntimeAuthority.admit({
    audienceId: input.audienceId,
    botId: input.botId,
    chatId: input.chatId,
  });
  try {
    assertBotRuntimeProviderSelection(admission.authority.provider, {
      providerId: input.providerId,
      model: input.model,
    });
    await admission.revalidateBeforeEffect();
  } finally {
    admission.release();
  }
}

/** Fresh exact resource snapshot used only for main-owned runtime joins. */
export async function resolveBotRuntimeCatalogSnapshot(
  authority: Pick<BotRuntimeEffectiveAuthority, "botId" | "catalogRevision" | "provider">,
  signal?: AbortSignal,
) {
  await initializeBotApplicationService();
  const binding = await botCapabilityStore.getBotBinding(authority.botId);
  const snapshot = await botCapabilityCatalog.snapshotForRuntime({
    botId: authority.botId,
    ...(binding ? { retainedBindings: [binding] } : {}),
    retainedProviders: [{
      sourceProviderId: authority.provider.sourceProviderId,
      sourceModelId: authority.provider.sourceModelId,
    }],
    signal,
  });
  if (snapshot.catalog.revision !== authority.catalogRevision) {
    throw new Error("This Bot's available capabilities changed. Start again after reviewing access.");
  }
  return snapshot;
}

export interface BotRuntimeApprovedRoot {
  id: string;
  label: string;
  root: string;
  /** Authority-proven identity carried through the later synchronous tool pin. */
  device: string;
  inode: string;
}

/** Resolve selected opaque root grants back to canonical, live Mac directories. */
export async function resolveBotRuntimeApprovedRoots(
  authority: Pick<BotRuntimeEffectiveAuthority, "files">,
): Promise<readonly BotRuntimeApprovedRoot[]> {
  if (authority.files.approvedLocations.length === 0) return [];
  const { getAidenRemoteRuntime } = await import("./aiden-remote-service-main.js");
  const roots = (await (await getAidenRemoteRuntime()).state.snapshot()).approvedRoots;
  const resolved: BotRuntimeApprovedRoot[] = [];
  for (const grant of authority.files.approvedLocations) {
    const candidate = roots.find(({ id }) => id === grant.sourceId);
    if (!candidate) throw new Error("A selected Bot file location is no longer available.");
    const [canonical, metadata] = await Promise.all([
      fs.realpath(candidate.folderPath),
      fs.stat(candidate.folderPath, { bigint: true }),
    ]);
    if (
      canonical !== candidate.folderPath ||
      !metadata.isDirectory() ||
      metadata.dev.toString() !== candidate.device ||
      metadata.ino.toString() !== candidate.inode ||
      botCapabilityFactsFingerprint({
        device: candidate.device,
        inode: candidate.inode,
        policyRevision: candidate.policyRevision,
      }) !== grant.scopeFingerprint
    ) {
      throw new Error("A selected Bot file location changed and must be reviewed.");
    }
    resolved.push({
      id: grant.sourceId,
      label: candidate.label,
      root: canonical,
      device: candidate.device,
      inode: candidate.inode,
    });
  }
  return resolved;
}
