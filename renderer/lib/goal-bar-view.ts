// The goal bar's pure view: what it says and offers for a goal, and what it
// shows the moment the person taps. Kept apart from the component so the
// composer's /goal status line can use it without the bar's UI imports.
import { goalRoundLabel, type GoalView } from "../shared/goal";

export type GoalBarAction = "pause" | "resume" | "keep-going" | "continue-here" | "clear";

export type GoalBarTone = "neutral" | "warning" | "green";

export interface GoalBarView {
  title: string;
  detail: string;
  tone: GoalBarTone;
  icon: "working" | "paused" | "needs-you" | "done";
  actions: readonly GoalBarAction[];
  /** The action drawn filled, when one leads. */
  primary?: GoalBarAction;
}

/** What the bar says when a round off screen needed the chat's window. */
export const GOAL_WINDOW_WANTED_DETAIL =
  "Open this chat to let Aiden use the browser or Computer Use";

/** What the bar shows for a goal: its state line, the detail under it, and the actions it offers. */
export function goalBarView(goal: GoalView): GoalBarView {
  // A round off screen needed the window (the browser, Computer Use): Continue
  // here starts the next round from this window, which then has those tools.
  if (
    goal.windowWanted === true &&
    (goal.status === "needs-you" || (goal.status === "paused" && goal.cause !== "person"))
  ) {
    return {
      title: goal.status === "needs-you" ? "Needs you" : "Paused",
      detail: GOAL_WINDOW_WANTED_DETAIL,
      tone: "warning",
      icon: goal.status === "needs-you" ? "needs-you" : "paused",
      actions: ["continue-here", "clear"],
      primary: "continue-here",
    };
  }
  switch (goal.status) {
    case "active":
      return {
        title: `Working · ${goalRoundLabel(goal)}`,
        detail: goal.objective,
        tone: "neutral",
        icon: "working",
        actions: ["pause", "clear"],
      };
    case "paused":
      // The person's own pause resumes; a pause the loop chose (a limit, a
      // stall, a restart) is "Keep going". Both start again from round 1.
      return goal.cause === "person"
        ? {
            title: "Paused",
            detail: goal.objective,
            tone: "neutral",
            icon: "paused",
            actions: ["resume", "clear"],
            primary: "resume",
          }
        : {
            title: "Paused",
            detail: goal.reason ?? goal.objective,
            tone: "warning",
            icon: "paused",
            actions: ["keep-going", "clear"],
            primary: "keep-going",
          };
    case "needs-you":
      return {
        title: "Needs you",
        detail: goal.reason ?? goal.objective,
        tone: "warning",
        icon: "needs-you",
        actions: ["keep-going", "clear"],
        primary: "keep-going",
      };
    case "done":
      return {
        title: "Done",
        detail: goal.reason ?? goal.objective,
        tone: "green",
        icon: "done",
        actions: ["clear"],
      };
  }
}

/** What the bar shows the moment the person taps, before main answers. */
export function optimisticGoal(
  goal: GoalView,
  action: GoalBarAction,
  now: number,
): GoalView | null {
  if (action === "clear") return null;
  if (action === "pause") {
    if (goal.status !== "active") return goal;
    return { ...goal, status: "paused", cause: "person", reason: "Paused", updatedAt: now };
  }
  if (goal.status === "active") return goal;
  const { cause: _cause, reason: _reason, ...rest } = goal;
  return { ...rest, status: "active", rounds: 1, stalls: 0, updatedAt: now };
}
