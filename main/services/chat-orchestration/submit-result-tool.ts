// `submit_result` (docs/plans/proactive-aiden-plan.md, Phase 5, D6): offered
// in a chat another chat started with a result schema. The value is checked
// with ajv against that schema; the newest accepted one replaces any earlier
// one and is what the lead's `wait` returns. Exempt from approval: it only
// records an answer for the lead.

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { AidenRemoteServiceError } from "../aiden-remote-errors.js";
import { SUBMIT_RESULT_TOOL_NAME } from "../../../renderer/shared/child-chats.js";
import { ChildChatRefusal, type ChildChats } from "./child-chats.js";

export function createSubmitResultTool(options: {
  chatId: string;
  schema: Record<string, unknown>;
  childChats: Pick<ChildChats, "submitResult">;
}): AgentTool {
  const respond = (value: unknown, isError = false) =>
    ({
      content: [{ type: "text", text: JSON.stringify(value) }],
      details: {},
      ...(isError ? { isError: true } : {}),
    }) as AgentToolResult<Record<string, never>>;
  return {
    name: SUBMIT_RESULT_TOOL_NAME,
    label: "Submit result",
    description:
      "Hand your result back to the chat that started this one, as JSON matching the schema it gave (below). " +
      "Call it again to replace an earlier result; a result that doesn't match is refused, naming the fields to fix.\n\nSchema:\n" +
      JSON.stringify(options.schema),
    parameters: Type.Object({ result: Type.Unknown({ description: "The result, matching the schema." }) }, { additionalProperties: false }),
    execute: async (_toolCallId, rawParams, signal) => {
      signal?.throwIfAborted();
      const params = rawParams as { result?: unknown };
      try {
        await options.childChats.submitResult(options.chatId, params.result);
        return respond({ ok: true, accepted: true });
      } catch (error) {
        if (error instanceof ChildChatRefusal || error instanceof AidenRemoteServiceError) return respond({ ok: false, error: error.message }, true);
        throw error;
      }
    },
  };
}
