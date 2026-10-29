import { mcpServerOffersTools } from "../../../renderer/shared/mcp-exposure.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ScheduledTask } from "../../../main/services/types.js";
import { assertScheduledMcpServerBindings } from "../../../main/services/schedule-mcp-binding.js";
import { createCliModelRuntime } from "./providers.ts";
import { createCliMcpPool } from "./mcp.ts";
import { createCliWebSearch } from "./extensions/web-search.ts";
import { recordUsage } from "./usage-ledger.ts";
import { messageText } from "./sessions.ts";

/**
 * Counts a streamed reply's bytes once each: deltas as they arrive, plus whatever
 * a block's `*_end` carries beyond its deltas, so a block delivered whole (redacted
 * thinking, tool-call arguments sent at start or end) still counts. Every update
 * also carries the whole partial message, which is never counted.
 */
export function createReplyMeter() {
  const streamed = new Map<number, number>();
  let total = 0;
  return {
    /** A new assistant message starts its content indices afresh. */
    nextMessage() { streamed.clear(); },
    add(event: AssistantMessageEvent): number {
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
        const bytes = Buffer.byteLength(event.delta);
        streamed.set(event.contentIndex, (streamed.get(event.contentIndex) ?? 0) + bytes);
        total += bytes;
      } else if (event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end") {
        const block = event.partial.content[event.contentIndex];
        const size = event.type === "toolcall_end" ? Buffer.byteLength(JSON.stringify(event.toolCall.arguments ?? {}))
          : Buffer.byteLength(event.content) + (block?.type === "thinking" && block.redacted ? Buffer.byteLength(block.thinkingSignature ?? "") : 0);
        total += Math.max(0, size - (streamed.get(event.contentIndex) ?? 0));
        streamed.delete(event.contentIndex);
      }
      return total;
    },
  };
}

/** An unattended schedule receives only its persisted tool and connector selection. */
export async function runScheduledInference(agentDir: string, cwd: string, task: ScheduledTask, signal: AbortSignal, assertAuthority: () => Promise<void>) {
  const pool = createCliMcpPool(agentDir), produced: AssistantMessage[] = [];
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let removeEvents = () => {}, calls = 0, turns = 0;
  const reply = createReplyMeter();
  const abort = () => { void session?.abort().catch(() => {}); };
  combined.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Scheduled inference timed out.")), 300_000);
  const check = async () => {
    combined.throwIfAborted(); await assertAuthority();
    const servers = await pool.listServers();
    const selected = (task.mcpServerIds ?? []).map((id) => {
      // A server switched off for the model fails the run instead of running without it.
      const server = servers.find((item) => item.enabled && mcpServerOffersTools(item) && item.id === id);
      if (!server) throw new Error("An approved scheduled MCP connection is unavailable.");
      return server;
    });
    assertScheduledMcpServerBindings(selected, task.mcpServerBindings ?? []);
    combined.throwIfAborted(); return selected;
  };
  try {
    const runtime = await createCliModelRuntime(agentDir), model = runtime.getModel(task.providerId!, task.model!);
    if (!model) throw new Error("Scheduled provider/model is unavailable.");
    const selected = await check();
    const tools: AgentTool[] = (await Promise.all(selected.map((server) => pool.agentTools(server, combined)))).flat();
    if (task.webSearchEnabled) { const tool = await createCliWebSearch(agentDir).toolForGeneration(); if (!tool) throw new Error("Scheduled Web Search is unavailable."); tools.push(tool); }
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [{ name: "aiden-schedule-authority", factory(pi) {
        for (const tool of tools) pi.registerTool({ ...tool, label: tool.label ?? tool.name });
        pi.on("tool_call", async () => { try { if (++calls > 64) throw new Error("Scheduled tool budget exhausted."); await check(); } catch (error) { return { block: true, reason: String(error) }; } });
      } }],
    });
    await loader.reload();
    const created = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
      tools: [...(task.permission === "full" ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"]), ...tools.map(({ name }) => name)],
    });
    session = created.session;
    removeEvents = session.subscribe((event) => {
      if (event.type === "turn_start" && ++turns > 24) controller.abort(new Error("Scheduled turn budget exhausted."));
      if (event.type === "message_start") reply.nextMessage();
      if (event.type === "message_end" && event.message.role === "assistant") produced.push(event.message);
      if (event.type === "message_update" && reply.add(event.assistantMessageEvent) > 2 * 1024 * 1024) controller.abort(new Error("Scheduled response budget exhausted."));
    });
    await check(); await session.prompt(task.prompt!, { expandPromptTemplates: false }); combined.throwIfAborted();
    const last = produced.at(-1);
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error("Scheduled inference did not produce a final response.");
    return produced.map((message) => messageText(message.content)).join("\n").slice(0, 100_000);
  } finally {
    clearTimeout(timer); combined.removeEventListener("abort", abort); removeEvents(); session?.dispose(); await pool.close();
    for (const message of produced) await recordUsage(agentDir, "scheduled", message).catch(() => {});
  }
}
