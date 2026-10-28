// The renderer's view of a Bot event routine (no token hash, no bookkeeping).

import type { BotRoutineTrigger } from "./bot-routine-trigger.js";

export interface BotEventRoutineView {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  trigger: BotRoutineTrigger;
  enabled: boolean;
  lastRunAt?: number;
}
