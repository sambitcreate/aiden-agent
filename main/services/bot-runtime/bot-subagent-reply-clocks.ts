// One helper time limit per Bot execution claim on the desktop.
//
// A claim is one admitted input and the reply it produces. The Bot's tools
// are rebuilt for every durable task phase, so a clock held by the tool would
// restart on each helper call. These clocks live outside the tools, keyed by
// the claim, and are dropped when the claim's reply ends, is dismissed or is
// resumed by a person. A quiet automatic retry keeps the clock. A new input gets a new claim, so it starts a new reply with a fresh
// 60 minutes, and a person's Resume starts the interrupted reply's clock again.
//
// There is no size cap: dropping a clock whose reply is still running would
// hand that reply a fresh 60 minutes. A clock is a few bytes, every claim ends
// in one of the release signals or with its Bot's removal, and the map starts
// empty with each launch of the app.

import { SubagentReplyClock } from "../subagents/subagent-supervisor-core.js";
import { botExecutionScope, type BotExecutionPort } from "./bot-execution.js";

export interface BotSubagentReplyClocks {
  /** The clock for the running claim; a lone call outside any claim gets its own. */
  clockFor(botId: string): SubagentReplyClock;
  release(botId: string, claimId: string): void;
  forgetBot(botId: string): void;
  /** Clocks currently held. */
  readonly size: number;
  /** The port, releasing a claim's clock when its reply ends, is dismissed or is resumed by a person. */
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
        async resumed(botId, claim) {
          release(botId, claim.id);
          await port.resumed?.(botId, claim);
        },
      };
    },
  };
}

/** The desktop's clocks, shared by the tool builder and the execution port. */
export const botSubagentReplyClocks = createBotSubagentReplyClocks();
