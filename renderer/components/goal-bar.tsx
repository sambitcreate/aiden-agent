// A chat's keep-going goal, above its composer beside the spending-limit
// notice: what the goal is, where it stands ("Working · round 3 of 50",
// "Paused", "Needs you", "Done") and the person's actions. Status lives in the
// icon's soft fill, never in a border; actions are the shared squircle Button.
//
// Taps are instant: the bar shows the new state at once and puts the old one
// back with a toast if main refuses (the design guide's instant rule).

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Pause, Repeat } from "lucide-react";
import { Button, Text, toast } from "./ui";
import { chatsApi } from "../lib/ipc";
import { queryKeys, useChatGoal, useChatGoalProposal } from "../lib/queries";
import { cn } from "../lib/ui-utils";
import { goalRoundLabel, type GoalProposalView, type GoalView } from "../shared/goal";

export type GoalBarAction = "pause" | "resume" | "keep-going" | "continue-here" | "clear";

type Tone = "neutral" | "warning" | "green";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-control text-secondary",
  warning: "bg-status-warning-surface text-status-warning",
  green: "bg-status-green-surface text-status-green",
};

export interface GoalBarView {
  title: string;
  detail: string;
  tone: Tone;
  icon: "working" | "paused" | "needs-you" | "done";
  actions: readonly GoalBarAction[];
  /** The action drawn filled, when one leads. */
  primary?: GoalBarAction;
}

const ACTION_LABEL: Record<GoalBarAction, string> = {
  pause: "Pause",
  resume: "Resume",
  "keep-going": "Keep going",
  "continue-here": "Continue here",
  clear: "Clear",
};

/** What the bar says when a round off screen needed the chat's window. */
export const GOAL_WINDOW_WANTED_DETAIL = "Open this chat to let Aiden use the browser or Computer Use";

/** What the bar shows for a goal: its state line, the detail under it, and the actions it offers. */
export function goalBarView(goal: GoalView): GoalBarView {
  // A round off screen needed the window (the browser, Computer Use): Continue
  // here starts the next round from this window, which then has those tools.
  if (goal.windowWanted === true && (goal.status === "needs-you" || (goal.status === "paused" && goal.cause !== "person"))) {
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
      return { title: `Working · ${goalRoundLabel(goal)}`, detail: goal.objective, tone: "neutral", icon: "working", actions: ["pause", "clear"] };
    case "paused":
      // The person's own pause resumes; a pause the loop chose (a limit, a
      // stall, a restart) is "Keep going". Both start again from round 1.
      return goal.cause === "person"
        ? { title: "Paused", detail: goal.objective, tone: "neutral", icon: "paused", actions: ["resume", "clear"], primary: "resume" }
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
      return { title: "Done", detail: goal.reason ?? goal.objective, tone: "green", icon: "done", actions: ["clear"] };
  }
}

const ICONS = { working: Repeat, paused: Pause, "needs-you": CircleAlert, done: CircleCheck } as const;

export function GoalBar({
  goal,
  pending,
  onAction,
  className,
}: {
  goal: GoalView;
  /** An action on its way to main; its button waits out a second tap. */
  pending?: GoalBarAction;
  onAction(action: GoalBarAction): void;
  className?: string;
}) {
  const view = goalBarView(goal);
  const Icon = ICONS[view.icon];
  return (
    <div className={className}>
      <section
        role="group"
        aria-label={`Goal: ${goal.objective}`}
        data-goal-status={goal.status}
        className="flex min-w-0 items-center gap-2.5 rounded-card bg-well px-3 py-2"
      >
        <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-full [&_svg]:size-3.5", TONE_CLASS[view.tone])}>
          <Icon />
        </span>
        <div className="min-w-0 flex-1" aria-live="polite">
          <Text as="p" variant="small-strong" className="truncate">
            {view.title}
          </Text>
          <Text as="p" variant="small" color="secondary" className="truncate" title={view.detail}>
            {view.detail}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {view.actions.map((action) => (
            <Button
              key={action}
              variant={action === view.primary ? "filled" : "transparent"}
              size="small"
              disabled={pending === action}
              onClick={() => onAction(action)}
            >
              {ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}

/** What the bar shows the moment the person taps, before main answers. */
export function optimisticGoal(goal: GoalView, action: GoalBarAction, now: number): GoalView | null {
  if (action === "clear") return null;
  if (action === "pause") {
    if (goal.status !== "active") return goal;
    return { ...goal, status: "paused", cause: "person", reason: "Paused", updatedAt: now };
  }
  if (goal.status === "active") return goal;
  const { cause: _cause, reason: _reason, ...rest } = goal;
  return { ...rest, status: "active", rounds: 1, stalls: 0, updatedAt: now };
}

/**
 * A goal the agent suggested (`propose_goal`): "Keep going until: …" with
 * Start and Not now. Nothing starts until the person presses Start.
 */
export function GoalProposalCard({
  proposal,
  pending,
  onStart,
  onDismiss,
  className,
}: {
  proposal: GoalProposalView;
  /** A tap on its way; both buttons wait it out. */
  pending?: boolean;
  onStart(): void;
  onDismiss(): void;
  className?: string;
}) {
  return (
    <div className={className}>
      <section
        role="group"
        aria-label={`Suggested goal: ${proposal.objective}`}
        data-goal-proposal=""
        className="flex min-w-0 items-center gap-2.5 rounded-card bg-well px-3 py-2"
      >
        <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-full [&_svg]:size-3.5", TONE_CLASS.neutral)}>
          <Repeat />
        </span>
        <div className="min-w-0 flex-1">
          <Text as="p" variant="small-strong" className="truncate">
            Keep going until:
          </Text>
          <Text as="p" variant="small" color="secondary" className="truncate" title={proposal.objective}>
            {proposal.objective}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="filled" size="small" disabled={pending} onClick={onStart}>
            Start
          </Button>
          <Button variant="transparent" size="small" disabled={pending} onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </section>
    </div>
  );
}

/**
 * The bar for one chat, read from the cache and kept current by
 * `chats:goal-changed`; with no goal at work, the agent's suggestion instead.
 * `onStartProposal` sends the objective as the person's message with the goal,
 * as `/goal` does.
 */
export function ChatGoalBar({
  chatId,
  className,
  onStartProposal,
}: {
  chatId: string;
  className?: string;
  onStartProposal?(objective: string): Promise<void>;
}) {
  const queryClient = useQueryClient();
  const { data: goal } = useChatGoal(chatId);
  const { data: proposal } = useChatGoalProposal(chatId, Boolean(onStartProposal));
  const [pending, setPending] = React.useState<GoalBarAction>();
  const [proposalPending, setProposalPending] = React.useState(false);

  if (proposal && onStartProposal && goal?.status !== "active") {
    const answer = async (start: boolean) => {
      const key = queryKeys.chatGoalProposal(chatId);
      queryClient.setQueryData(key, null);
      setProposalPending(true);
      try {
        if (start) await onStartProposal(proposal.objective);
        else await chatsApi.dismissGoalProposal(chatId);
      } catch (error) {
        queryClient.setQueryData(key, proposal);
        toast.error(error instanceof Error ? error.message : "The suggestion could not be answered.");
      } finally {
        setProposalPending(false);
      }
    };
    return (
      <GoalProposalCard
        proposal={proposal}
        pending={proposalPending}
        onStart={() => void answer(true)}
        onDismiss={() => void answer(false)}
        className={className}
      />
    );
  }
  if (!goal) return null;

  const act = async (action: GoalBarAction) => {
    const key = queryKeys.chatGoal(chatId);
    const before = queryClient.getQueryData<GoalView | null>(key) ?? goal;
    queryClient.setQueryData(key, optimisticGoal(before, action, Date.now()));
    setPending(action);
    try {
      if (action === "clear") await chatsApi.clearGoal(chatId);
      else queryClient.setQueryData(key, action === "pause" ? await chatsApi.pauseGoal(chatId) : await chatsApi.resumeGoal(chatId));
    } catch (error) {
      queryClient.setQueryData(key, before);
      toast.error(error instanceof Error ? error.message : "The goal could not be changed.");
    } finally {
      setPending(undefined);
    }
  };

  return <GoalBar goal={goal} pending={pending} onAction={(action) => void act(action)} className={className} />;
}
