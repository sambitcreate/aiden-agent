// A chat's keep-going goal, from the desktop's goal bar and `/goal`.
//
// - `chats:goal:get(chatId)`: the goal's view, or null.
// - `chats:goal:set({chatId, objective, source})`: sets the goal, replacing any
//   earlier one. The renderer then sends the objective as the person's message;
//   the kickoff note rides on that turn. Throws the loop's refusal (a Bot's or
//   an owned chat, no model, the switch off, an objective over the limit).
// - `chats:goal:pause|resume|clear({chatId})`: the person's actions. Resume is
//   also Keep going: round 1 again, and a round starts if the chat is idle.
//
// Changes come from the active application document only; every change is
// broadcast on `chats:goal-changed`.

import type { GoalLoop } from "../services/goal/goal-loop.js";
import type { GoalSource, GoalView } from "../../renderer/shared/goal.js";

export const GOAL_GET_CHANNEL = "chats:goal:get";
export const GOAL_SET_CHANNEL = "chats:goal:set";
export const GOAL_PAUSE_CHANNEL = "chats:goal:pause";
export const GOAL_RESUME_CHANNEL = "chats:goal:resume";
export const GOAL_CLEAR_CHANNEL = "chats:goal:clear";

/** The sources a desktop window may claim; phone and `/until` goals arrive by other routes. */
const DESKTOP_SOURCES: readonly GoalSource[] = ["slash", "menu", "proposal"];

export interface GoalHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  loop: Pick<GoalLoop, "get" | "set" | "pause" | "resume" | "clear">;
  /** Throws unless the request comes from the active application document. */
  activeDocument(event: unknown): void;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

function chatId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) throw new Error("Invalid chat.");
  return value;
}

export function registerGoalHandlers(dependencies: GoalHandlerDependencies): void {
  const { handle, loop, activeDocument } = dependencies;

  handle(GOAL_GET_CHANNEL, (_event, id): GoalView | null => loop.get(chatId(id)));

  handle(GOAL_SET_CHANNEL, (event, input): Promise<GoalView> => {
    activeDocument(event);
    const value = record(input);
    const id = chatId(value.chatId);
    if (typeof value.objective !== "string") throw new Error("Say what the goal is.");
    const source = value.source as GoalSource;
    if (!DESKTOP_SOURCES.includes(source)) throw new Error("Invalid goal source.");
    return loop.set(id, { objective: value.objective, source });
  });

  handle(GOAL_PAUSE_CHANNEL, (event, input): GoalView | null => {
    activeDocument(event);
    return loop.pause(chatId(record(input).chatId));
  });

  handle(GOAL_RESUME_CHANNEL, (event, input): Promise<GoalView | null> => {
    activeDocument(event);
    return loop.resume(chatId(record(input).chatId));
  });

  handle(GOAL_CLEAR_CHANNEL, (event, input): void => {
    activeDocument(event);
    loop.clear(chatId(record(input).chatId));
  });
}
