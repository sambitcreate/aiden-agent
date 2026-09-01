import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type { ChatStartParams, ScheduledMcpServerBinding, ScheduledTaskPermission } from "./types.js";

export interface ScheduledGenerationSurfaceInput {
  chatId: string;
  streamId: string;
  ownerId: string;
  workspaceId?: string;
  providerId: string;
  model: string;
  mode: ChatStartParams["mode"];
  prompt: string;
  permission: ScheduledTaskPermission;
  excludeToolNames: ReadonlySet<string>;
  allowMcpTools: boolean;
  mcpServerIds?: readonly string[];
  mcpServerBindings?: readonly ScheduledMcpServerBinding[];
  providerFingerprint?: string;
}

export function scheduledGenerationSurface(input: ScheduledGenerationSurfaceInput) {
  return {
    chatId: input.chatId,
    turnId: input.streamId,
    ownerId: input.ownerId,
    streamId: input.streamId,
    params: {
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      model: input.model,
      mode: input.mode,
      messages: [{ role: "user" as const, content: input.prompt }],
    } satisfies ChatStartParams,
    options: {
      permission: input.permission,
      excludeToolNames: input.excludeToolNames,
      allowComputerUse: false as const,
      allowMcpTools: input.allowMcpTools,
      mcpServerIds: input.mcpServerIds,
      mcpServerBindings: input.mcpServerBindings,
      providerFingerprint: input.providerFingerprint,
      allowSubagents: false as const,
      usageSource: "scheduled" as const,
      turnId: input.streamId,
    },
  };
}

export interface RemoteGenerationSurfaceInput {
  chatId: string;
  turnId: string;
  streamId: string;
  ownerId: string;
  workspaceId: string;
  providerId: string;
  model: string;
  thinkingLevel?: ChatStartParams["thinkingLevel"];
  botAudienceId?: string;
  onTurnAccepted(): void;
}

export function remoteGenerationSurface(input: RemoteGenerationSurfaceInput) {
  return {
    chatId: input.chatId,
    turnId: input.turnId,
    ownerId: input.ownerId,
    streamId: input.streamId,
    params: {
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      model: input.model,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      messages: [],
    } satisfies ChatStartParams,
    options: {
      allowSubagents: true as const,
      allowComputerUse: false as const,
      usageSource: "chat" as const,
      turnId: input.turnId,
      ...(input.botAudienceId ? { botAudienceId: input.botAudienceId } : {}),
      onTurnAccepted: input.onTurnAccepted,
    },
  };
}

export function beginSurfaceGeneration<TLease>(
  beginChatTurn: (chatId: string, turnId: string, ownerId: string) => TLease | null,
  entry: { chatId: string; turnId: string; ownerId: string },
): TLease | null {
  return beginChatTurn(entry.chatId, entry.turnId, entry.ownerId);
}

export function startSurfaceGeneration<TOptions>(
  start: (
    streamId: string,
    params: ChatStartParams,
    owner: ChatGenerationOwner,
    options: TOptions,
  ) => Promise<boolean>,
  entry: { streamId: string; params: ChatStartParams; options: TOptions },
  owner: ChatGenerationOwner,
): Promise<boolean> {
  return start(entry.streamId, entry.params, owner, entry.options);
}
