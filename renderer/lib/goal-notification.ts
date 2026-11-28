// The one desktop notification a keep-going goal gives: when it settles on its
// own (Done, Needs you, or paused by the loop), and only if no focused window
// shows that chat. The person's own Pause or Clear says nothing.

import type { GoalView } from "../shared/goal";

const BODY_MAX_CHARS = 120;

export interface GoalNotification {
  title: string;
  body: string;
}

/** What to say when a chat's goal changes from `previous` to `next`, or undefined for nothing. */
export function goalSettleNotification(
  previous: GoalView | null | undefined,
  next: GoalView | null,
): GoalNotification | undefined {
  if (
    !next ||
    !previous ||
    previous.id !== next.id ||
    previous.status !== "active" ||
    next.status === "active"
  )
    return undefined;
  if (next.status === "paused" && next.cause === "person") return undefined;
  const title =
    next.status === "done"
      ? "Goal done"
      : next.status === "needs-you"
        ? "Goal needs you"
        : "Goal paused";
  const detail = (
    next.reason && next.reason !== "Done" && next.reason !== "Needs you"
      ? next.reason
      : next.objective
  )
    .replace(/\s+/gu, " ")
    .trim();
  const body =
    [...detail].length > BODY_MAX_CHARS
      ? `${[...detail].slice(0, BODY_MAX_CHARS - 1).join("")}…`
      : detail;
  return { title, body };
}

/** Whether this window, focused, shows the chat right now. */
export function windowShowsChat(
  input: { focused: boolean; pathname: string },
  chatId: string,
): boolean {
  return input.focused && input.pathname === `/chat/${encodeURIComponent(chatId)}`;
}
