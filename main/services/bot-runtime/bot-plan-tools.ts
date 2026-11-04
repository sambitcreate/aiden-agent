import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { BOT_PLAN_LIMITS as L, BOT_PLAN_MAX_MS, BOT_PLAN_STEP_TOOL_NAME, BOT_PROPOSE_PLAN_TOOL_NAME } from "../../../renderer/shared/bot-plans.js";
import { botMessageTurnOf } from "../../../renderer/shared/bot-messages.js";
import { withoutBotHandoffControls } from "../../../renderer/shared/bot-handoffs.js";
import type { BotPlans } from "../bot-plans/plans.js";
import type { BotPlanAccessPort, BotPlanBotTurnPort } from "../bot-plans/ports.js";
import { isBotPlanProposal } from "../bot-plans/store.js";
import type { BotPlanProposal, BotPlanValidation } from "../bot-plans/validate.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { botIngressAllowsTool } from "./bot-tool-policy.js";
import type { BotToolCall } from "./tool-adapter.js";

export const BOT_PLAN_MEMO = "aiden.plan";
export interface BotPlanToolDeps {
  plans: Pick<BotPlans, "request" | "markStep" | "grantFreshAccess" | "respond" | "current">;
  validate(botId: string, input: unknown, call?: BotToolCall): Promise<BotPlanValidation>;
  access?: BotPlanAccessPort;
  botTurns?: BotPlanBotTurnPort;
  botName(botId: string): Promise<string | undefined>;
  now?(): number;
}

interface PlanMemo {
  planId: string;
  inputHash: string;
  toolCallId: string;
  taskId: string;
  requestIds: string[];
  proposal: JsonValue;
  from?: string;
}
const DESCRIPTION = "Ask the person to approve a whole task at once instead of one card per step. Use it before a task that will need several approvals. `steps` are plain sentences the person reads, never commands or code. `covers` lists exactly what may run without asking: connected-app actions that change things (`connector`, with the exact tool names), clicks and typing on one site (`site`), folders (`files`), the shell in your folder (`shell`), and Ask first rules by their name (`rule`). Anything not covered still asks on its own card. Passwords, codes, money and Computer Use on the person's Mac are never covered. Wait for the answer. After approval, call plan_step as you finish each step.";
const ENDED = "This plan has ended. Ask again for a new task.";
const UNAVAILABLE = "The authoritative Bot message delivery is unavailable. This plan didn't start. Ask again in a new task.";
const result = (text: string, isError = false): AgentToolResult<null> => ({ content: [{ type: "text", text }], details: null, ...(isError ? { isError: true } : {}) });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
const inputHash = (input: unknown) => createHash("sha256").update(canonical(input)).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const nonemptyIds = (ids: readonly string[]) => ids.length > 0 && ids.length <= 256 && ids.every(id => typeof id === "string" && !!id.trim() && id.length <= 256) && new Set(ids).size === ids.length;

/** Re-read the current invocation's host ownership. Raw ids decide ingress; mapped ids bind authority. */
async function currentRun(call: BotToolCall, tool: string): Promise<{ raw: readonly (string | undefined)[]; ids: readonly string[] }> {
  if (call.signal.aborted) throw call.signal.reason;
  if (!call.assertRunActive || !call.runRequestIds || !call.runInputIds) throw new Error("The owning Bot run is unavailable.");
  await call.assertRunActive();
  const raw = await call.runRequestIds();
  if (!botIngressAllowsTool(tool, raw)) throw new Error("Plans are off for this Bot turn.");
  const ids = await call.runInputIds();
  if (!nonemptyIds(ids) || ids.length !== raw.length) throw new Error("The owning Bot input identities are unavailable.");
  if (call.signal.aborted) throw call.signal.reason;
  return { raw, ids };
}

function memoOf(value: JsonValue): PlanMemo {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.planId !== "string" || !/^[A-Za-z0-9-]{1,64}$/u.test(value.planId) ||
      typeof value.inputHash !== "string" || typeof value.toolCallId !== "string" || typeof value.taskId !== "string" ||
      !Array.isArray(value.requestIds) || !nonemptyIds(value.requestIds as string[]) || !isBotPlanProposal(value.proposal) ||
      (value.from !== undefined && typeof value.from !== "string")) throw new Error("The saved plan identity is unavailable. Ask again in a new task.");
  return freeze(value as unknown as PlanMemo);
}

function parameters() {
  const max = Type.Optional(Type.Integer({ minimum: 1, maximum: L.maxCeiling }));
  const action = Type.String({ minLength: 1, maxLength: L.actionChars });
  return Type.Object({
    title: Type.String({ minLength: 1, maxLength: L.titleChars }), why: Type.String({ minLength: 1, maxLength: L.whyChars }),
    steps: Type.Array(Type.Object({ text: Type.String({ minLength: 1, maxLength: L.stepChars }) }, { additionalProperties: false }), { minItems: 1, maxItems: L.steps }),
    covers: Type.Array(Type.Union([
      Type.Object({ connector: action, action, tools: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: L.toolsPerItem, uniqueItems: true }), max }, { additionalProperties: false }),
      Type.Object({ site: Type.String({ minLength: 1, maxLength: 2048 }), action: Type.Literal("browse"), max }, { additionalProperties: false }),
      Type.Object({ files: Type.String({ minLength: 1, maxLength: 4096 }), action: Type.Union([Type.Literal("read"), Type.Literal("write")]) }, { additionalProperties: false }),
      Type.Object({ shell: Type.Literal("bot_home") }, { additionalProperties: false }),
      Type.Object({ rule: Type.String({ minLength: 1, maxLength: 200 }), max }, { additionalProperties: false }),
    ]), { minItems: 1, maxItems: L.covers }),
  }, { additionalProperties: false });
}

export function proposePlanCandidate(botId: string, deps: BotPlanToolDeps): BotToolCandidate {
  const schema: AgentTool = {
    name: BOT_PROPOSE_PLAN_TOOL_NAME, label: "Propose a plan", description: DESCRIPTION, parameters: parameters(), executionMode: "sequential",
    async execute() { throw new Error("A plan needs the Bot's live task."); },
  };
  return { tool: schema, replay: "safe", interactive: true, bind: call => ({
    ...schema,
    async execute(_id, input) {
      const now = deps.now ?? Date.now;
      let run = await currentRun(call, BOT_PROPOSE_PLAN_TOOL_NAME);
      if (!call.readMemo || !call.taskId) throw new Error("The owning Bot task memo is unavailable.");
      const argumentsHash = inputHash(input);
      const message = run.raw.map(botMessageTurnOf).find(turn => turn.kind === "message");
      if (message && (!deps.botTurns || deps.botTurns.originOf(run.raw)?.originBotId !== message.fromBotId)) throw new Error("The authoritative Bot delivery port is unavailable.");
      const saved = await call.readMemo<JsonValue>(BOT_PLAN_MEMO);
      let memo: PlanMemo;
      if (saved !== undefined) {
        memo = memoOf(saved);
      } else {
        const validated = await deps.validate(botId, input, call);
        if (!validated.ok) throw new Error(validated.problems.join("\n"));
        const name = message ? (await deps.botName(message.fromBotId)) ?? message.fromBotId : undefined;
        const from = name === undefined ? undefined : [...withoutBotHandoffControls(name).replace(/\s+/gu, " ").trim()].slice(0, 120).join("");
        memo = memoOf(await call.memo(BOT_PLAN_MEMO, {
          planId: randomUUID(), inputHash: argumentsHash, toolCallId: call.callId, taskId: call.taskId,
          requestIds: [...run.ids], proposal: JSON.parse(JSON.stringify(validated.proposal)) as JsonValue,
          ...(from ? { from } : {}),
        }));
      }
      // Another execution can win the first memo while validation awaits.
      // Verify the returned immutable identity in both the read and write paths.
      if (memo.inputHash !== argumentsHash || memo.taskId !== call.taskId || memo.toolCallId !== call.callId) throw new Error("The plan replay arguments or task identity changed.");
      const proposal = memo.proposal as unknown as BotPlanProposal;
      const deadlineText = () => result(`Nobody approved “${proposal.title}” in time, so it didn't start.`);
      const expiredResult = async () => {
        const approved = await call.readMemo!<{ approved: boolean }>(`${BOT_PLAN_MEMO}.approved`);
        const current = await deps.plans.current(botId);
        return approved?.approved || (current?.planId === memo.planId && current.status !== "pending") ? result(ENDED) : deadlineText();
      };
      run = await currentRun(call, BOT_PROPOSE_PLAN_TOOL_NAME);
      if (!memo.requestIds.some(id => run.ids.includes(id))) throw new Error("The plan's owning run ended. Ask again for a new task.");
      // Notification deduplication belongs to A. Its authoritative deadline is
      // read on every replay, regardless of whether it published a notice.
      let window: { deadline: number; expired: boolean } | undefined;
      if (run.raw.some(id => botMessageTurnOf(id).kind === "message")) {
        if (!deps.botTurns) return result(UNAVAILABLE, true);
        try { window = await deps.botTurns.announceWaiting(botId, run.raw, proposal.title, memo.planId); }
        catch { return result(UNAVAILABLE, true); }
        if (!window || !Number.isFinite(window.deadline)) return result(UNAVAILABLE, true);
      }
      const savedWindow = await call.memo(`${BOT_PLAN_MEMO}.deadline`, { deadline: window?.deadline ?? null });
      if (savedWindow.deadline !== (window?.deadline ?? null)) return result("The plan's Bot delivery deadline changed. Ask again in a new task.", true);
      const deadline = savedWindow.deadline ?? undefined;
      if (window?.expired || (deadline !== undefined && now() >= deadline)) return expiredResult();
      const timed = new AbortController();
      const signal = AbortSignal.any([call.signal, timed.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadline !== undefined) timer = setTimeout(() => timed.abort(new Error("The Bot delivery deadline passed.")), Math.max(0, deadline - now()));
      const request = () => deps.plans.request({ botId, planId: memo.planId, toolCallId: memo.toolCallId, proposal, requestIds: memo.requestIds, ...(memo.from === undefined ? {} : { from: memo.from }), ...(deadline === undefined ? {} : { deadline }), signal });
      try {
        await currentRun(call, BOT_PROPOSE_PLAN_TOOL_NAME);
        if (deadline !== undefined && now() >= deadline) return deadlineText();
        const answer = await request();
        if (answer.status === "approved") await call.memo(`${BOT_PLAN_MEMO}.approved`, { approved: true });
        if (call.signal.aborted) throw call.signal.reason;
        if (deadline !== undefined && now() >= deadline) {
          if (answer.status === "approved") await deps.plans.respond(botId, memo.planId, "stop");
          return answer.status === "approved" ? result(ENDED) : deadlineText();
        }
        if (answer.status !== "approved") return result(answer.status === "declined" ? `The person said Not now to “${proposal.title}”. Don't start it. Ask what they'd like instead.` : ENDED);
        const folder = proposal.items.find(item => item.kind === "files" && item.grant);
        let grantMissing = false;
        if (folder?.kind === "files" && answer.fresh) {
          if (!deps.access || !proposal.authorization.folder) {
            await deps.plans.respond(botId, memo.planId, "stop");
            return result("Outside-folder access is unavailable. Use request_access to ask for access again.", true);
          }
          try {
            grantMissing = !await deps.plans.grantFreshAccess(botId, memo.planId, async () => {
              const current = await currentRun(call, BOT_PROPOSE_PLAN_TOOL_NAME);
              if (!memo.requestIds.some(id => current.ids.includes(id)) || signal.aborted) throw new Error("This plan's owning run ended.");
              await deps.access!.allowOnce(botId, { path: folder.path, access: folder.access, requestIds: memo.requestIds, planId: memo.planId,
                expiresAt: Math.min(answer.expiresAt, deadline ?? Infinity), authorization: proposal.authorization.folder! });
            });
          } catch (error) {
            if (call.signal.aborted) throw call.signal.reason;
            throw Object.assign(new Error("This plan's outside-folder access changed. Use request_access to ask for access again."), { cause: error });
          }
        }
        const currentRunState = await currentRun(call, BOT_PROPOSE_PLAN_TOOL_NAME);
        if (!memo.requestIds.some(id => currentRunState.ids.includes(id))) throw new Error("The plan's owning run ended.");
        const current = await deps.plans.current(botId);
        if (call.signal.aborted) throw call.signal.reason;
        if (deadline !== undefined && now() >= deadline) return result(ENDED);
        if (current?.planId !== memo.planId || current.status !== "active" || current.expiresAt === undefined || now() >= current.expiresAt) return result(ENDED);
        if (grantMissing) {
          await deps.plans.respond(botId, memo.planId, "stop");
          return result("This plan couldn't install its outside-folder access. Use request_access to ask for access again.", true);
        }
        const lifetime = answer.fresh && current.expiresAt - now() >= BOT_PLAN_MAX_MS - 1000 ? "for the next 60 minutes" : "until this task ends or the plan's original deadline";
        const recovery = folder && !answer.fresh ? " Stored approval does not restore temporary outside-folder access. If that folder is unavailable, use request_access again." : "";
        return result(`The person approved “${proposal.title}”. Covered steps run without asking ${lifetime} or until an item's limit is used; anything else still asks. Call plan_step after each step.${recovery}`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  }) };
}

export function planStepCandidate(botId: string, plans: Pick<BotPlans, "markStep">): BotToolCandidate {
  const schema: AgentTool = { name: BOT_PLAN_STEP_TOOL_NAME, label: "Mark a plan step", description: "Mark an approved plan's step done or skipped. Use its step number, from 1 to 10. Repeating the same mark is safe.",
    parameters: Type.Object({ step: Type.Integer({ minimum: 1, maximum: L.steps }), status: Type.Union([Type.Literal("done"), Type.Literal("skipped")]) }, { additionalProperties: false }),
    async execute() { throw new Error("A plan step needs the Bot's live task."); },
  };
  return { tool: schema, replay: "safe", bind: call => ({ ...schema, async execute(_id, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Give a step from 1 to 10 and status done or skipped.");
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => key !== "step" && key !== "status") || !Number.isInteger(value.step) || (value.step as number) < 1 || (value.step as number) > L.steps || (value.status !== "done" && value.status !== "skipped")) throw new Error("Give a step from 1 to 10 and status done or skipped.");
    const run = await currentRun(call, BOT_PLAN_STEP_TOOL_NAME), n = value.step as number, status = value.status;
    const outcome = await plans.markStep(botId, run.ids, n, status);
    if (call.signal.aborted) throw call.signal.reason;
    return result(outcome === "finished" ? "All steps are marked; the plan has ended." : outcome === "no_plan" ? "No approved plan is running in this turn." : outcome === "no_step" ? `This plan has no step ${n}.` : `Step ${n} marked ${status}.`);
  } }) };
}
