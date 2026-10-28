// Load-on-demand tool declarations.
//
// A chat starts with its everyday tools (files, commands, web, questions,
// to-dos, memory, codemode) plus `load_tools`, whose description lists the
// rest in one line each. The model loads what it needs by name; loaded tools
// are declared from its next step. Once a chat has loaded or called an
// on-demand tool, later runs declare it from the start, so a tool in use
// stays put and its declaration stays cached.
//
// Every tool stays built, approved and executed exactly as before. Only the
// moment its declaration is sent changes.

import type { AgentContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";

export const LOAD_TOOLS_TOOL_NAME = "load_tools";

/**
 * Built-in tools a chat declares only once the model loads them. Everything
 * not named here (files, commands, web search, questions, to-dos, memory,
 * skills, codemode, tool search, the browser gateway, Bot cards) is declared
 * from the start.
 */
export const ON_DEMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "subagent",
  "advisor",
  "schedule_task",
  "list_projects",
  "list_mcp_servers",
  "share_image",
  "workspace_artifact",
  "render_artifact",
  "render_ui",
  "visualize_guide",
  "display_image",
  "generate_image",
  "classify",
  "list_operation_models",
  "list_image_references",
  "background_job",
  "follow_pull_request",
  "aiden_help",
  "aiden_get_state",
  "aiden_show_controls",
  "aiden_set_preference",
  "aiden_open",
  "vcc_recall",
  "computer_use",
  "form_fill",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
  "inspect_image",
  "routines",
]);

const MAX_SUMMARY_CHARACTERS = 90;
const MAX_NAMES_PER_CALL = 20;

/** The first sentence of a tool description, cut to one short catalog line. */
export function onDemandToolSummary(description: string): string {
  const flat = description.replace(/\s+/gu, " ").trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/u.exec(flat)?.[1] ?? flat;
  return sentence.length <= MAX_SUMMARY_CHARACTERS
    ? sentence
    : `${sentence.slice(0, MAX_SUMMARY_CHARACTERS - 1).trimEnd()}…`;
}

/** On-demand tool names this transcript loaded or called, in first-use order. */
export function onDemandToolsUsed(messages: readonly AgentMessage[], available: ReadonlySet<string>): string[] {
  const used = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      if (block.name === LOAD_TOOLS_TOOL_NAME) {
        const names = (block.arguments as { names?: unknown } | undefined)?.names;
        if (!Array.isArray(names)) continue;
        for (const name of names) if (typeof name === "string" && available.has(name)) used.add(name);
      } else if (available.has(block.name)) {
        // A direct call to an undeclared tool fails as "not found"; declaring
        // it on the next step lets the model's retry work.
        used.add(block.name);
      }
    }
  }
  return [...used];
}

export interface OnDemandTools {
  /** The `load_tools` tool the model loads the rest with. */
  readonly loader: AgentTool;
  /** Every tool held back from the start of a run. */
  readonly onDemand: readonly AgentTool[];
  /** Tools to declare at the start of a run over `messages` (the chat so far). */
  initialTools(messages: readonly AgentMessage[]): AgentTool[];
  /** Declares the on-demand tools the transcript has loaded or called since. */
  prepare(context: AgentContext): Promise<AgentContext>;
}

/**
 * Hold back the on-demand tools in `tools`, or undefined when there are none.
 * `tools` is the final, admitted inventory: nothing here grants a tool.
 */
export function createOnDemandTools(
  tools: readonly AgentTool[],
  names: ReadonlySet<string> = ON_DEMAND_TOOL_NAMES,
): OnDemandTools | undefined {
  const onDemand = tools.filter((tool) => names.has(tool.name));
  if (onDemand.length === 0 || tools.some((tool) => tool.name === LOAD_TOOLS_TOOL_NAME)) return undefined;
  const everyday = tools.filter((tool) => !names.has(tool.name));
  const byName = new Map(onDemand.map((tool) => [tool.name, tool]));
  const available = new Set(byName.keys());
  const catalog = onDemand.map((tool) => `- ${tool.name}: ${onDemandToolSummary(tool.description)}`).join("\n");

  const loader: AgentTool = declarePiRuntimeReplay(
    {
      name: LOAD_TOOLS_TOOL_NAME,
      label: "Load tools",
      description: [
        "Load more tools by name. They can be called from your next step and stay loaded for this chat.",
        "Load a tool before its first use, including tools your instructions mention.",
        catalog,
      ].join("\n"),
      parameters: Type.Object({
        names: Type.Array(Type.String({ maxLength: 64 }), { minItems: 1, maxItems: MAX_NAMES_PER_CALL }),
      }),
      execute: async (_id, args) => {
        const requested = (args as { names?: unknown }).names;
        const list = Array.isArray(requested) ? requested.filter((name): name is string => typeof name === "string") : [];
        const unknown = list.filter((name) => !available.has(name));
        if (list.length === 0 || unknown.length > 0) {
          throw new Error(
            `${unknown.length > 0 ? `Not loadable here: ${unknown.slice(0, 10).join(", ")}. ` : ""}Load one of: ${[...available].join(", ")}.`,
          );
        }
        const loaded = [...new Set(list)];
        return {
          content: [{ type: "text", text: `Loaded ${loaded.join(", ")}. Call ${loaded.length === 1 ? "it" : "them"} from your next step.` }],
          details: null,
        };
      },
    },
    "safe",
  );

  return {
    loader,
    onDemand,
    initialTools(messages) {
      const used = new Set(onDemandToolsUsed(messages, available));
      return [...everyday, loader, ...onDemand.filter((tool) => used.has(tool.name))];
    },
    async prepare(context) {
      const present = new Set(context.tools?.map((tool) => tool.name) ?? []);
      // A host exclusion that removed the loader must never re-grant hidden tools.
      if (!present.has(LOAD_TOOLS_TOOL_NAME)) return context;
      const additions = onDemandToolsUsed(context.messages, available)
        .filter((name) => !present.has(name))
        .map((name) => byName.get(name)!);
      if (additions.length === 0) return context;
      return { ...context, tools: [...(context.tools ?? []), ...additions] };
    },
  };
}

/**
 * For a request over `messages`: whether an on-demand tool's declaration is
 * still held back, that is, the transcript has neither loaded nor called it.
 */
export function withheldUntilLoaded(
  messages: readonly AgentMessage[],
  onDemand: ReadonlySet<string>,
): (name: string) => boolean {
  const used = new Set(onDemandToolsUsed(messages, onDemand));
  return (name) => onDemand.has(name) && !used.has(name);
}
