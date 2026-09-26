import { realpath, stat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { configStore } from "./config-store.js";
import { chatStore } from "./chat-store.js";
import { toolOutputScope, toolOutputStore, toolOutputCredentialFingerprint } from "./tool-output-store.js";
import { withDurableToolOutputs } from "./tool-output-context.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { app } from "../platform.js";
import { mcpConfigurationLeases } from "./mcp-config-lease.js";
import { botRuntimeInventoryLeases } from "./bot-runtime-inventory-lease.js";

/** Ordinary workspace generations only; Bots/children keep their narrower tool surfaces. */
export async function attachWorkspaceToolOutputs(
  tools: AgentTool[], chatId: string, workspaceId: string, isCurrent: () => boolean,
  expected: { folderPath?: string; permission: string },
): Promise<AgentTool[]> {
  try {
    const credentialRevision = botRuntimeInventoryLeases.revision();
    const leases = (await configStore.listMcpServers()).map((server) => mcpConfigurationLeases.acquire(server.id));
    const leasedIds = new Set(leases.map((lease) => lease.serverId));
    const stillCurrent = () => {
      try {
        leases.forEach((lease) => lease.assertCurrent());
        return isCurrent() && botRuntimeInventoryLeases.revision() === credentialRevision;
      } catch { return false; }
    };
    const scopeNow = async (): Promise<string> => {
      if (!stillCurrent()) throw new Error("Tool output access is no longer active.");
      const [workspace, chat, servers] = await Promise.all([
        configStore.getWorkspace(workspaceId), chatStore.get(chatId), configStore.listMcpServers(),
      ]);
      if (servers.length !== leasedIds.size || servers.some((server) => !leasedIds.has(server.id))) {
        throw new Error("Tool output connection authority changed.");
      }
      if (!workspace || !chat || persistedChatWorkspaceId(chat.workspaceId) !== workspaceId || workspace.permission === "none" ||
        workspace.permission !== expected.permission || workspace.folderPath !== expected.folderPath) {
        throw new Error("Tool output access is unavailable.");
      }
      const root = workspace.folderPath ? await realpath(workspace.folderPath) : undefined;
      const identity = root ? await stat(root) : undefined;
      const credentials = await toolOutputCredentialFingerprint(app.getPath("userData"));
      if (!stillCurrent()) throw new Error("Tool output access changed.");
      return toolOutputScope({ workspaceId, permission: workspace.permission, root,
        device: identity?.dev, inode: identity?.ino,
        credentials,
        // Includes connection credentials only as a one-way authority fingerprint.
        servers: [...servers].sort((a, b) => a.id.localeCompare(b.id)),
      });
    };
    const scope = await scopeNow();
    return withDurableToolOutputs({ tools, chatId, scope, store: toolOutputStore, isCurrent: stillCurrent,
      assertCurrent: async () => {
        if (await scopeNow() !== scope || !stillCurrent()) throw new Error("Tool output access changed.");
      },
    });
  } catch (error) {
    if (!isCurrent()) throw error;
    // Optional retention must not disable otherwise available workspace tools.
    // No sink or recovery tool is exposed when its authority cannot be established.
    return tools;
  }
}
