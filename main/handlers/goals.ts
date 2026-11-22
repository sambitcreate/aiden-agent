// A chat's keep-going goal, from the desktop's goal bar and `/goal`.
//
// - `chats:goal:get(chatId)`: the goal's view, or null.
// - `chats:goal:set({chatId, objective, source})`: sets the goal, replacing any
//   earlier one. The renderer then sends the objective as the person's message;
//   the kickoff note rides on that turn. Throws the loop's refusal (a Bot's or
//   an owned chat, no model, the switch off, an objective over the limit).
//   With `source: "until"` it takes `check` (the `/until` command) instead of
//   an objective: the goal is done when that command exits 0, and its first
//   check runs at once in an idle chat.
// - `chats:goal:pause|resume|clear({chatId})`: the person's actions. Resume is
//   also Keep going: round 1 again, and a round starts if the chat is idle.
//
// Rounds in a window (a focused window that shows the chat starts the round
// as its own run, with the browser and Computer Use):
// - `chats:goal:view({chatId, focused})`: the window's pane shows this chat
//   (or none, `chatId: null`) and whether the window has focus.
// - main sends that document `chats:goal-window-round {chatId, token}` when a
//   round is due; it answers with
//   `chats:goal:startWindowRound({token, streamId})`, which starts the round on
//   the stream it subscribed to, or `chats:goal:declineWindowRound({token})`.
//
// The agent's suggestions (`propose_goal`):
// - `chats:goal:proposal(chatId)`: the suggested goal waiting for the person, or null.
// - `chats:goal:dismissProposal({chatId})`: Not now. Setting a goal (Start
//   sends the objective with `source: "proposal"`) dismisses it too.
// Changes broadcast on `chats:goal-proposal-changed`.
//
// Changes come from the active application document only; every change is
// broadcast on `chats:goal-changed`.

import type { GoalLoop } from "../services/goal/goal-loop.js";
import type { GoalProposalView, GoalSource, GoalView } from "../../renderer/shared/goal.js";
import type { GoalProposals } from "../services/goal/goal-proposals.js";
import type { StartTurnResult } from "../services/follow-through/notice-delivery.js";
import type { GoalWindowView } from "../services/goal/goal-window-rounds.js";
import { isSafeSubagentIdentifier } from "../../renderer/shared/subagent-runs.js";
import { untilGoalObjective } from "../services/follow-through/done-when.js";

export const GOAL_GET_CHANNEL = "chats:goal:get";
export const GOAL_SET_CHANNEL = "chats:goal:set";
export const GOAL_PAUSE_CHANNEL = "chats:goal:pause";
export const GOAL_RESUME_CHANNEL = "chats:goal:resume";
export const GOAL_CLEAR_CHANNEL = "chats:goal:clear";
export const GOAL_VIEW_CHANNEL = "chats:goal:view";
export const GOAL_START_WINDOW_ROUND_CHANNEL = "chats:goal:startWindowRound";
export const GOAL_DECLINE_WINDOW_ROUND_CHANNEL = "chats:goal:declineWindowRound";
export const GOAL_PROPOSAL_CHANNEL = "chats:goal:proposal";
export const GOAL_DISMISS_PROPOSAL_CHANNEL = "chats:goal:dismissProposal";

/** The sources a desktop window may claim; phone goals arrive by another route. */
const DESKTOP_SOURCES: readonly GoalSource[] = ["slash", "menu", "proposal", "until"];

export interface GoalHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  loop: Pick<GoalLoop, "get" | "set" | "pause" | "resume" | "clear">;
  /** Throws unless the request comes from the active application document. */
  activeDocument(event: unknown): void;
  /** The agent's suggested goals; without it, proposals aren't served. */
  proposals?: Pick<GoalProposals, "get" | "dismiss">;
  /** Rounds in a window; each throws for a request from an inactive document. */
  windowRounds?: {
    report(event: unknown, view: GoalWindowView): void;
    start(event: unknown, token: string, streamId: string): Promise<StartTurnResult>;
    decline(event: unknown, token: string): void;
  };
}

/** What `chats:goal:startWindowRound` answers: the shape of `chat:start`'s, so the window's stream handling is the same. */
export interface GoalWindowRoundStartResult {
  streamId: string;
  accepted: boolean;
  started: boolean;
  error?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

function chatId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) throw new Error("Invalid chat.");
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 100) throw new Error("Invalid round.");
  return value;
}

export function registerGoalHandlers(dependencies: GoalHandlerDependencies): void {
  const { handle, loop, activeDocument, windowRounds, proposals } = dependencies;

  handle(GOAL_GET_CHANNEL, (_event, id): GoalView | null => loop.get(chatId(id)));

  handle(GOAL_SET_CHANNEL, async (event, input): Promise<GoalView> => {
    activeDocument(event);
    const value = record(input);
    const id = chatId(value.chatId);
    const view = await setGoal(id, value);
    // A goal is set: a suggestion waiting in the chat is answered.
    proposals?.dismiss(id);
    return view;
  });

  const setGoal = (id: string, value: Record<string, unknown>): Promise<GoalView> => {
    const source = value.source as GoalSource;
    if (!DESKTOP_SOURCES.includes(source)) throw new Error("Invalid goal source.");
    if (source === "until") {
      const command = typeof value.check === "string" ? value.check.trim() : "";
      if (!command) throw new Error("Name the check to run, for example /until npm test.");
      return loop.set(id, { objective: untilGoalObjective(command), source, check: command });
    }
    if (typeof value.objective !== "string") throw new Error("Say what the goal is.");
    return loop.set(id, { objective: value.objective, source });
  };

  if (proposals) {
    handle(GOAL_PROPOSAL_CHANNEL, (_event, id): GoalProposalView | null => proposals.get(chatId(id)));
    handle(GOAL_DISMISS_PROPOSAL_CHANNEL, (event, input): void => {
      activeDocument(event);
      proposals.dismiss(chatId(record(input).chatId));
    });
  }

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

  if (!windowRounds) return;

  handle(GOAL_VIEW_CHANNEL, (event, input): void => {
    const value = record(input);
    if (typeof value.focused !== "boolean") throw new Error("Invalid view.");
    windowRounds.report(event, { chatId: value.chatId === null ? null : chatId(value.chatId), focused: value.focused });
  });

  handle(GOAL_START_WINDOW_ROUND_CHANNEL, async (event, input): Promise<GoalWindowRoundStartResult> => {
    const value = record(input);
    const round = token(value.token);
    if (!isSafeSubagentIdentifier(value.streamId)) throw new Error("Invalid chat stream identifier.");
    const streamId = value.streamId;
    const result = await windowRounds.start(event, round, streamId);
    if (result.kind === "started") return { streamId, accepted: true, started: true };
    // Accepted with an error, so the window's stream ends the way a failed start's does.
    return { streamId, accepted: true, started: false, error: result.kind === "busy" ? "The chat is busy, so this keep-going round didn't start." : result.reason };
  });

  handle(GOAL_DECLINE_WINDOW_ROUND_CHANNEL, (event, input): void => {
    windowRounds.decline(event, token(record(input).token));
  });
}
