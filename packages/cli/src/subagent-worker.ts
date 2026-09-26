import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createCliModelRuntime } from "./providers.ts";

interface Start {
  type: "start"; agentDir: string; cwd: string; provider: string; model: string; prompt: string; systemPrompt: string;
  thinkingLevel?: import("@earendil-works/pi-agent-core").ThinkingLevel;
  messages: AgentMessage[]; tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}
let session: AgentSession | undefined, started = false, finished = false;
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
const send = (value: unknown) => { if (process.connected) process.send?.(value as any); };
process.on("disconnect", () => { if (!finished) { void session?.abort(); process.exit(1); } });
process.on("message", (message: any) => {
  if (message?.type === "tool-result") {
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
  } else if (message?.type === "cancel") { void session?.abort(); }
  else if (message?.type === "start" && !started) { started = true; void run(message).catch((error) => { send({ type: "failure", message: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; process.disconnect?.(); }); }
});

async function run(input: Start) {
  const runtime = await createCliModelRuntime(input.agentDir), model = runtime.getModel(input.provider, input.model);
  if (!model) throw new Error("The delegated provider/model is unavailable.");
  const loader = new DefaultResourceLoader({ cwd: input.cwd, agentDir: input.agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "aiden-child-tools", factory(pi) {
      pi.on("before_agent_start", () => ({ systemPrompt: input.systemPrompt }));
      for (const tool of input.tools) pi.registerTool({ ...tool, label: tool.name, parameters: Type.Unsafe(tool.parameters),
        execute: async (id, args) => new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); send({ type: "tool", id, name: tool.name, args, ...(tool.name === "subagent" ? { messages: session?.state.messages } : {}) }); }),
      });
    } }],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(input.cwd);
  for (const message of input.messages) {
    if (message.role !== "user" && message.role !== "assistant") throw new Error("Only visible user and assistant context may be forked.");
    manager.appendMessage(message);
  }
  const created = await createAgentSession({ cwd: input.cwd, agentDir: input.agentDir, modelRuntime: runtime, model, thinkingLevel: input.thinkingLevel, tools: input.tools.map((tool) => tool.name), sessionManager: manager, resourceLoader: loader });
  session = created.session;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") send({ type: "delta", text: event.assistantMessageEvent.delta });
    if (event.type === "message_update" && (event.assistantMessageEvent.type === "thinking_delta" || event.assistantMessageEvent.type === "toolcall_delta")) send({ type: "protocol", chars: event.assistantMessageEvent.delta.length });
    if (event.type === "turn_start") send({ type: "turn" });
    if (event.type === "message_end" && event.message.role === "assistant") send({ type: "assistant", message: event.message });
  });
  try { await session.prompt(input.prompt, { expandPromptTemplates: false }); send({ type: "done" }); }
  finally { unsubscribe(); session.dispose(); finished = true; process.disconnect?.(); }
}
