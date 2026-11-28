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
import { type GoalProposalView, type GoalView } from "../shared/goal";
import {
  goalBarView,
  optimisticGoal,
  type GoalBarAction,
  type GoalBarTone,
} from "../lib/goal-bar-view";

export {
  GOAL_WINDOW_WANTED_DETAIL,
  goalBarView,
  optimisticGoal,
  type GoalBarAction,
  type GoalBarView,
} from "../lib/goal-bar-view";

const TONE_CLASS: Record<GoalBarTone, string> = {
  neutral: "bg-control text-secondary",
  warning: "bg-status-warning-surface text-status-warning",
  green: "bg-status-green-surface text-status-green",
};

const ACTION_LABEL: Record<GoalBarAction, string> = {
  pause: "Pause",
  resume: "Resume",
  "keep-going": "Keep going",
  "continue-here": "Continue here",
  clear: "Clear",
};

const ICONS = {
  working: Repeat,
  paused: Pause,
  "needs-you": CircleAlert,
  done: CircleCheck,
} as const;

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
        <span
          aria-hidden="true"
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-full [&_svg]:size-3.5",
            TONE_CLASS[view.tone],
          )}
        >
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
              // One change at a time: a Clear can't race the Pause still on its way.
              disabled={pending !== undefined}
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
        className="flex min-w-0 items-start gap-2.5 rounded-card bg-well px-3 py-2"
      >
        <span
          aria-hidden="true"
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-full [&_svg]:size-3.5",
            TONE_CLASS.neutral,
          )}
        >
          <Repeat />
        </span>
        {/* Every character Start would send is shown: the objective wraps, never clips. */}
        <div className="min-w-0 flex-1">
          <Text as="p" variant="small-strong">
            Keep going until:
          </Text>
          <Text
            as="p"
            variant="small"
            color="secondary"
            className="whitespace-normal break-words"
            data-goal-proposal-objective=""
          >
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
  const pendingRef = React.useRef(false);
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
        toast.error(
          error instanceof Error ? error.message : "The suggestion could not be answered.",
        );
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
    if (pendingRef.current) return;
    pendingRef.current = true;
    const key = queryKeys.chatGoal(chatId);
    const before = queryClient.getQueryData<GoalView | null>(key) ?? goal;
    queryClient.setQueryData(key, optimisticGoal(before, action, Date.now()));
    setPending(action);
    try {
      if (action === "clear") await chatsApi.clearGoal(chatId);
      else
        queryClient.setQueryData(
          key,
          action === "pause" ? await chatsApi.pauseGoal(chatId) : await chatsApi.resumeGoal(chatId),
        );
    } catch (error) {
      queryClient.setQueryData(key, before);
      toast.error(error instanceof Error ? error.message : "The goal could not be changed.");
    } finally {
      pendingRef.current = false;
      setPending(undefined);
    }
  };

  return (
    <GoalBar
      goal={goal}
      pending={pending}
      onAction={(action) => void act(action)}
      className={className}
    />
  );
}
