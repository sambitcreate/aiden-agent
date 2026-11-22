// The `check_back` tool: a workspace chat's agent promises to look again later
// and Aiden keeps the promise, posting a "Checking back" notice into this chat
// at that minute. Setting one needs a turn the person started (desktop or
// phone, or the owed turn answering the person's queued message): woken
// turns, other windowless turns and goal rounds refuse `set` before it runs
// (`chatTurnArgsToolRefusal`), so check-backs can't chain. `list` and
// `cancel` always work.

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { CHECK_BACK_LIMITS, CHECK_BACK_TOOL_NAME, checkBackClock, type CheckBackView } from "../../../renderer/shared/check-backs.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import type { WakeUpWhen } from "../wake-up-time.js";
import type { CheckBackOutcome } from "./check-backs.js";

/** What the activity row reads from a successful `set` (main formats the time). */
export interface CheckBackToolDetails {
  checkBack?: { fireAt: number };
}

export interface CheckBackToolOptions {
  chatId: string;
  /** The turn that sets it, saved with the record. */
  turnId?: string;
  checkBacks: {
    set(chatId: string, input: { when: WakeUpWhen; note: string; turnId?: string }): Promise<CheckBackOutcome<{ checkBack: CheckBackView }>>;
    list(chatId: string): CheckBackView[];
    cancel(chatId: string, id: string): Promise<CheckBackOutcome<{ cancelled: CheckBackView }>>;
  };
  /** The zone times are shown in (the host's). */
  timezone(): string;
  /** This turn's refusal for a call, checked again here in case the call skipped the turn policy. */
  refusal?(args: unknown): string | undefined;
}

export const CHECK_BACK_TOOL_DESCRIPTION =
  "Promise to look at something again later in this chat, when you have told the person you will check back (a deploy, a long build, a reply you are waiting for). " +
  "At that minute Aiden posts your note into this chat and you answer it. " +
  `Use in_minutes (${CHECK_BACK_LIMITS.minMinutes}-${CHECK_BACK_LIMITS.maxMinutes}) or a local 24-hour time "HH:MM" within the next 24 hours, and a note of at most ${CHECK_BACK_LIMITS.noteChars} characters saying exactly what to check. ` +
  `At most ${CHECK_BACK_LIMITS.maxPendingPerChat} can be pending in a chat; the person sees each one and can cancel it. ` +
  "When it fires nobody may be watching: that turn has no approvals, connectors, subagents or Computer Use, and cannot set another check-back. Only promise what you can do with your other tools (reading files, running commands, checking a URL). " +
  "For anything that repeats, suggest a scheduled task instead. Actions: set, list, cancel (by id from list).";

function result(value: unknown, details: CheckBackToolDetails = {}, isError = false): AgentToolResult<CheckBackToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details,
    ...(isError ? { isError: true } : {}),
  } as AgentToolResult<CheckBackToolDetails>;
}

export function createCheckBackTool(options: CheckBackToolOptions): AgentTool {
  const modelView = (checkBack: CheckBackView) => ({
    id: checkBack.id,
    at: checkBackClock(checkBack.fireAt, options.timezone()),
    note: checkBack.note,
  });
  const tool: AgentTool = {
    name: CHECK_BACK_TOOL_NAME,
    label: "Check back",
    description: CHECK_BACK_TOOL_DESCRIPTION,
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("set"), Type.Literal("list"), Type.Literal("cancel")]),
        in_minutes: Type.Optional(
          Type.Integer({ minimum: CHECK_BACK_LIMITS.minMinutes, maximum: CHECK_BACK_LIMITS.maxMinutes }),
        ),
        at: Type.Optional(Type.String({ description: 'Local 24-hour time "HH:MM" within the next 24 hours.' })),
        note: Type.Optional(Type.String({ maxLength: CHECK_BACK_LIMITS.noteChars, description: "What to check when the time comes." })),
        id: Type.Optional(Type.String({ description: "The check-back to cancel." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams, signal): Promise<AgentToolResult<CheckBackToolDetails>> => {
      signal?.throwIfAborted();
      const params = rawParams as { action?: unknown; in_minutes?: unknown; at?: unknown; note?: unknown; id?: unknown };
      if (params.action === "list") {
        return result({ ok: true, pending: options.checkBacks.list(options.chatId).map(modelView) });
      }
      if (params.action === "cancel") {
        if (typeof params.id !== "string" || !params.id.trim()) {
          return result({ ok: false, code: "not_found", message: "cancel needs the id of a pending check-back from list." }, {}, true);
        }
        const outcome = await options.checkBacks.cancel(options.chatId, params.id.trim());
        return outcome.ok
          ? result({ ok: true, cancelled: modelView(outcome.cancelled) })
          : result({ ok: false, code: outcome.code, message: outcome.message, pending: outcome.pending?.map(modelView) ?? [] }, {}, true);
      }
      if (params.action !== "set") {
        return result({ ok: false, code: "invalid_action", message: "Use set, list or cancel." }, {}, true);
      }
      const refused = options.refusal?.(rawParams);
      if (refused) throw new Error(refused);
      const hasMinutes = params.in_minutes !== undefined;
      const hasAt = params.at !== undefined;
      if (hasMinutes === hasAt) {
        return result({ ok: false, code: "invalid_time", message: "Give exactly one of in_minutes or at." }, {}, true);
      }
      const when: WakeUpWhen | undefined = hasMinutes
        ? typeof params.in_minutes === "number"
          ? { inMinutes: params.in_minutes }
          : undefined
        : typeof params.at === "string"
          ? { at: params.at }
          : undefined;
      if (!when) return result({ ok: false, code: "invalid_time", message: 'in_minutes is a whole number and at is "HH:MM".' }, {}, true);
      const outcome = await options.checkBacks.set(options.chatId, {
        when,
        note: typeof params.note === "string" ? params.note : "",
        ...(options.turnId ? { turnId: options.turnId } : {}),
      });
      if (!outcome.ok) {
        return result(
          { ok: false, code: outcome.code, message: outcome.message, ...(outcome.pending ? { pending: outcome.pending.map(modelView) } : {}) },
          {},
          true,
        );
      }
      return result(
        {
          ok: true,
          checkBack: modelView(outcome.checkBack),
          message: "Set. The person sees it beside the chat and can cancel it. Tell them briefly when you will check back, then end your answer.",
        },
        { checkBack: { fireAt: outcome.checkBack.fireAt } },
      );
    },
  };
  // Setting one arms a later wake; never replay it after a crash.
  return declarePiRuntimeReplay(tool, "never");
}
