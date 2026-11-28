/**
 * `propose_goal {objective}`: the agent suggests a keep-going goal. The person
 * sees a card "Keep going until: …" with Start and Not now above the
 * composer; nothing starts until they press Start. Declared in every turn of
 * an ordinary chat on this computer, and refused (`TURN_ARGS_REFUSAL_RULES`)
 * in turns Aiden started and turns a paired device sent.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { MAX_GOAL_PROPOSAL_CHARS, PROPOSE_GOAL_TOOL_NAME } from "../../../renderer/shared/goal.js";
import type { GoalProposals } from "./goal-proposals.js";

const PARAMETERS = Type.Object(
  {
    objective: Type.String({
      description: `What "done" means, as one line the person would recognise (up to ${MAX_GOAL_PROPOSAL_CHARS} characters), e.g. "Get the test suite passing and write up what changed".`,
    }),
  },
  { additionalProperties: false },
);

export const PROPOSE_GOAL_DESCRIPTION =
  'Suggest a keep-going goal for this chat: the person sees a card "Keep going until: <objective>" with Start and Not now, and only their Start sets it. ' +
  "With a goal, Aiden keeps working in new rounds after each answer until the objective is met or the person is needed. " +
  "Suggest one when the request is a multi-step outcome that will clearly take several answers (fix a failing suite, finish a migration), not for a question or a quick change. " +
  "Suggest at most once per request; after Not now, don't suggest again unless the person asks. Carry on answering normally after suggesting.";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

export function createProposeGoalTool(context: {
  chatId: string;
  proposals: Pick<GoalProposals, "propose">;
}): AgentTool {
  return {
    name: PROPOSE_GOAL_TOOL_NAME,
    label: "Suggest a goal",
    description: PROPOSE_GOAL_DESCRIPTION,
    parameters: PARAMETERS,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { objective?: unknown };
      const objective = typeof params.objective === "string" ? params.objective : "";
      try {
        const proposal = await context.proposals.propose(context.chatId, objective);
        return text(
          `The person now sees "Keep going until: ${proposal.objective}" with Start and Not now. Nothing starts unless they press Start. Don't repeat the suggestion; carry on with your answer.`,
        );
      } catch (error) {
        return text(
          `The goal wasn't suggested: ${error instanceof Error ? error.message : "it couldn't be shown"}`,
        );
      }
    },
  };
}
