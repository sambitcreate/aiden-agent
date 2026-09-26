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

/** Called before a tool discards text; no raw output ever enters Activity metadata. */
export async function boundedToolOutput(text: string, limit: number): Promise<string> {
  if (text.length <= limit) return text;
  let marker = "\n[Output truncated; no retained output available.]";
  const sink = context.getStore();
  if (sink) {
    try {
      const retained = text.slice(0, MAX_STORED_TOOL_OUTPUT_CHARS);
      const handle = await sink.save(retained);
      marker = `\n[Output preview. Read retained output with read_tool_output handle=${handle}; offsets are UTF-16 characters. Retained ${retained.length} of ${text.length} characters, for up to 7 days subject to storage limits.]`;
    } catch {
      // A storage failure must not turn a successful mutation into a retryable failure.
    }
  }
  return text.slice(0, Math.max(0, limit - marker.length)) + marker;
}

export function withDurableToolOutputs(options: {
  tools: AgentTool[];
  store: ToolOutputStore;
  chatId: string;
  scope: string;
  assertCurrent: () => Promise<void>;
  isCurrent: () => boolean;
}): AgentTool[] {
  const { store, chatId, scope } = options;
  const toolNames = new Set(options.tools.map((tool) => tool.name));
  const wrapped = options.tools.map((tool): AgentTool => ({
    ...tool,
    execute: (...args) => context.run(tool.name === "run_command" || (tool as AgentTool & { [OUTPUT_SOURCE]?: boolean })[OUTPUT_SOURCE] ? {
      save: async (text) => {
        await options.assertCurrent();
        return store.put(chatId, scope, tool.name, text, options.isCurrent);
      },
    } : undefined, () => tool.execute(...args)),
  }));
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
  return wrapped;
}
