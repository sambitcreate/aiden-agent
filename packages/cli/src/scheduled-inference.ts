import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ScheduledTask } from "../../../main/services/types.js";
import { assertScheduledMcpServerBindings } from "../../../main/services/schedule-mcp-binding.js";
import { createCliModelRuntime } from "./providers.ts";
import { createCliMcpPool } from "./mcp.ts";
import { createCliWebSearch } from "./extensions/web-search.ts";
import { recordUsage } from "./usage-ledger.ts";
import { messageText } from "./sessions.ts";

/** An unattended schedule receives only its persisted tool and connector selection. */
export async function runScheduledInference(agentDir: string, cwd: string, task: ScheduledTask, signal: AbortSignal, assertAuthority: () => Promise<void>) {
  const pool = createCliMcpPool(agentDir), produced: AssistantMessage[] = [];
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let removeEvents = () => {}, calls = 0, turns = 0, bytes = 0;
  const abort = () => { void session?.abort(); };
  combined.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Scheduled inference timed out.")), 300_000);
  const check = async () => {
    combined.throwIfAborted(); await assertAuthority();
    const servers = await pool.listServers();
    const selected = (task.mcpServerIds ?? []).map((id) => {
      const server = servers.find((item) => item.enabled && item.id === id);
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
      if (event.type === "message_end" && event.message.role === "assistant") produced.push(event.message);
      if (event.type === "message_update" && (bytes += Buffer.byteLength(JSON.stringify(event.assistantMessageEvent))) > 2 * 1024 * 1024) controller.abort(new Error("Scheduled response budget exhausted."));
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
