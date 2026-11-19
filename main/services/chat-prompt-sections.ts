// The per-chat system sections a desktop generation adds to its prompt, built
// the one way llm-client and the prompt prefix harness both use. Electron-free:
// callers pass the app data folder.

import {
  createAgentsInstructionRefresher,
  type AgentsInstructionOptions,
} from "./agents-instructions.js";
import {
  createMcpServersSectionRefresher,
  renderMcpServersSection,
} from "./mcp-server-instructions.js";
import type { PiDiscoverableTool } from "./pi-tool-discovery.js";
import { chatPromptSecret, promptSectionDeviceKey } from "./prompt-section-secret.js";

export type ChatAgentsInstructionOptions = Omit<AgentsInstructionOptions, "chatSecret"> & {
  /** The app data folder that holds this device's prompt section key. */
  userDataDir: string;
  chatId: string;
};

/**
 * The AGENTS.md refresher for one generation of a chat. Its nonce comes from
 * the chat's secret on this device, so every generation of the chat frames
 * the instructions with the same bytes and the cached prefix holds.
 */
export function createChatAgentsInstructions(options: ChatAgentsInstructionOptions) {
  const { userDataDir, chatId, ...rest } = options;
  return createAgentsInstructionRefresher({
    ...rest,
    chatSecret: chatPromptSecret(promptSectionDeviceKey(userDataDir), chatId),
  });
}

export interface ChatMcpServersSectionOptions {
  /** The servers' tools: the runtime's callable inventory once it exists, else the turn's tools. */
  inventory: () => readonly PiDiscoverableTool[];
  /** Tool names the turn declares directly. */
  declared: ReadonlySet<string>;
  /** Servers still finishing discovery (llm-client's late MCP discovery). */
  latePending?: () => number;
  now?: () => number;
}

/**
 * The `mcp_servers` section for one generation, rendered once, when the turn
 * starts. A section patch between two requests of one generation would
 * rewrite the cached system prefix on every wire that hoists system messages
 * into the head, so a server whose discovery finishes later (past the
 * admission window) stays out of the section for the rest of the generation,
 * steering turns included. It is callable at once through codemode and
 * tool_search, and when servers were still connecting at turn start one fixed
 * line says so. The next generation lists it.
 */
export function createChatMcpServersSection(options: ChatMcpServersSectionOptions) {
  let rendered: string | undefined;
  return createMcpServersSectionRefresher(() => (rendered ??= renderMcpServersSection(options.inventory(), {
    declared: options.declared,
    connecting: (options.latePending?.() ?? 0) > 0,
  })), options.now);
}
