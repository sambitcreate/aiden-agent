// The memory review's `note_follow_up` tool: record a dated promise the Bot
// made in a person turn. Add-only; the person approves the follow-up later.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BotCommitmentStore } from "./store.js";

export const NOTE_FOLLOW_UP_TOOL_NAME = "note_follow_up";

/** The review prompt's lines for this tool. */
export const NOTE_FOLLOW_UP_INSTRUCTIONS = [
  "When the Bot promised to follow up on something by a date (\"I'll check on the invoice Friday\"), call note_follow_up with what to follow up on and the date, YYYY-MM-DD, between tomorrow and 60 days ahead. Add due_time (HH:MM) only when a time was promised.",
  "Never note a follow-up the person did not ask for or the Bot did not promise.",
];

export function createNoteFollowUpTool(deps: {
  botId: string;
  store: Pick<BotCommitmentStore, "add">;
  onAdded(botId: string): void;
}): AgentTool {
  return {
    name: NOTE_FOLLOW_UP_TOOL_NAME,
    label: "Note follow-up",
    description: "Record a dated follow-up the Bot promised. The person is asked before anything is scheduled.",
    parameters: Type.Object(
      {
        text: Type.String({ description: "What to follow up on, in a few words." }),
        due_date: Type.String({ description: "YYYY-MM-DD." }),
        due_time: Type.Optional(Type.String({ description: "HH:MM, only when promised." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params): Promise<AgentToolResult<null>> => {
      const input = params as { text?: unknown; due_date?: unknown; due_time?: unknown };
      const text = typeof input.text === "string" ? input.text : "";
      const dueDate = typeof input.due_date === "string" ? input.due_date : "";
      const outcome = await deps.store.add(deps.botId, {
        text,
        dueDate,
        ...(typeof input.due_time === "string" ? { dueTime: input.due_time } : {}),
      });
      if (outcome.ok) deps.onAdded(deps.botId);
      const body = outcome.ok ? { ok: true } : { ok: false, code: outcome.code, error: outcome.error };
      return {
        content: [{ type: "text", text: JSON.stringify(body) }],
        details: null,
        ...(outcome.ok ? {} : { isError: true }),
      } as AgentToolResult<null>;
    },
  };
}
