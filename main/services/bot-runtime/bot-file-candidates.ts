// The Bot file router as durable-turn candidates. A routine's own writes must
// not fire its folder trigger again, so they go to the own-write journal
// (`bot-routine-events/own-writes.ts`). The registry holds the attended tool
// set (it is built without a turn), so each call asks which run it serves
// (`BotToolCall.runRequestIds`) and journals only for a routine run.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildBotFileTools, type BotFileToolLocation } from "../bot-file-tool-router.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { botTurnOf } from "./bot-tool-policy.js";

export interface BotFileCandidateInput {
  /** The turn the tools were built for is a routine run. */
  routine: boolean;
  /** Journals one file a routine run wrote with write_file or edit_file. */
  recordOwnWrite(absolutePath: string): void;
}

export function botFileCandidates(locations: readonly BotFileToolLocation[], input: BotFileCandidateInput): BotToolCandidate[] {
  if (locations.length === 0) return [];
  const build = (routine: boolean) =>
    buildBotFileTools({
      defaultLocation: locations[0]!,
      additionalLocations: locations.slice(1),
      ...(routine ? { onWrite: input.recordOwnWrite } : {}),
    });
  const offered = build(input.routine);
  let routineTools: AgentTool[] | undefined = input.routine ? offered : undefined;
  return offered.map((tool, index): BotToolCandidate => ({
    tool,
    bind: (call) => ({
      ...tool,
      async execute(toolCallId, params, signal, onUpdate) {
        const routine =
          input.routine || ((await call.runRequestIds?.()) ?? []).some((requestId) => botTurnOf(requestId).routine);
        const target = routine ? (routineTools ??= build(true))[index]! : tool;
        return target.execute(toolCallId, params, signal, onUpdate);
      },
    }),
  }));
}
