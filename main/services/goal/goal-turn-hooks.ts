/**
 * How the chat client and follow-through reach the goal loop without
 * importing it (the loop imports both). `goal-main.ts` installs the real
 * hooks at startup; until then, and in tests that never start it, every hook
 * is a no-op, so a chat without the loop behaves exactly as before.
 */
import type { OwedTurnContext } from "../chat-owed-turn-start.js";

export interface GoalRunSettled {
  chatId: string;
  streamId: string;
  /** What the run started with: the next round starts with the same. */
  context: OwedTurnContext;
  /** The run recorded a Stop. */
  stopped: boolean;
  /** The run ended in an error. */
  failed: boolean;
}

export interface GoalTurnHooks {
  /** The hidden note that follows the person's objective, once per goal. */
  kickoff(chatId: string): string | undefined;
  /** The reminder kept after a compaction summary while the chat's goal is active. */
  reminder(chatId: string): string | undefined;
  /** An ordinary chat run settled. */
  runSettled(event: GoalRunSettled): void;
  /** The chat was deleted: its goal goes with it. */
  chatDeleted(chatId: string): void;
  /** Folder access changed for these chats: an active goal pauses. */
  accessChanged(chatIds: readonly string[]): void;
  /** Why the chat may not move to another workspace now, if it may not. */
  moveRefusal(chatId: string): string | undefined;
}

const none: GoalTurnHooks = {
  kickoff: () => undefined,
  reminder: () => undefined,
  runSettled: () => undefined,
  chatDeleted: () => undefined,
  accessChanged: () => undefined,
  moveRefusal: () => undefined,
};

let current: GoalTurnHooks = none;

export function goalTurnHooks(): GoalTurnHooks {
  return current;
}

export function installGoalTurnHooks(hooks: GoalTurnHooks): void {
  current = hooks;
}
