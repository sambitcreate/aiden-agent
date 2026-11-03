import type { BotOpenWorkMutation, BotOpenWorkResult, BotOpenWorkSnapshot, BotOpenWorkExecution, BotOpenWorkStopReceipt } from "../../../renderer/shared/bot-open-work.js";
import { parseBotOpenWorkMutation, parseBotOpenWorkSnapshot, parseBotOpenWorkEvidence } from "../../../renderer/shared/bot-open-work.js";
import type { BotOpenWorkStore, BotOpenWorkOrigin } from "./store.js";
import type { BotLinkedWorkExecutionPort } from "./stop.js";
export interface BotOpenWorkServiceOptions { store: BotOpenWorkStore; execution: BotLinkedWorkExecutionPort; publish?(botId: string): void; }
export function createBotOpenWorkService(ports: BotOpenWorkServiceOptions) {
  async function snapshot(botId: string): Promise<BotOpenWorkSnapshot> {
    const view = await ports.store.snapshot(botId);
    view.items = await Promise.all(view.items.map(async (item) => {
      if (!item.source.submissionId) return { ...item, execution: { state: "idle", canStop: false, blockedReason: "not_linked" } as BotOpenWorkExecution };
      try {
        const state = await ports.execution.inspect(botId, item.source.submissionId);
        const stopping = item.lastStop?.state === "requested" || item.lastStop?.state === "uncertain";
        if (state.kind === "terminal" && state.resultEntryId) {
          const result = { submissionId: item.source.submissionId, entryId: state.resultEntryId };
          item.links = [...item.links.filter((link) => link.kind !== "result"), { kind: "result", ...result }];
          if (item.completion) item.completion = { ...item.completion, result };
        }
        const mixed = (state.kind === "running" || state.kind === "interrupted") && (state.inputSubmissionIds.length !== 1 || state.inputSubmissionIds[0] !== item.source.submissionId);
        const execution: BotOpenWorkExecution = { state: stopping ? "stopping" : state.kind === "queued" ? "queued" : state.kind === "running" ? "running" : state.kind === "interrupted" ? "interrupted" : "idle", canStop: !stopping && !mixed && ["queued", "running", "interrupted"].includes(state.kind), ...(mixed ? { blockedReason: "mixed_inputs" as const } : {}) };
        return { ...item, execution };
      } catch { return { ...item, execution: { state: "idle", canStop: false, blockedReason: "host_unavailable" } as BotOpenWorkExecution }; }
    }));
    return parseBotOpenWorkSnapshot(view);
  }
  async function enrich(botId: string, result: BotOpenWorkResult): Promise<BotOpenWorkResult> {
    if (!result.ok && !result.snapshot) return result;
    try { return { ...result, snapshot: await snapshot(botId) }; } catch { return result; }
  }
  async function mutateByPerson(botId: string, value: BotOpenWorkMutation): Promise<BotOpenWorkResult> {
    let command: BotOpenWorkMutation;
    try { command = parseBotOpenWorkMutation(value); } catch { return { ok: false, code: "invalid", error: "Review the Open work fields and try again." }; }
    let result: BotOpenWorkResult;
    try { result = await ports.store.mutate(botId, command); }
    catch { return { ok: false, code: "unavailable", error: "Open work could not confirm this change. Retry the same action to check its outcome." }; }
    const acceptedNew = result.ok && !result.replayed;
    if (result.ok && (command.action === "stop" || command.action === "stop_and_dismiss") && result.stop && ["requested", "uncertain"].includes(result.stop.state)) {
      const source = result.snapshot.items.find((item) => item.id === command.id)?.source.submissionId;
      let outcome: Pick<BotOpenWorkStopReceipt, "state" | "reason">;
      try {
        const stopped = source ? await ports.execution.stop(botId, source, command.mutationId) : "not_running";
        outcome = stopped === "mixed_inputs" ? { state: "blocked", reason: "mixed_inputs" } : { state: stopped };
      } catch { outcome = { state: "uncertain", reason: "host_unavailable" }; }
      try { result = await ports.store.acknowledgeStop(botId, command.mutationId, outcome); }
      catch {
        // Publication may have succeeded before its acknowledgement failed.
        try { result = await ports.store.mutate(botId, command); } catch { /* Retain the durable intent for an exact retry. */ }
      }
    }
    if (acceptedNew || result.ok && !result.replayed) ports.publish?.(botId);
    return enrich(botId, result);
  }
  return {
    snapshot,
    async evidence(botId: string, itemId: string, kind: "source" | "result") {
      if (kind !== "source" && kind !== "result") return undefined;
      const item = (await ports.store.snapshot(botId)).items.find((candidate) => candidate.id === itemId);
      if (!item?.source.submissionId || !ports.execution.evidence) return undefined;
      const evidence = await ports.execution.evidence(botId, item.source.submissionId, kind);
      return evidence ? parseBotOpenWorkEvidence({ ...evidence, itemId, kind, title: item.title }) : undefined;
    },
    toolSnapshot: (botId: string) => ports.store.snapshot(botId),
    mutateByPerson,
    async mutateByBot(botId: string, command: BotOpenWorkMutation, origin: BotOpenWorkOrigin): Promise<BotOpenWorkResult> {
      if (["stop", "stop_and_dismiss", "undo"].includes(command.action)) return { ok: false, code: "invalid", error: "Stopping linked work and Undo belong to the person." };
      const result = await ports.store.mutate(botId, command, "bot", origin);
      if (result.ok && !result.replayed) ports.publish?.(botId);
      // Tool calls must not reopen the harness through a host lock they already hold.
      return result;
    },
    async forgetBot(botId: string) { await ports.store.forgetBot(botId); ports.publish?.(botId); },
  };
}
export type BotOpenWorkService = ReturnType<typeof createBotOpenWorkService>;
