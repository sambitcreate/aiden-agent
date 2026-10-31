// Contract revision 42 (`bot:issues`): what each kind of device is sent about
// a Bot's host-owned "Needs you" cards. Pure.
//
// A card is the desktop's own `aiden.bot-issue` entry: the host raises it,
// settles it, and offers at most two actions. Phones receive the cards as a
// session field (not as transcript entries), and only a device that negotiated
// `bot:issues` receives them, because the shipped phones decode a closed set of
// session keys. `open_settings` is the Mac's own surface, so it is never sent
// as an action: a card that offered only that arrives without actions and the
// phone reads it as "Open on your Mac".

import type { BotIssue } from "../../renderer/shared/bot-issues.js";
import {
  AIDEN_REMOTE_BOT_ISSUE_MAX,
  parseAidenRemoteBotIssue,
  type AidenRemoteBotIssue,
} from "./aiden-remote-protocol.js";

/** One stored issue as the wire carries it, or null when it is not the current shape. */
export function toRemoteBotIssue(issue: BotIssue): AidenRemoteBotIssue | null {
  const resolved = issue.resolvedAt !== undefined;
  try {
    return parseAidenRemoteBotIssue({
      id: issue.id,
      kind: issue.kind,
      title: issue.title,
      body: issue.body,
      ...(issue.routineId === undefined ? {} : { routineId: issue.routineId }),
      // Settings live on the Mac: the phone may not open them, so the action
      // is left out and the card still shows its title and body. A settled
      // card offers nothing at all, as the store keeps its old actions.
      actions: resolved ? [] : issue.actions.filter((action) => action.kind !== "open_settings"),
      createdAt: new Date(issue.createdAt).toISOString(),
      resolved,
    });
  } catch {
    // A row the wire cannot carry stays on the Mac; it must never fail the
    // session that every other card reaches.
    return null;
  }
}

/**
 * The Bot's cards as a phone reads them, oldest first (a chat appends the
 * newest), at most `AIDEN_REMOTE_BOT_ISSUE_MAX`. The store holds them newest
 * first.
 */
export function toRemoteBotIssues(issues: readonly BotIssue[]): AidenRemoteBotIssue[] {
  return issues
    .slice(0, AIDEN_REMOTE_BOT_ISSUE_MAX)
    .reverse()
    .map(toRemoteBotIssue)
    .filter((issue): issue is AidenRemoteBotIssue => issue !== null);
}

/**
 * A Bot summary with `issueCount` only for a device holding `bot:issues`.
 * Settled cards do not count: the number is the person's open decisions.
 */
export function projectBotSummaryIssuesForAudience<Summary extends { issueCount?: number }>(
  summary: Summary,
  audience: { issues: boolean },
): Summary {
  if (audience.issues || summary.issueCount === undefined) return summary;
  const { issueCount: _hidden, ...rest } = summary;
  return rest as Summary;
}
