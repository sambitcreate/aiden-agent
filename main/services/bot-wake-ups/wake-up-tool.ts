// The Bot's `wake_up` tool: set, list or cancel its own bounded wake-ups. No
// approval card: the bounds (24 hours, 3 pending, one fire each) and the
// person's per-Bot switch are the control, and every wake-up shows as a chip
// in the chat and a row in the Bot's routines, each with Cancel. Ingress
// (`botIngressAllowsTool`) keeps it to turns a person started.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  BOT_WAKE_UP_ENTRY_KIND,
  BOT_WAKE_UP_LIMITS,
  BOT_WAKE_UP_TOOL_NAME,
} from "../../../renderer/shared/bot-wake-ups.js";
import type { BotWakeUp, BotWakeUps, BotWakeUpWhen } from "./wake-ups.js";

/** What the chat chip needs; the chip reads whether it is still pending from the Bot's routines. */
export interface BotWakeUpEntryData {
  wakeUpId: string;
  fireAt: number;
  note: string;
}

export type BotWakeUpAppend = (kind: typeof BOT_WAKE_UP_ENTRY_KIND, data: BotWakeUpEntryData) => Promise<unknown>;

function result(value: unknown, isError = false): AgentToolResult<null> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: null,
    ...(isError ? { isError: true } : {}),
  } as AgentToolResult<null>;
}

function modelView(wakeUp: BotWakeUp) {
  return { id: wakeUp.id, at: wakeUp.localTime, note: wakeUp.note };
}

const DESCRIPTION =
  "Set a one-time wake-up for yourself in this chat, when you told the person you would check back on something. " +
  `It fires once, here, with your note, as "You set this wake-up at …: <note>". Use in_minutes (${BOT_WAKE_UP_LIMITS.minMinutes}-${BOT_WAKE_UP_LIMITS.maxMinutes}) ` +
  `or a local 24-hour time "HH:MM" within the next 24 hours, and a note of at most ${BOT_WAKE_UP_LIMITS.noteChars} characters saying what to do. ` +
  `At most ${BOT_WAKE_UP_LIMITS.maxPending} can be pending. The person sees each one and can cancel it. ` +
  "For anything that repeats, propose a routine instead. Actions: set, list, cancel (by id from list).";

export function createWakeUpTool(
  botId: string,
  wakeUps: Pick<BotWakeUps, "set" | "pending" | "cancel">,
  append: BotWakeUpAppend,
): AgentTool {
  return {
    name: BOT_WAKE_UP_TOOL_NAME,
    label: "Wake-up",
    description: DESCRIPTION,
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal("set"), Type.Literal("list"), Type.Literal("cancel")]),
        in_minutes: Type.Optional(
          Type.Integer({ minimum: BOT_WAKE_UP_LIMITS.minMinutes, maximum: BOT_WAKE_UP_LIMITS.maxMinutes }),
        ),
        at: Type.Optional(Type.String({ description: 'Local 24-hour time "HH:MM" within the next 24 hours.' })),
        note: Type.Optional(Type.String({ maxLength: BOT_WAKE_UP_LIMITS.noteChars })),
        id: Type.Optional(Type.String({ description: "The wake-up to cancel." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams, signal): Promise<AgentToolResult<null>> => {
      if (signal?.aborted) throw new Error("The wake-up action was cancelled.");
      const params = rawParams as { action?: unknown; in_minutes?: unknown; at?: unknown; note?: unknown; id?: unknown };
      if (params.action === "list") {
        return result({ ok: true, pending: (await wakeUps.pending(botId)).map(modelView) });
      }
      if (params.action === "cancel") {
        if (typeof params.id !== "string" || !params.id.trim()) {
          return result({ ok: false, code: "invalid_id", message: "cancel needs the id of a pending wake-up." }, true);
        }
        const outcome = await wakeUps.cancel(botId, params.id.trim());
        return outcome.ok
          ? result({ ok: true, cancelled: modelView(outcome.cancelled) })
          : result({ ok: false, code: outcome.code, message: outcome.message, pending: outcome.pending?.map(modelView) ?? [] }, true);
      }
      if (params.action !== "set") {
        return result({ ok: false, code: "invalid_action", message: "Use set, list or cancel." }, true);
      }
      const hasMinutes = params.in_minutes !== undefined;
      const hasAt = params.at !== undefined;
      if (hasMinutes === hasAt) {
        return result({ ok: false, code: "invalid_time", message: "Give exactly one of in_minutes or at." }, true);
      }
      const when: BotWakeUpWhen | undefined = hasMinutes
        ? typeof params.in_minutes === "number"
          ? { inMinutes: params.in_minutes }
          : undefined
        : typeof params.at === "string"
          ? { at: params.at }
          : undefined;
      if (!when) return result({ ok: false, code: "invalid_time", message: "in_minutes is a number and at is \"HH:MM\"." }, true);
      const outcome = await wakeUps.set(botId, { when, note: typeof params.note === "string" ? params.note : "" });
      if (!outcome.ok) {
        return result(
          {
            ok: false,
            code: outcome.code,
            message: outcome.message,
            ...(outcome.pending ? { pending: outcome.pending.map(modelView) } : {}),
          },
          true,
        );
      }
      const { wakeUp } = outcome;
      await append(BOT_WAKE_UP_ENTRY_KIND, { wakeUpId: wakeUp.id, fireAt: wakeUp.fireAt, note: wakeUp.note });
      return result({
        ok: true,
        wakeUp: modelView(wakeUp),
        message: "Set. The person sees it in the chat and can cancel it. Tell them briefly when you'll check back.",
      });
    },
  };
}
