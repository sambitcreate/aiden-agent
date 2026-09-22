import type { BotCustomSelection } from "../../renderer/shared/bot-capabilities.js";
import type { BotCapabilityCatalogMainService } from "./bot-capability-catalog-main.js";
import type { BotCapabilityCatalogSnapshot } from "./bot-capability-catalog-core.js";
import type { BotCapabilityStore } from "./bot-capability-store.js";
import type { BotArchivedReadAuthoritySnapshot } from "./bot-capability-store-core.js";
import type { BotManagedWorkspaceCore } from "./bot-managed-workspace-core.js";
import type { BotMutationGate } from "./bot-mutation-gate.js";
import {
  botRuntimeInventoryLeases,
  type BotRuntimeInventoryLeaseRegistry,
} from "./bot-runtime-inventory-lease.js";
import type { BotStore } from "./bot-store-core.js";
import type { ChatStore } from "./chat-store-core.js";

export interface BotArchivedFileReadContext {
  botId: string;
  chatId: string;
  workspaceId: string;
  workingDirectory: string;
  botPolicy: Readonly<{ revision: string; epoch: string }>;
  chatPolicy: Readonly<{ revision: string; epoch: string }>;
  signal: AbortSignal;
  revalidateBeforeEffect(): Promise<void>;
}

export interface BotArchivedFileReadAuthorityPort {
  run<Result>(
    input: { botId: string; chatId: string },
    action: (context: Readonly<BotArchivedFileReadContext>) => Promise<Result>,
  ): Promise<Result>;
}

type Dependencies = {
  bots: Pick<BotStore, "get">;
  chats: Pick<ChatStore, "get">;
  capabilities: Pick<
    BotCapabilityStore,
    "inspectArchivedReadAuthority" | "assertAuthorityBindingsCurrent"
  >;
  catalog: Pick<BotCapabilityCatalogMainService, "snapshotForRuntime">;
  managedWorkspace: Pick<BotManagedWorkspaceCore, "resolve" | "revalidate">;
  mutationGate: Pick<BotMutationGate, "run">;
  inventoryLeases?: Pick<BotRuntimeInventoryLeaseRegistry, "acquire">;
};

export class BotArchivedFileReadAuthorityError extends Error {
  readonly name = "BotArchivedFileReadAuthorityError";

  constructor(readonly classification: "unavailable" | "capability_denied" | "changed") {
    super("Archived Bot file read authority is unavailable.");
  }
}

function fail(
  classification: BotArchivedFileReadAuthorityError["classification"],
): never {
  throw new BotArchivedFileReadAuthorityError(classification);
}

function retainedBindings(authority: BotArchivedReadAuthoritySnapshot) {
  return authority.policy.accessMode === "custom"
    ? [authority.policy.binding]
    : undefined;
}

function managedHomeAllowed(
  authority: BotArchivedReadAuthoritySnapshot,
  snapshot: BotCapabilityCatalogSnapshot,
): boolean {
  if (!authority.effectiveCustom) {
    return snapshot.resources.fileScopes.some(
      ({ option }) =>
        option.available && (option.kind === "bot_home" || option.kind === "full_mac"),
    );
  }
  const selected = new Set(authority.effectiveCustom.fileScopeIds);
  return snapshot.catalog.fileScopes.some(
    (option) =>
      selected.has(option.id) &&
      option.available &&
      (option.kind === "bot_home" || option.kind === "full_mac"),
  );
}

function sameSelection(
  left: BotCustomSelection | undefined,
  right: BotCustomSelection | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCapabilityAuthority(
  left: BotArchivedReadAuthoritySnapshot,
  right: BotArchivedReadAuthoritySnapshot,
): boolean {
  return (
    left.policy.botId === right.policy.botId &&
    left.policy.authorityStatus === "archived" &&
    right.policy.authorityStatus === "archived" &&
    left.policy.revision === right.policy.revision &&
    left.policy.policyEpoch === right.policy.policyEpoch &&
    left.chat.botId === right.chat.botId &&
    left.chat.chatId === right.chat.chatId &&
    left.chat.revision === right.chat.revision &&
    left.chat.policyEpoch === right.chat.policyEpoch &&
    sameSelection(left.effectiveCustom, right.effectiveCustom)
  );
}

/**
 * Archived Bots cannot receive runtime/tool leases. This resolver instead
 * holds the Bot lifecycle gate for the complete read, fences live inventory,
 * and re-proves exact identity, policy, chat, bindings, and managed-home
 * incarnation immediately before each filesystem observation.
 */
export function createBotArchivedFileReadAuthority(
  deps: Dependencies,
): BotArchivedFileReadAuthorityPort {
  return {
    run: (input, action) => deps.mutationGate.run(input.botId, async () => {
      const inventoryLease = (deps.inventoryLeases ?? botRuntimeInventoryLeases).acquire();
      let executingAction = false;
      try {
        const [bot, chat] = await Promise.all([
          deps.bots.get(input.botId),
          deps.chats.get(input.chatId),
        ]);
        if (!bot || bot.archivedAt === undefined || !chat || chat.botId !== input.botId) {
          fail("unavailable");
        }
        const authority = await deps.capabilities.inspectArchivedReadAuthority(
          input.botId,
          input.chatId,
        );
        const snapshot = await deps.catalog.snapshotForRuntime({
          botId: input.botId,
          ...(retainedBindings(authority)
            ? { retainedBindings: retainedBindings(authority) }
            : {}),
        });
        inventoryLease.assertCurrent();
        await deps.capabilities.assertAuthorityBindingsCurrent({
          botId: input.botId,
          chatId: input.chatId,
          snapshot,
        });
        if (!managedHomeAllowed(authority, snapshot)) fail("capability_denied");
        const workspace = await deps.managedWorkspace.resolve(input.botId);
        await deps.managedWorkspace.revalidate(workspace);
        const revalidateBeforeEffect = async () => {
          try {
            inventoryLease.assertCurrent();
            const [currentBot, currentChat, currentAuthority] = await Promise.all([
              deps.bots.get(input.botId),
              deps.chats.get(input.chatId),
              deps.capabilities.inspectArchivedReadAuthority(input.botId, input.chatId),
            ]);
            if (
              !currentBot ||
              currentBot.archivedAt === undefined ||
              currentBot.revision !== bot.revision ||
              !currentChat ||
              currentChat.botId !== input.botId ||
              currentChat.workspaceId !== chat.workspaceId ||
              currentChat.createdAt !== chat.createdAt ||
              currentChat.updatedAt !== chat.updatedAt ||
              !sameCapabilityAuthority(authority, currentAuthority)
            ) {
              fail("changed");
            }
            const currentSnapshot = await deps.catalog.snapshotForRuntime({
              botId: input.botId,
              ...(retainedBindings(currentAuthority)
                ? { retainedBindings: retainedBindings(currentAuthority) }
                : {}),
            });
            if (currentSnapshot.catalog.revision !== snapshot.catalog.revision) fail("changed");
            await deps.capabilities.assertAuthorityBindingsCurrent({
              botId: input.botId,
              chatId: input.chatId,
              snapshot: currentSnapshot,
            });
            if (!managedHomeAllowed(currentAuthority, currentSnapshot)) {
              fail("capability_denied");
            }
            await deps.managedWorkspace.revalidate(workspace);
            inventoryLease.assertCurrent();
          } catch (error) {
            if (error instanceof BotArchivedFileReadAuthorityError) throw error;
            fail("changed");
          }
        };
        executingAction = true;
        return await action(Object.freeze({
          botId: input.botId,
          chatId: input.chatId,
          workspaceId: workspace.workspaceId,
          workingDirectory: workspace.homePath,
          botPolicy: Object.freeze({
            revision: authority.policy.revision,
            epoch: `epoch:${authority.policy.policyEpoch}`,
          }),
          chatPolicy: Object.freeze({
            revision: authority.chat.revision,
            epoch: `epoch:${authority.chat.policyEpoch}`,
          }),
          signal: inventoryLease.signal,
          revalidateBeforeEffect,
        }));
      } catch (error) {
        if (executingAction) throw error;
        if (error instanceof BotArchivedFileReadAuthorityError) throw error;
        fail("unavailable");
      } finally {
        inventoryLease.release();
      }
    }),
  };
}
