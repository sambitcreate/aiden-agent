// The per-chat system sections a desktop generation adds to its prompt, built
// the one way llm-client and the prompt prefix harness both use. Electron-free:
// callers pass the app data folder.

import {
  createAgentsInstructionRefresher,
  type AgentsInstructionOptions,
} from "./agents-instructions.js";
import {
  createMcpServersSectionRefresher,
  MCP_SERVERS_SECTION_LIMITS,
  renderMcpServersSection,
} from "./mcp-server-instructions.js";
import type { PiSessionEntry, PiSessionPort } from "./pi-session-port.js";
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

/** The journal entry that keeps the `mcp_servers` section a chat's generation showed. */
export const MCP_SERVERS_SECTION_ENTRY = "aiden.mcp-servers-section.v1";

/** The section's guidance can exceed its listing budget; anything past this is not one we wrote. */
const MAX_JOURNALED_SECTION_BYTES = MCP_SERVERS_SECTION_LIMITS.totalBytes + MCP_SERVERS_SECTION_LIMITS.guidanceBytes;

/**
 * The `mcp_servers` section the chat's latest connected generation showed, from
 * its journal, or undefined when none was recorded. Compactions do not reset
 * it: the section is applied to each generation's context, never journaled
 * as a message, so it is never folded into a summary.
 */
export function journaledMcpServersSection(branch: readonly PiSessionEntry[]): string | undefined {
  let section: string | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== MCP_SERVERS_SECTION_ENTRY) continue;
    const text = (entry.data as { text?: unknown } | undefined)?.text;
    if (typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_JOURNALED_SECTION_BYTES) section = text;
  }
  return section;
}

/** What a turn that withholds the chat's connectors tells the model after its prompt. */
export const CONNECTORS_WITHHELD_TURN_NOTE =
  "The connectors listed in mcp_servers are not connected for this follow-up: nobody started it, so their servers are not reached and their tools cannot be called. Say what you would check with them instead.";

export interface ChatMcpServersSectionOptions {
  /** The servers' tools: the runtime's callable inventory once it exists, else the turn's tools. */
  inventory: () => readonly PiDiscoverableTool[];
  /** Tool names the turn declares directly. */
  declared: ReadonlySet<string>;
  /** Servers still finishing discovery (llm-client's late MCP discovery). */
  latePending?: () => number;
  /** The section the chat's latest connected generation showed (`journaledMcpServersSection`). */
  journaled?: string;
  /**
   * This turn connects none of the chat's servers (an unattended follow-up).
   * It shows the journaled section unchanged, so the chat's cached prefix
   * holds, and its note says the servers cannot be reached.
   */
  connectorsWithheld?: boolean;
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
 *
 * A turn that withholds connectors shows the journaled section and records
 * nothing; any other turn records what it showed when that changed
 * (`record`, after the first `apply`).
 */
export function createChatMcpServersSection(options: ChatMcpServersSectionOptions) {
  let rendered: string | undefined;
  const render = () => (rendered ??= options.connectorsWithheld
    ? options.journaled ?? ""
    : renderMcpServersSection(options.inventory(), {
        declared: options.declared,
        connecting: (options.latePending?.() ?? 0) > 0,
      }));
  const refresher = createMcpServersSectionRefresher(render, options.now);
  return {
    apply: refresher.apply,
    /** The note that follows this turn's prompt, or "". */
    turnNote: options.connectorsWithheld && options.journaled ? CONNECTORS_WITHHELD_TURN_NOTE : "",
    async record(journal: Pick<PiSessionPort, "appendCustomEntry">): Promise<void> {
      if (options.connectorsWithheld || rendered === undefined || rendered === (options.journaled ?? "")) return;
      await journal.appendCustomEntry(MCP_SERVERS_SECTION_ENTRY, { text: rendered });
    },
  };
}
