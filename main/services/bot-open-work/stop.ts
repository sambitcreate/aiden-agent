import type { ConversationId, Harness, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { LiveDoc, InboxDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
export type BotLinkedWorkInspection =
  | { kind: "queued" }
  | { kind: "running" | "interrupted"; taskId: string; inputSubmissionIds: string[] }
  | { kind: "terminal"; resultEntryId?: string; stopped?: true }
  | { kind: "missing" };
export type BotLinkedWorkStopOutcome = "stopped" | "already_finished" | "not_running" | "mixed_inputs" | "uncertain";
export interface BotLinkedWorkExecutionPort {
  inspect(botId: string, submissionId: string): Promise<BotLinkedWorkInspection>;
  stop(botId: string, submissionId: string, intentId?: string): Promise<BotLinkedWorkStopOutcome>;
  evidence?(botId: string, submissionId: string, kind: "source" | "result"): Promise<BotLinkedWorkEvidence | undefined>;
}
function submissionId(value: string): SubmissionId | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
  const number = Number(value); return Number.isSafeInteger(number) ? number as SubmissionId : undefined;
}
/** Passive inspection: opening a host and reading a receipt never resumes its scheduler. */
export async function inspectLinkedBotWork(harness: Harness, conversationId: ConversationId, source: string): Promise<BotLinkedWorkInspection> {
  const id = submissionId(source);
  if (id === undefined) return { kind: "missing" };
  const record = await (await harness.submission(id, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
  if (!record || record.type !== "input" || record.conversationId !== conversationId) return { kind: "missing" };
  if (record.status === "queued") return { kind: "queued" };
  if (record.status === "done" || record.status === "unanswered") return { kind: "terminal", ...(record.status === "unanswered" && record.reason === "aborted" ? { stopped: true as const } : {}), ...(record.status === "done" && record.answer !== undefined ? { resultEntryId: String(record.answer) } : {}) };
  const live = await harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
  if (!live?.run?.inputs.includes(id)) return { kind: "missing" };
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return { kind: inspection.scheduling === "paused" ? "interrupted" : "running", taskId: String(live.run.taskId), inputSubmissionIds: live.run.inputs.map(String) };
}
/** The public waitForTask asks for progress and resumes every paused task. Observe only. */
async function waitForLinkedTaskPassively(harness: Harness, task: TaskId, context: Context): Promise<boolean> {
  const watch = await harness.watchTaskGraph(context);
  try {
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    watch.start(async (call) => { if (call.kind === "value" && !call.value.tasks[String(task)]) resolveTerminal(); });
    if (!watch.value.tasks[String(task)]) resolveTerminal();
    if ((await harness.getTask(task, context))?.state.status === "terminal") return true;
    // A persisted abort mark still needs its cleanup phase. The person must
    // explicitly resume a reopened harness; Stop cannot start other tasks.
    if ((await harness.inspect(context)).scheduling !== "running") return false;
    await Promise.race([
      terminal,
      watch.closed.then(() => { throw new Error("Linked Stop observation ended before acknowledgement."); }),
    ]);
    return (await harness.getTask(task, context))?.state.status === "terminal";
  } finally { await watch.stop(); }
}
/** Abort only this source's task; the conversation-wide abort withdraws unrelated queued inputs. */
export async function stopLinkedBotWork(harness: Harness, conversationId: ConversationId, source: string, options: { intentId?: string; mayContinue?(): Promise<boolean>; deadlineMs?: number } = {}): Promise<BotLinkedWorkStopOutcome> {
  const id = submissionId(source); if (id === undefined) return "not_running";
  const alreadyRunning = (await harness.inspect(BACKGROUND_CONTEXT)).scheduling === "running";
  let marked = false;
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  const timer = setTimeout(() => cancel(new Error("Linked Stop confirmation timed out.")), options.deadlineMs ?? 5_000);
  try {
    for (let handoff = 0; handoff < 8; handoff++) {
      const state = await inspectLinkedBotWork(harness, conversationId, source);
      if (state.kind === "terminal") {
        if (state.stopped && marked && alreadyRunning && options.intentId && options.mayContinue && await options.mayContinue()) {
          const current = await harness.inspect(context);
          const live = await harness.snapshot(LiveDoc, conversationId, context);
          const inbox = await harness.snapshot(InboxDoc, conversationId, context);
          if (current.scheduling === "running" && !live?.run && inbox?.items.some((item) => item.mode !== "write") && await options.mayContinue()) {
            const conversation = await harness.conversation(conversationId, context);
            // Public idle write admission places existing queued inputs in order.
            // Empty model content contributes no user text or learning input.
            await conversation?.submit({ type: "write", requestId: `open-work-stop:${options.intentId}`, entry: { kind: "aiden.open-work-stop-boundary", model: [] } }, context);
          }
        }
        return state.stopped ? "stopped" : "already_finished";
      }
      if (state.kind === "missing") return "not_running";
      if (state.kind === "queued") {
        const aborted = await harness.abortSubmission(id, context, conversationId);
        if (aborted === "aborted") return "stopped";
        if (aborted === "not_found") return "not_running";
        if (aborted === "settled") return "already_finished";
        continue;
      }
      if (state.inputSubmissionIds.length !== 1 || state.inputSubmissionIds[0] !== source) return "mixed_inputs";
      // The exact task ID fences handoff: aborting an old terminal task cannot
      // accidentally target the unrelated run that became current meanwhile.
      const task = Number(state.taskId) as TaskId;
      await harness.abortTask(task, context); marked = true;
      if (!await waitForLinkedTaskPassively(harness, task, context)) return "uncertain";
    }
    return "uncertain";
  } catch { return "uncertain"; }
  finally { clearTimeout(timer); cancel(); }
}

export interface BotLinkedWorkEvidence { submissionId: string; entryId: string; text: string; truncated: boolean; createdAt?: number; }
/** Read only the original input or terminal answer of an exact owned submission, including compacted history. */
export async function readLinkedBotWorkEvidence(harness: Harness, conversationId: ConversationId, source: string, kind: "source" | "result"): Promise<BotLinkedWorkEvidence | undefined> {
  const id = submissionId(source); if (id === undefined) return undefined;
  const record = await (await harness.submission(id, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
  if (!record || record.type !== "input" || record.conversationId !== conversationId) return undefined;
  const entryId = kind === "source" ? record.entry : record.status === "done" ? record.answer : undefined;
  if (entryId === undefined) return undefined;
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  const entry = await conversation?.commit((tx) => tx.entry(entryId), BACKGROUND_CONTEXT);
  const message = entry?.model?.[0];
  if (!message || (kind === "source" ? message.role !== "user" : message.role !== "assistant")) return undefined;
  const text = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
  let bounded = "", bytes = 0;
  for (const part of text) { const length = Buffer.byteLength(part); if (bytes + length > 32 * 1024) break; bounded += part; bytes += length; }
  return { submissionId: source, entryId: String(entryId), text: bounded, truncated: bounded.length < text.length, ...(Number.isSafeInteger(message.timestamp) && message.timestamp >= 0 ? { createdAt: message.timestamp } : {}) };
}
