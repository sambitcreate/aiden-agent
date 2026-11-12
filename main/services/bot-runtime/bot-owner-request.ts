// What the Auto judge may read as "what the owner asked for" (plan §3.2): only
// words the owner wrote. A person's own message counts, and so does the
// prompt of a routine they accepted. Anything else in a run's inputs (an
// event's payload, notes the Bot kept from earlier runs, a wake-up the Bot set
// itself, another Bot's message, Telegram or a peer) could carry someone
// else's instructions, so a run that has any of it is never judged.

import { BOT_ROUTINE_NOTES_HEADER } from "../bot-routine-notes.js";
import { botRoutinePromptOf } from "../scheduled-bot-routines.js";
import { BOT_PERSON_INPUT_KIND, BOT_ROUTINE_INPUT_KIND, parseBotRoutineInputOrigin } from "./bot-input-entry.js";
import { botTurnOf } from "./bot-tool-policy.js";

export interface BotRunInputForJudge {
  /** The submission's request id, when the host gave one. */
  requestId?: string;
  /** The input entry's kind and data. */
  kind: string;
  data?: unknown;
  /** The user text the input put in front of the model. */
  text: string;
}

/** A routine's event block, as `botRoutineEventBlock` writes it. */
const EVENT_BLOCK = /<event source="/u;

/** The owner's own words in one input, or `undefined` when the input carries anyone else's. */
export function ownerWordsOf(input: BotRunInputForJudge): string | undefined {
  const turn = botTurnOf(input.requestId);
  if (turn.botMessage || turn.telegram || turn.peer || turn.intro || input.requestId?.startsWith("wake:")) return undefined;
  if (input.kind === BOT_ROUTINE_INPUT_KIND) {
    const data = input.data as { routineOrigin?: unknown } | undefined;
    const origin = parseBotRoutineInputOrigin(data?.routineOrigin);
    // No accepted-routine origin: a wake-up the Bot set, or a labelled input.
    if (!origin || origin.kind === "event") return undefined;
    if (input.text.startsWith(BOT_ROUTINE_NOTES_HEADER) || EVENT_BLOCK.test(input.text)) return undefined;
    return botRoutinePromptOf(input.text);
  }
  if (input.kind === BOT_PERSON_INPUT_KIND || input.kind === "pi.user") {
    if (turn.routine) return undefined;
    return input.text;
  }
  return undefined;
}

/** The owner's request for a run: every input's own words, or `undefined` when any input isn't only the owner's. */
export function ownerRequestOf(inputs: readonly BotRunInputForJudge[]): string | undefined {
  if (inputs.length === 0) return undefined;
  const words: string[] = [];
  for (const input of inputs) {
    const own = ownerWordsOf(input);
    if (own === undefined) return undefined;
    words.push(own);
  }
  return words.join("\n\n");
}
