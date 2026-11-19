import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { BROWSER_AGENT_GUIDANCE } from "./browser-tools.js";

export const BROWSER_DISCOVERY_TOOL_NAME = "browser";
const GUIDANCE_SECTION = "browser-discovery";

/**
 * Whether the transcript holds a successful discovery call. The journal keeps
 * tool results, so a later response, and a restart, sees the same answer.
 */
export function browserDiscoveredIn(messages: readonly AgentMessage[]): boolean {
  return messages.some((message) =>
    message.role === "toolResult" && message.toolName === BROWSER_DISCOVERY_TOOL_NAME && message.isError !== true);
}

function hasGuidance(messages: readonly AgentMessage[]): boolean {
  return messages.some((message) =>
    message.role === "system"
    && typeof (message as { sections?: Record<string, unknown> }).sections?.[GUIDANCE_SECTION] === "string");
}

/**
 * The host installs schemas at the next turn boundary, and from the start of
 * every later response whose transcript holds the discovery. The browser tools
 * themselves are offered only while browser access holds, and each call
 * revalidates, so a remembered discovery grants nothing new.
 */
export function createBrowserDiscovery(tools: AgentTool[], revalidate: () => Promise<void>) {
  // Survives a compaction that folds the discovery result away in this response.
  let requested = false;
  const tool: AgentTool = declarePiRuntimeReplay({
    name: BROWSER_DISCOVERY_TOOL_NAME,
    label: "Discover browser tools",
    description: "Load browser tools for the next turn: tabs, navigation, previews, inspection, input, recording.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (id, args, signal) => {
      validateToolArguments(tool, { type: "toolCall", id, name: tool.name, arguments: args as Record<string, never> });
      signal?.throwIfAborted();
      await revalidate();
      signal?.throwIfAborted();
      requested = true;
      return { content: [{ type: "text", text: `Browser tools are available on your next turn: ${tools.map(({ name }) => name).join(", ")}.\n${BROWSER_AGENT_GUIDANCE}` }], details: null };
    },
  }, "safe");
  return {
    tool,
    async prepare(context: AgentContext): Promise<AgentContext> {
      // A removed gateway (e.g. host exclusions) must never grant hidden tools.
      if (!context.tools?.some(({ name }) => name === tool.name)) return context;
      if (!requested && !browserDiscoveredIn(context.messages)) return context;
      // Schemas convey capability shape, not authority. Concrete calls revalidate;
      // a later settings change must not abort unrelated text recovery as a host fault.
      const names = new Set(context.tools.map(({ name }) => name));
      const additions = tools.filter(({ name }) => !names.has(name));
      if (!additions.length) return context;
      // Appended once; a transcript that already carries it is left as is.
      return {
        ...context,
        messages: hasGuidance(context.messages) ? context.messages : [...context.messages, {
          role: "system",
          content: "",
          sections: { [GUIDANCE_SECTION]: BROWSER_AGENT_GUIDANCE },
          timestamp: Date.now(),
        }],
        tools: [...context.tools, ...additions],
      };
    },
  };
}
