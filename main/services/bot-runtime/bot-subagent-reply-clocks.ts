// One helper time limit per Bot execution claim on the desktop.
//
// A claim is one admitted input and the reply it produces. The Bot's tools
// are rebuilt for every durable task phase, so a clock held by the tool would
// restart on each helper call. These clocks live outside the tools, keyed by
// the claim, and are dropped when the claim's reply ends or is dismissed. A
// new input gets a new claim, so it starts a new reply with a fresh 60 minutes.

import { SubagentReplyClock } from "../subagents/subagent-supervisor-core.js";
import { botExecutionScope, type BotExecutionPort } from "./bot-execution.js";

/** Bounds memory if an end signal is ever missed; the oldest claim goes first. */
const MAX_CLAIM_CLOCKS = 256;

export interface BotSubagentReplyClocks {
  /** The clock for the running claim; a lone call outside any claim gets its own. */
  clockFor(botId: string): SubagentReplyClock;
  release(botId: string, claimId: string): void;
  forgetBot(botId: string): void;
  /** Clocks currently held. */
  readonly size: number;
  /** The port, releasing a claim's clock when its reply ends or is dismissed. */
  releasingWith(port: BotExecutionPort): BotExecutionPort;
}

export function createBotSubagentReplyClocks(): BotSubagentReplyClocks {
  const clocks = new Map<string, { botId: string; clock: SubagentReplyClock }>();
  const keyOf = (botId: string, claimId: string) => JSON.stringify([botId, claimId]);
  const release = (botId: string, claimId: string) => {
    clocks.delete(keyOf(botId, claimId));
  };
  return {
    clockFor(botId) {
      const claim = botExecutionScope(botId)?.claim;
      if (!claim) return new SubagentReplyClock();
      const key = keyOf(botId, claim.id);
      const held = clocks.get(key);
      if (held) return held.clock;
      const clock = new SubagentReplyClock();
      clocks.set(key, { botId, clock });
      if (clocks.size > MAX_CLAIM_CLOCKS) clocks.delete(clocks.keys().next().value!);
      return clock;
    },
    release,
    forgetBot(botId) {
      for (const [key, held] of clocks) if (held.botId === botId) clocks.delete(key);
    },
    get size() {
      return clocks.size;
    },
    releasingWith(port) {
      return {
        ...port,
        async settled(botId, claim) {
          release(botId, claim.id);
          await port.settled?.(botId, claim);
        },
        async dismissed(botId, claim) {
          release(botId, claim.id);
          await port.dismissed?.(botId, claim);
        },
      };
    },
  };
}

/** The desktop's clocks, shared by the tool builder and the execution port. */
export const botSubagentReplyClocks = createBotSubagentReplyClocks();
