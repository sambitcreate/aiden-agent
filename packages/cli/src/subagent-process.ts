import { DEFAULT_SUBAGENT_CHILD_DEADLINE_MS, MAX_SUBAGENT_CHILD_EVENTS, MAX_SUBAGENT_CHILD_TOOL_CALLS, MAX_SUBAGENT_CHILD_TURNS, MAX_SUBAGENT_CHILD_OUTPUT_CHARS, MAX_SUBAGENT_CHILD_PROTOCOL_CHARS } from "../../../main/services/subagents/subagent-child-policy.js";
import { captureLiveSubagentContext } from "../../../main/services/subagents/forked-context.js";
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import type { AgentTool, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type AssistantMessage } from "@earendil-works/pi-ai";
import type { RunSubagentChildInput } from "../../../main/services/subagents/subagent-child-runner.js";
import { subagentRoleSystemPrompt } from "../../../main/services/subagents/role-catalog.js";
import { MAX_SUBAGENT_SUMMARY_CHARS } from "../../../main/services/subagents/contracts.js";
import { recordUsage } from "./usage-ledger.ts";

/** Inference is isolated; exact tools and approvals remain owned by the parent. */
export async function runCliSubagent(agentDir: string, input: RunSubagentChildInput, tools: AgentTool[], beforeTool: (name: string, id: string, args: unknown, context?: BeforeToolCallContext) => Promise<void>, diagnostic?: (error: Error) => void) {
  const limits = {
    deadline: input.policy?.deadlineMs ?? DEFAULT_SUBAGENT_CHILD_DEADLINE_MS,
    events: input.policy?.maxEvents ?? MAX_SUBAGENT_CHILD_EVENTS,
    tools: input.policy?.maxToolCalls ?? MAX_SUBAGENT_CHILD_TOOL_CALLS,
    turns: input.policy?.maxTurns ?? MAX_SUBAGENT_CHILD_TURNS,
    output: input.policy?.maxOutputChars ?? MAX_SUBAGENT_CHILD_OUTPUT_CHARS,
    protocol: input.policy?.maxProtocolChars ?? MAX_SUBAGENT_CHILD_PROTOCOL_CHARS,
  };
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid subagent execution budget.");
  const startedAt = Date.now(), messages: AssistantMessage[] = [];
  let text = "", failure: Error | undefined, done = false, toolCalls = 0, turns = 0, events = 0, bytes = 0;
  const child = fork(join(dirname(process.env.AIDEN_CLI_ENTRY!), "subagent-worker.js"), [], { cwd: input.workspaceRoot, stdio: ["ignore", "ignore", "pipe", "ipc"],
    detached: process.platform !== "win32", env: { ...process.env, PI_TELEMETRY: "0", AIDEN_CHILD: "1" }, execArgv: [] });
  const toolAbort = new AbortController(), activeTools = new Set<Promise<void>>();
  const kill = (signal: NodeJS.Signals) => { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, signal); } catch { /* The process group may already have exited. */ } };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: Error) => { if (failure) return; failure = error; toolAbort.abort(error); kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 1000); };
  const abort = () => stop(new Error("Subagent cancelled."));
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new Error("Subagent deadline elapsed.")), limits.deadline);
  let stderr = "";
  child.stderr?.on("data", (value) => { stderr = (stderr + value.toString()).slice(-8_192); });
  const reply = (value: object) => { if (child.connected) child.send(value, (error) => { if (error && !done) stop(error); }); };
  child.on("message", (event: any) => {
    if (!event || typeof event !== "object") { stop(new Error("Invalid child protocol message.")); return; }
    if (failure) return;
    if (++events > limits.events || (bytes += Buffer.byteLength(JSON.stringify(event))) > limits.protocol) { stop(new Error("Subagent protocol budget exhausted.")); return; }
    if (event.type === "tool") {
      if (++toolCalls > limits.tools) { stop(new Error("Subagent tool budget exhausted.")); return; }
      const operation = (async () => {
        try {
          if (typeof event.id !== "string" || event.id.length > 256) throw new Error("Invalid child tool call identity.");
          const tool = tools.find((tool) => tool.name === event.name);
          if (!tool) throw new Error("Tool outside delegated capability profile.");
          const toolCall = { type: "toolCall" as const, id: event.id, name: tool.name, arguments: event.args };
          const args = validateToolArguments(tool, toolCall);
          const assistantMessage = messages.at(-1);
          if (!assistantMessage) throw new Error("Child tool call has no assistant turn.");
          await beforeTool(tool.name, event.id, args, { toolCall, args, assistantMessage, context: { systemPrompt: "", messages, tools } });
          if (toolAbort.signal.aborted) throw new Error("Subagent cancelled before tool execution.");
          input.telemetry?.toolStarted(tool.name);
          const result = tool.name === "subagent" && input.executeNested
            ? { content: [{ type: "text", text: await input.executeNested(args, toolAbort.signal,
              event.args?.context === "fork" ? captureLiveSubagentContext({ chatId: input.v2Authority!.chatId, parentRunId: input.runId!, messages: event.messages, descendantContextWindow: input.runtime.model.contextWindow }) : undefined) }], details: {} }
            : await tool.execute(event.id, args, toolAbort.signal);
          if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("The child tool result exceeds its transport budget.");
          reply({ type: "tool-result", id: event.id, result });
        } catch (error) { reply({ type: "tool-result", id: event.id, error: error instanceof Error ? error.message : String(error) }); }
      })();
      activeTools.add(operation); void operation.finally(() => activeTools.delete(operation));
    } else if (event.type === "turn") { if (++turns > limits.turns) stop(new Error("Subagent turn budget exhausted.")); else input.telemetry?.turnStarted(); }
    else if (event.type === "delta" && typeof event.text === "string") { text += event.text; if (text.length > limits.output) stop(new Error("Subagent output budget exhausted.")); else input.telemetry?.textDelta(event.text); }
    else if (event.type === "protocol" && Number.isSafeInteger(event.chars) && event.chars >= 0) {
      bytes += event.chars; input.telemetry?.protocolDelta?.(event.chars);
      if (bytes > limits.protocol) stop(new Error("Subagent protocol budget exhausted."));
    }
    else if (event.type === "assistant") { messages.push(event.message); input.telemetry?.usage(event.message); }
    else if (event.type === "done") done = true;
    else if (event.type === "failure") stop(new Error(typeof event.message === "string" ? event.message : "The child model could not complete this task."));
  });
  try {
    input.telemetry?.starting();
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => { if (failure) reject(failure); else if (code !== 0 || !done) { if (stderr) diagnostic?.(new Error(stderr)); reject(new Error("Subagent exited before completing.")); } else resolve(); });
      child.send({ type: "start", agentDir, cwd: input.workspaceRoot, provider: input.runtime.model.provider, model: input.runtime.model.id,
        thinkingLevel: input.thinkingLevel, prompt: input.request.task, systemPrompt: subagentRoleSystemPrompt(input.request.role, { contextMode: input.context.mode, workspaceRead: input.v2Authority?.capabilities.workspaceRead ?? tools.length > 0, workspaceWrite: input.v2Authority?.capabilities.workspaceWrite, shell: input.v2Authority?.capabilities.shell, delegation: Boolean(input.executeNested), mcpRead: input.v2Authority?.capabilities.mcp.some((scope) => scope.tools.some((tool) => tool.effect === "read")), mcpMutation: input.v2Authority?.capabilities.mcp.some((scope) => scope.tools.some((tool) => tool.effect === "mutating")) }),
        messages: input.context.messages, tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      });
      input.telemetry?.running(); if (input.signal?.aborted) abort();
    });
    const last = messages.at(-1);
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error("The child model returned no successful final answer.");
    const summary = messages.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text)).join("\n");
    return { role: input.request.role, label: input.request.label, status: "completed" as const, summary: summary.slice(0, MAX_SUBAGENT_SUMMARY_CHARS), ...(summary.length > MAX_SUBAGENT_SUMMARY_CHARS ? { summaryTruncated: true as const } : {}) };
  } catch (error) {
    diagnostic?.(error instanceof Error ? error : new Error(String(error)));
    return { role: input.request.role, label: input.request.label, status: input.signal?.aborted ? "interrupted" as const : Date.now() - startedAt >= (limits.deadline) ? "timed_out" as const : "failed" as const, summary: "The subagent did not complete this investigation." };
  } finally {
    toolAbort.abort(); kill("SIGKILL"); clearTimeout(timer); if (escalation) clearTimeout(escalation); input.signal?.removeEventListener("abort", abort);
    await Promise.allSettled(activeTools);
    for (const message of messages) await recordUsage(agentDir, "subagent", message).catch(() => {});
  }
}
