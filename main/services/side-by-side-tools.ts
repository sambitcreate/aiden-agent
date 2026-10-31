// Which tool calls in one model step may run at the same time. Pi runs a
// batch in parallel unless one of its tools is marked sequential, and asks
// each call's approval one at a time before any of them runs. Aiden allows
// only reads: workspace reads and searches, web search and fetch, and MCP
// tools whose server declares them read-only. Anything else in the batch
// keeps the whole batch one at a time.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mcpAgentToolDescriptor } from "./mcp-agent-tool-descriptor.js";
import { mcpAgentToolIdentity } from "./mcp-tool-identity.js";
import { classifySubagentMcpToolV2 } from "./subagents/subagent-mcp-read.js";

const SIDE_BY_SIDE_BUILT_IN_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
]);

/** At most this many calls of one batch run at once; the rest wait for a slot. */
export const MAX_SIDE_BY_SIDE_TOOL_CALLS = 4;

export function runsSideBySide(tool: AgentTool): boolean {
  if (tool.executionMode === "sequential") return false;
  const remote = mcpAgentToolDescriptor(tool);
  if (remote) return classifySubagentMcpToolV2(remote.annotations, remote.execution)?.effect === "read";
  // A remote tool can never borrow a built-in read's name.
  if (mcpAgentToolIdentity(tool)) return false;
  return SIDE_BY_SIDE_BUILT_IN_TOOLS.has(tool.name);
}

class ToolCallSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const admit = () => {
          signal?.removeEventListener("abort", abandon);
          resolve();
        };
        const abandon = () => {
          const index = this.waiting.indexOf(admit);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal?.reason);
        };
        this.waiting.push(admit);
        signal?.addEventListener("abort", abandon, { once: true });
        if (signal?.aborted) abandon();
      });
    } else {
      this.active += 1;
    }
    try {
      return await operation();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/**
 * Returns the tool list a provider request runs its tool calls against: reads
 * share a few slots, and every other tool is marked sequential. Copies are
 * cached so a tool keeps one identity across the requests of a run.
 */
export function createSideBySideToolPolicy(
  limit: number = MAX_SIDE_BY_SIDE_TOOL_CALLS,
): (tools: readonly AgentTool[]) => AgentTool[] {
  const slots = new ToolCallSlots(limit);
  const copies = new WeakMap<AgentTool, AgentTool>();
  // Pi carries a request's tools into the next request, so the policy sees
  // its own copies again; wrapping one twice would hold two slots per call.
  const produced = new WeakSet<AgentTool>();
  return (tools) =>
    tools.map((tool) => {
      if (produced.has(tool)) return tool;
      const cached = copies.get(tool);
      if (cached) return cached;
      const copy: AgentTool = runsSideBySide(tool)
        ? {
            ...tool,
            execute: (toolCallId, params, signal, onUpdate) =>
              slots.run(signal, () => tool.execute(toolCallId, params, signal, onUpdate)),
          }
        : tool.executionMode === "sequential"
          ? tool
          : { ...tool, executionMode: "sequential" };
      copies.set(tool, copy);
      produced.add(copy);
      return copy;
    });
}
