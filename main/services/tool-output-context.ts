import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { MAX_STORED_TOOL_OUTPUT_CHARS, type ToolOutputStore } from "./tool-output-store.js";

interface OutputContext {
  save: (text: string) => Promise<string>;
}
const context = new AsyncLocalStorage<OutputContext | undefined>();
const OUTPUT_SOURCE = Symbol("aiden-tool-output-source");
export function markToolOutputSource<T extends AgentTool>(tool: T): T {
  return Object.assign(tool, { [OUTPUT_SOURCE]: true });
}

/**
 * Keep the start and the end of `text` within `limit` characters, with
 * `marker(omitted)` in place of the cut middle, so trailing errors and
 * summaries survive. Never splits a surrogate pair.
 */
export function truncateMiddle(text: string, limit: number, marker: (omitted: number) => string): string {
  if (text.length <= limit) return text;
  // The marker's own length depends on the omitted count; size it for the worst case.
  const budget = Math.max(0, limit - marker(text.length).length);
  let head = Math.ceil(budget / 2);
  let tail = budget - head;
  const surrogate = (index: number, low: number) => (text.charCodeAt(index) & 0xfc00) === low;
  if (head > 0 && surrogate(head - 1, 0xd800)) head -= 1;
  if (tail > 0 && surrogate(text.length - tail, 0xdc00)) tail -= 1;
  return text.slice(0, head) + marker(text.length - head - tail) + (tail > 0 ? text.slice(text.length - tail) : "");
}

/** Called before a tool discards text; no raw output ever enters Activity metadata. */
export async function boundedToolOutput(text: string, limit: number): Promise<string> {
  if (text.length <= limit) return text;
  let retained = "no retained output available";
  const sink = context.getStore();
  if (sink) {
    try {
      const kept = text.slice(0, MAX_STORED_TOOL_OUTPUT_CHARS);
      const handle = await sink.save(kept);
      retained = `read the full text with read_tool_output handle=${handle}; offsets are UTF-16 characters. Retained ${kept.length} of ${text.length} characters, for up to 7 days subject to storage limits`;
    } catch {
      // A storage failure must not turn a successful mutation into a retryable failure.
    }
  }
  return truncateMiddle(text, limit, (omitted) => `\n[Output truncated: ${omitted} of ${text.length} characters omitted from the middle; ${retained}.]\n`);
}

export interface DurableToolOutputs {
  /** The generation's tools with retention attached, plus `read_tool_output`. */
  tools: AgentTool[];
  /**
   * Attach the same retention to tools admitted after the generation started
   * (late MCP discovery) and let `read_tool_output` read their handles. The
   * same input tool always maps to the same wrapper.
   */
  adopt(tools: readonly AgentTool[]): AgentTool[];
}

export function createDurableToolOutputs(options: {
  tools: AgentTool[];
  store: ToolOutputStore;
  chatId: string;
  scope: string;
  assertCurrent: () => Promise<void>;
  isCurrent: () => boolean;
}): DurableToolOutputs {
  const { store, chatId, scope } = options;
  const toolNames = new Set(options.tools.map((tool) => tool.name));
  const wrap = (tool: AgentTool): AgentTool => ({
    ...tool,
    execute: (...args) => context.run(tool.name === "run_command" || (tool as AgentTool & { [OUTPUT_SOURCE]?: boolean })[OUTPUT_SOURCE] ? {
      save: async (text) => {
        await options.assertCurrent();
        return store.put(chatId, scope, tool.name, text, options.isCurrent);
      },
    } : undefined, () => tool.execute(...args)),
  });
  const wrapped = options.tools.map(wrap);
  wrapped.push(declarePiRuntimeReplay({
    name: "read_tool_output",
    label: "Read retained output",
    description: "Read a bounded text window from an oversized tool result previously retained in this chat. Handles expire and require unchanged workspace and connector access. Never accepts a filesystem path.",
    parameters: Type.Object({
      handle: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      length: Type.Optional(Type.Integer({ minimum: 1, maximum: 8_000 })),
    }),
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      await options.assertCurrent();
      const { handle, offset = 0, length = 8_000 } = args as { handle: string; offset?: number; length?: number };
      const text = await store.read(chatId, scope, toolNames, handle, offset, length);
      await options.assertCurrent();
      if (!options.isCurrent()) throw new Error("Tool output access changed.");
      signal?.throwIfAborted();
      return { content: [{ type: "text", text }], details: null };
    },
  }, "safe"));
  const adopted = new WeakMap<AgentTool, AgentTool>();
  return {
    tools: wrapped,
    adopt: (late) => late.flatMap((tool) => {
      // A late tool can never shadow the reader itself.
      if (tool.name === "read_tool_output") return [];
      let wrapper = adopted.get(tool);
      if (!wrapper) {
        wrapper = wrap(tool);
        adopted.set(tool, wrapper);
        toolNames.add(tool.name);
      }
      return [wrapper];
    }),
  };
}

export function withDurableToolOutputs(
  options: Parameters<typeof createDurableToolOutputs>[0],
): AgentTool[] {
  return createDurableToolOutputs(options).tools;
}
