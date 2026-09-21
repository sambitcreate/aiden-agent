import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FormFillService } from "./service.js";
import type { FormFillBatchResult } from "./batch-core.js";
import { FORM_FILL_TOOL_NAME } from "./service.js";

export { FORM_FILL_TOOL_NAME };

const FormFillParameters = Type.Object(
  {
    attachment_id: Type.String({
      description:
        "ID of the document attached to the user's message that contains the " +
        "source Label: value pairs. Never pass file paths or invented content.",
    }),
    pid: Type.Integer({
      description:
        "Process id owning the exact window to fill (from computer_use list_windows/capture).",
      minimum: 1,
    }),
    window_id: Type.Integer({
      description: "Exact window id to fill (from computer_use list_windows/capture).",
      minimum: 1,
    }),
  },
  { additionalProperties: false },
);

export type FormFillResultDetails = FormFillBatchResult & { sourceDocument: string };

/**
 * The specialist tool references ONLY a current attachment and an exact bound
 * window — it accepts no entities, values, or free text from the model.
 */
export function createFormFillAgentTool(
  service: FormFillService,
): AgentTool<typeof FormFillParameters, FormFillResultDetails> {
  return {
    name: FORM_FILL_TOOL_NAME,
    label: "Form Fill",
    description:
      "Fill a form in one exact window from explicit Label: value pairs in a " +
      "document the user attached to their message, using Aiden's on-device " +
      "form-matching model. Shows one review card, then fills approved fields " +
      "through Computer Use. Never submits the form. Requires attachment_id " +
      "and the exact pid/window_id from a computer_use window listing.",
    parameters: FormFillParameters,
    executionMode: "sequential",
    execute: async (toolCallId, params: Static<typeof FormFillParameters>, signal) => {
      const result = await service.execute(toolCallId, params, signal);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: result.failed === 0,
              plan_id: result.planId,
              filled: result.filled,
              already_satisfied: result.alreadySatisfied,
              untouched: result.untouched,
              needs_review: result.needsReview,
              failed: result.failed,
              not_attempted: result.notAttempted,
              stopped_early: result.stoppedEarly,
              ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
              submitted: false,
            }),
          },
        ],
        details: result,
      };
    },
  };
}
