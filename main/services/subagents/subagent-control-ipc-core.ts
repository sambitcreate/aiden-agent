import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { persistedChatWorkspaceId } from "../chat-workspace-authority.js";
import {
  parseSubagentManagementRequestV2,
  type SubagentManagementRequestV2,
} from "./management-v2.js";
import type { SubagentManagementResultV2 } from "./subagent-control-v2.js";
import type { SubagentControlDocumentScopeV2 } from "./subagent-control-main.js";

interface ControlChat {
  id: string;
  workspaceId?: string;
}

export interface SubagentControlIpcDependenciesV2 {
  getChat(chatId: string): Promise<ControlChat | null>;
  execute(
    scope: SubagentControlDocumentScopeV2,
    request: SubagentManagementRequestV2,
  ): Promise<SubagentManagementResultV2>;
}

function requireActiveOwner(owner: RendererDocumentOwner): void {
  if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
}

/** Resolve chat/workspace/document ownership before the private control lookup. */
export async function manageSubagentForDocumentV2(
  owner: RendererDocumentOwner,
  chatIdValue: unknown,
  requestValue: unknown,
  dependencies: SubagentControlIpcDependenciesV2,
): Promise<SubagentManagementResultV2> {
  if (!isSafeSubagentIdentifier(chatIdValue)) {
    throw new Error("Invalid subagent control chat.");
  }
  const request = parseSubagentManagementRequestV2(requestValue);
  const removeInvalidation = owner.onInvalidated(() => undefined);
  try {
    const chat = await dependencies.getChat(chatIdValue);
    requireActiveOwner(owner);
    if (!chat || chat.id !== chatIdValue) throw new Error("Subagent control chat is unavailable.");
    const result = await dependencies.execute(
      {
        chatId: chat.id,
        workspaceId: persistedChatWorkspaceId(chat.workspaceId),
        ownerDocumentId: owner.documentId,
      },
      request,
    );
    requireActiveOwner(owner);
    return result;
  } finally {
    removeInvalidation();
  }
}
