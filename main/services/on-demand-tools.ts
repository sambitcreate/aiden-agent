// Load-on-demand tool declarations.
//
// A chat starts with its everyday tools (files, commands, web, questions,
// to-dos, memory, codemode) plus `load_tools`, whose description lists the
// rest in one line each. The model loads what it needs by name; loaded tools
// are declared from its next step. Once a chat has loaded, called or been
// given (preloaded) an on-demand tool, later runs declare it from the start
// in the same place, so a tool in use stays put and its declaration stays
// cached.
//
// Every tool stays built, approved and executed exactly as before. Only the
// moment its declaration is sent changes.

import type { AgentContext, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
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
  "hooks",
  "design_mode",
  // The rarely used canvas tools; the everyday ones are declared while design mode is on.
  "canvas_page",
  "canvas_duplicate",
]);

const MAX_SUMMARY_CHARACTERS = 90;
/** A tool's own routing line may be longer than a cut first sentence, since it says when to use the tool. */
export const MAX_ON_DEMAND_ROUTING_CHARACTERS = 160;
const MAX_NAMES_PER_CALL = 20;

/**
 * Text a tool adds to the `load_tools` answer that loads it; one per `key`
 * per answer. A note whose text a tool result in the chat already holds (the
 * model read that guide part earlier) is left out. `heading` leads the notes
 * that carry it, once per answer, and only when one of them is sent.
 */
export interface OnDemandLoadNote {
  readonly key: string;
  readonly text: () => string;
  readonly heading?: string;
}

type RoutedTool = AgentTool & {
  readonly onDemandSummary?: string;
  readonly onDemandLoadNotes?: readonly OnDemandLoadNote[];
};

/**
 * Give an on-demand tool its own `load_tools` catalog line: what it does and
 * when to use it, in place of its description's first sentence cut short.
 */
export function declareOnDemandSummary<T extends AgentTool>(tool: T, summary: string): T {
  const line = summary.replace(/\s+/gu, " ").trim();
  if (!line || line.length > MAX_ON_DEMAND_ROUTING_CHARACTERS) {
    throw new Error(`${tool.name}'s catalog line must be 1 to ${MAX_ON_DEMAND_ROUTING_CHARACTERS} characters.`);
  }
  return Object.assign(tool, { onDemandSummary: line });
}

/**
 * Give an on-demand tool notes that come back in the same `load_tools` answer
 * that loads it, such as the guide it needs before its first call, so loading
 * and reading take one step. Notes with the same key (another tool loaded in
 * the same call needs the same guide) are sent once.
 */
export function declareOnDemandLoadNotes<T extends AgentTool>(tool: T, notes: readonly OnDemandLoadNote[]): T {
  const existing = (tool as RoutedTool).onDemandLoadNotes ?? [];
  return Object.assign(tool, { onDemandLoadNotes: [...existing, ...notes] });
}

/**
 * The notes of `loaded` tools, in load order, each key once, leaving out any
 * whose text `alreadyRead` says the chat's tool results already hold.
 */
function onDemandLoadAnswerNotes(loaded: readonly AgentTool[], alreadyRead: (text: string) => boolean): string[] {
  const seen = new Set<string>();
  const headed = new Set<string>();
  const texts: string[] = [];
  for (const tool of loaded) {
    for (const note of (tool as RoutedTool).onDemandLoadNotes ?? []) {
      if (seen.has(note.key)) continue;
      seen.add(note.key);
      const text = note.text().trim();
      if (!text || alreadyRead(text)) continue;
      const heading = note.heading?.trim();
      if (heading && !headed.has(heading)) {
        headed.add(heading);
        texts.push(heading);
      }
      texts.push(text);
    }
  }
  return texts;
}

/** The text of every tool result in `messages`, read once the first time it is asked for. */
function toolResultTexts(messages: readonly AgentMessage[]): (text: string) => boolean {
  let texts: string[] | undefined;
  return (text) => {
    texts ??= messages.flatMap((message) =>
      message.role === "toolResult" && !message.isError
        ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")]
        : [],
    );
    return texts.some((result) => result.includes(text));
  };
}

/** A tool's `load_tools` catalog line: its own routing line, or its description's first sentence. */
export function onDemandCatalogLine(tool: AgentTool): string {
  return (tool as RoutedTool).onDemandSummary ?? onDemandToolSummary(tool.description);
}

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
  /**
   * Tools to declare at the start of a run over `messages` (the chat so far).
   * `declaredBefore` is the on-demand list an earlier run of this chat
   * declared (see `onDemandDeclaredOfBranch`); it keeps its place first. The
   * tools the chat loaded or called since follow in first-use order, then
   * `preload`: on-demand tools this run declares from the start without a
   * load (for example the visual tools on a /visualize turn or in design
   * mode), in catalog order. Each run's list only grows at its end, so the
   * provider's cached tool prefix holds.
   */
  initialTools(
    messages: readonly AgentMessage[],
    preload?: readonly string[],
    declaredBefore?: readonly string[],
  ): AgentTool[];
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
  const catalog = onDemand.map((tool) => `- ${tool.name}: ${onDemandCatalogLine(tool)}`).join("\n");
  // The chat as of this run's latest step, so a load answer leaves out guide parts already read.
  let transcript: readonly AgentMessage[] = [];

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
        const notes = onDemandLoadAnswerNotes(loaded.map((name) => byName.get(name)!), toolResultTexts(transcript));
        return {
          content: [{
            type: "text",
            text: [`Loaded ${loaded.join(", ")}. Call ${loaded.length === 1 ? "it" : "them"} from your next step.`, ...notes].join("\n\n"),
          }],
          details: null,
        };
      },
    },
    "safe",
  );

  return {
    loader,
    onDemand,
    initialTools(messages, preload = [], declaredBefore = []) {
      transcript = messages;
      // What an earlier run declared keeps its place; tools used since follow
      // in first-use order (the order `prepare` appended them in), and this
      // run's preloads go last, so nothing already declared moves.
      const order: string[] = [];
      const listed = new Set<string>();
      const add = (name: string) => {
        if (!available.has(name) || listed.has(name)) return;
        listed.add(name);
        order.push(name);
      };
      for (const name of declaredBefore) add(name);
      for (const name of onDemandToolsUsed(messages, available)) add(name);
      const wanted = new Set(preload);
      for (const tool of onDemand) if (wanted.has(tool.name)) add(tool.name);
      return [...everyday, loader, ...order.map((name) => byName.get(name)!)];
    },
    async prepare(context) {
      transcript = context.messages;
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

/** Journal entry recording the on-demand tools a run declared from its start, in order. */
export const ON_DEMAND_DECLARED_ENTRY = "aiden.on-demand-declared.v1";

/** The on-demand tool names in `tools`, in declared order: what a run records under `ON_DEMAND_DECLARED_ENTRY`. */
export function onDemandDeclaredNames(tools: readonly AgentTool[], onDemand: readonly AgentTool[]): string[] {
  const names = new Set(onDemand.map((tool) => tool.name));
  return tools.filter((tool) => names.has(tool.name)).map((tool) => tool.name);
}

/**
 * The on-demand list the latest run on this journal branch recorded, or none.
 * A preloaded tool the chat never called stays here, so the next run keeps
 * declaring it in the same place instead of dropping it.
 */
export function onDemandDeclaredOfBranch(
  branch: readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[],
): string[] {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "custom" || entry.customType !== ON_DEMAND_DECLARED_ENTRY) continue;
    const names = (entry.data as { names?: unknown } | undefined)?.names;
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string").slice(0, 200) : [];
  }
  return [];
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
