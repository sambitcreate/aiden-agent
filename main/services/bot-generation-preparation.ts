import path from "node:path";
import type { BotDefinition } from "../../renderer/shared/bots.js";
import type { BotManagedWorkspaceResolution } from "./bot-managed-workspace-core.js";
import type { Chat, Workspace } from "./types.js";

type BotGenerationChat = Pick<
  Chat,
  "botId" | "workspaceId" | "providerId" | "model"
>;

export interface RequestedBotGenerationTarget {
  workspaceId?: string;
  providerId: string;
  model: string;
}

export interface ExactBotRuntime {
  provider: { id: string };
  model: { id: string };
}

export interface PrepareBotGenerationInput<Runtime extends ExactBotRuntime> {
  chat: BotGenerationChat;
  bot: BotDefinition;
  requested: RequestedBotGenerationTarget;
  resolveManagedWorkspace(botId: string): Promise<BotManagedWorkspaceResolution>;
  resolveRuntime(
    providerId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<Runtime>;
  signal?: AbortSignal;
}

export interface PreparedBotGeneration<Runtime extends ExactBotRuntime> {
  bot: BotDefinition;
  managedWorkspace: BotManagedWorkspaceResolution;
  /**
   * Main-only adapter for the existing generation runtime. It must not be
   * saved to configStore or projected through IPC/HTTP.
   */
  workspace: Workspace;
  providerId: string;
  model: string;
  runtime: Runtime;
}

export function assertExactBotProviderDispatch(
  expected: { provider: string; model: string },
  requested: { provider: string; model: string },
): void {
  if (
    requested.provider !== expected.provider ||
    requested.model !== expected.model
  ) {
    throw new Error("This Bot chat's AI connection or model changed before provider dispatch.");
  }
}

function requirePersistedSelection(chat: BotGenerationChat): {
  providerId: string;
  model: string;
} {
  if (!chat.providerId || !chat.model) {
    throw new Error(
      "This Bot chat needs an exact AI connection and model before it can reply.",
    );
  }
  return { providerId: chat.providerId, model: chat.model };
}

function assertManagedHome(
  chat: BotGenerationChat,
  bot: BotDefinition,
  requested: RequestedBotGenerationTarget,
  managed: BotManagedWorkspaceResolution,
): void {
  if (
    chat.botId !== bot.id ||
    managed.botId !== bot.id ||
    !chat.workspaceId ||
    (requested.workspaceId !== undefined &&
      requested.workspaceId !== chat.workspaceId)
  ) {
    throw new Error("This Bot chat is not bound to its persisted workspace identity.");
  }
  if (
    !path.isAbsolute(managed.homePath) ||
    path.normalize(managed.homePath) !== managed.homePath ||
    managed.homePath === path.parse(managed.homePath).root
  ) {
    throw new Error("This Bot's managed home workspace is unavailable.");
  }
}

/**
 * Resolve the exact main-owned cwd and persisted provider/model for a Bot turn.
 *
 * This helper performs no filesystem or config mutation. In particular it
 * never creates a workspace record or initializes Git. The caller supplies
 * the already-provisioned managed-home resolver and exact runtime resolver.
 */
export async function prepareBotGeneration<Runtime extends ExactBotRuntime>(
  input: PrepareBotGenerationInput<Runtime>,
): Promise<PreparedBotGeneration<Runtime>> {
  if (input.bot.archivedAt !== undefined) {
    throw new Error("This bot is archived or no longer available.");
  }
  if (input.signal?.aborted) throw input.signal.reason;
  const selection = requirePersistedSelection(input.chat);
  if (
    input.requested.providerId !== selection.providerId ||
    input.requested.model !== selection.model
  ) {
    throw new Error(
      "This Bot chat's saved AI connection changed. Reload it before sending.",
    );
  }

  const managedWorkspace = await input.resolveManagedWorkspace(input.bot.id);
  assertManagedHome(input.chat, input.bot, input.requested, managedWorkspace);
  if (input.signal?.aborted) throw input.signal.reason;

  const runtime = await input.resolveRuntime(
    selection.providerId,
    selection.model,
    input.signal,
  );
  if (
    runtime.provider.id !== selection.providerId ||
    runtime.model.id !== selection.model
  ) {
    throw new Error(
      "This Bot chat's saved AI connection no longer resolves exactly. Choose it again.",
    );
  }

  return {
    bot: input.bot,
    managedWorkspace,
    workspace: {
      id: managedWorkspace.workspaceId,
      name: input.bot.name,
      folderPath: managedWorkspace.homePath,
      // This is only the existing runtime baseline. Bot capability policy is
      // still authoritative and may narrow or remove filesystem/shell access.
      permission: "full",
      createdAt: managedWorkspace.createdAt,
      updatedAt: managedWorkspace.createdAt,
    },
    ...selection,
    runtime,
  };
}
