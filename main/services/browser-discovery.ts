import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { BROWSER_AGENT_GUIDANCE } from "./browser-tools.js";

export const BROWSER_DISCOVERY_TOOL_NAME = "browser";

/** Disclosure is generation-local. The host installs schemas at the next turn boundary. */
export function createBrowserDiscovery(tools: AgentTool[], revalidate: () => Promise<void>) {
  let requested = false;
  const tool: AgentTool = declarePiRuntimeReplay({
    name: BROWSER_DISCOVERY_TOOL_NAME,
    label: "Discover browser tools",
    description: "Load tools for Aiden's shared Environment browser: tabs, navigation, local previews, page inspection, interaction and recording. Call this before browser work; tools become available next turn.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (id, args, signal) => {
      validateToolArguments(tool, { type: "toolCall", id, name: tool.name, arguments: args as Record<string, unknown> });
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
      if (!requested || !context.tools?.some(({ name }) => name === tool.name)) return context;
      // Schemas convey capability shape, not authority. Concrete calls revalidate;
      // a later settings change must not abort unrelated text recovery as a host fault.
      const names = new Set(context.tools.map(({ name }) => name));
      const additions = tools.filter(({ name }) => !names.has(name));
      if (!additions.length) return context;
      return { ...context, systemPrompt: `${context.systemPrompt}\n\n${BROWSER_AGENT_GUIDANCE}`, tools: [...context.tools, ...additions] };
    },
  };
}
