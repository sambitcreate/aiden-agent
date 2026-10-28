// The Bot's `propose_skill` tool (spec §7 L2). Offered only on turns the
// person is present for; nothing loads until they press Add on the card.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { BOT_SKILL_PROPOSAL_LIMITS } from "../../../renderer/shared/bot-skill-proposals.js";

export const PROPOSE_SKILL_TOOL_NAME = "propose_skill";

export interface ProposeSkillDependencies {
  propose(
    botId: string,
    input: { name: string; description: string; instructions: string; reason?: string },
  ): Promise<{ ok: true; proposalId: string } | { ok: false; code: string; errors: string[] }>;
}

export function createProposeSkillTool(botId: string, deps: ProposeSkillDependencies): AgentTool {
  return {
    name: PROPOSE_SKILL_TOOL_NAME,
    label: "Propose skill",
    description:
      "Propose a skill when you just completed a multi-step procedure the person liked and will want again. " +
      "A skill costs nothing until it is used. Prefer it to adding long notes to memory. " +
      "The person sees the skill on a card and decides; it loads only if they add it. " +
      "name: lowercase letters, numbers and dashes. description: when to use it. instructions: the steps, at most 16 KB.",
    parameters: Type.Object(
      {
        name: Type.String({ maxLength: BOT_SKILL_PROPOSAL_LIMITS.nameChars }),
        description: Type.String({ maxLength: BOT_SKILL_PROPOSAL_LIMITS.descriptionChars }),
        instructions: Type.String(),
        reason: Type.Optional(Type.String({ maxLength: BOT_SKILL_PROPOSAL_LIMITS.reasonChars, description: "One line on why it would help them." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params): Promise<AgentToolResult<null>> => {
      const input = params as { name?: unknown; description?: unknown; instructions?: unknown; reason?: unknown };
      const outcome = await deps.propose(botId, {
        name: typeof input.name === "string" ? input.name : "",
        description: typeof input.description === "string" ? input.description : "",
        instructions: typeof input.instructions === "string" ? input.instructions : "",
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
      });
      const body = outcome.ok
        ? { ok: true, message: "I've shown the person the skill. Don't ask again unless they bring it up." }
        : { ok: false, code: outcome.code, errors: outcome.errors };
      return {
        content: [{ type: "text", text: JSON.stringify(body) }],
        details: null,
        ...(outcome.ok ? {} : { isError: true }),
      } as AgentToolResult<null>;
    },
  };
}
