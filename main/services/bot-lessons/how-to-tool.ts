// The memory review's `note_how_to` tool (spec §7 L3): when the person
// corrected how the Bot did something, keep one how-to lesson for the whole
// Bot. Applied at once (D5) with a "Learned … · Undo" line.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { BOT_LESSON_LEARNED_ENTRY_KIND, type BotLesson } from "../../../renderer/shared/bot-lessons.js";
import type { BotLessonStore } from "./store.js";

export const NOTE_HOW_TO_TOOL_NAME = "note_how_to";

export const NOTE_HOW_TO_INSTRUCTIONS = [
  "When the person corrects how the Bot did something (\"no, put the totals first\"), call note_how_to with when it applies (cue) and what to do (lesson).",
  "Facts about the person go to user memory, not note_how_to.",
];

export function createNoteHowToTool(deps: {
  botId: string;
  lessons: Pick<BotLessonStore, "add">;
  appendEntry(botId: string, kind: string, data: Record<string, unknown>): Promise<void>;
  recorded(botId: string, lesson: BotLesson, retired: readonly BotLesson[]): Promise<void>;
}): AgentTool {
  return {
    name: NOTE_HOW_TO_TOOL_NAME,
    label: "Note how-to",
    description: "Keep one lesson on how the person wants work done, from their correction.",
    parameters: Type.Object(
      {
        cue: Type.String({ description: "When it applies." }),
        lesson: Type.String({ description: "What to do, in a few words." }),
        component: Type.Optional(Type.Union([Type.Literal("output_format"), Type.Literal("procedure")])),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params): Promise<AgentToolResult<null>> => {
      const input = params as { cue?: unknown; lesson?: unknown; component?: unknown };
      const added = await deps.lessons.add(deps.botId, {
        scope: { kind: "bot" },
        cue: typeof input.cue === "string" ? input.cue : "",
        lesson: typeof input.lesson === "string" ? input.lesson : "",
        component: input.component === "procedure" ? "procedure" : "output_format",
        evidence: [],
        verdict: "helped",
        source: "correction",
        status: "active",
      });
      if (added.ok) {
        await deps.recorded(deps.botId, added.lesson, added.retired);
        await deps.appendEntry(deps.botId, BOT_LESSON_LEARNED_ENTRY_KIND, { lessonId: added.lesson.id, lesson: added.lesson.lesson });
      }
      const body = added.ok ? { ok: true } : { ok: false, code: added.code, error: added.error };
      return { content: [{ type: "text", text: JSON.stringify(body) }], details: null, ...(added.ok ? {} : { isError: true }) } as AgentToolResult<null>;
    },
  };
}
