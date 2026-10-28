// "Needs you" issues from any desktop window.
//
// - `bots:issues:list({ botId, open? })`: this Bot's issues, newest first;
//   `open: true` leaves out the ones already settled.
// - `bots:issues:act({ botId, issueId, action })`: the person pressed one of
//   the card's actions. `{ result: "done" }` when it ran, `{ result: "not_open" }`
//   once the issue settled (or is gone). Throws for a malformed request, an
//   unknown action kind, or an action the issue does not offer.
//
// Both calls are strict: an unrecognized field or action never reaches the
// service.

import {
  BOT_ISSUE_CHANNELS,
  botIssueActionOf,
  type BotIssue,
  type BotIssueAction,
} from "../../renderer/shared/bot-issues.js";
import type { BotIssueActResult, BotIssueService } from "../services/bot-issues/service.js";
import { parseBotId } from "./bot-params.js";

/** Issues and routines use the same path-safe token shape. */
const ISSUE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bot issue fields.");
  const fields = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new Error("Invalid bot issue fields.");
  }
  return fields;
}

function issueId(value: unknown): string {
  if (typeof value !== "string" || !ISSUE_ID.test(value)) throw new Error("Invalid bot issue id.");
  return value;
}

export function parseBotIssueAct(input: unknown): {
  botId: string;
  issueId: string;
  action: BotIssueAction;
} {
  const fields = exact(input, ["botId", "issueId", "action"]);
  const action = botIssueActionOf(fields.action);
  if (action === null) throw new Error("Invalid bot issue action.");
  return { botId: parseBotId(fields.botId), issueId: issueId(fields.issueId), action };
}

export function parseBotIssueList(input: unknown): { botId: string; open?: boolean } {
  const fields = exact(input, ["botId", "open"]);
  if (fields.open !== undefined && typeof fields.open !== "boolean") throw new Error("Invalid bot issue filter.");
  return { botId: parseBotId(fields.botId), ...(fields.open === undefined ? {} : { open: fields.open }) };
}

export interface BotIssueHandlerDependencies<Event = unknown> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  issues: Pick<BotIssueService, "act" | "list">;
}

export function registerBotIssueHandlers<Event = unknown>(
  dependencies: BotIssueHandlerDependencies<Event>,
): void {
  dependencies.handle(BOT_ISSUE_CHANNELS.act, async (_event, input): Promise<{ result: "done" | "not_open" }> => {
    const { botId, issueId, action } = parseBotIssueAct(input);
    const result: BotIssueActResult = await dependencies.issues.act(botId, issueId, action);
    // A stale card (another window answered first) is not an error; an action
    // this issue never offered is.
    if (result === "invalid") throw new Error("That action doesn’t fit this issue.");
    return { result };
  });

  dependencies.handle(BOT_ISSUE_CHANNELS.list, async (_event, input): Promise<BotIssue[]> => {
    const { botId, open } = parseBotIssueList(input);
    return dependencies.issues.list(botId, open === undefined ? undefined : { open });
  });
}
