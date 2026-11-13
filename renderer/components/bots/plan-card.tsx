import * as React from "react";
import { Check, Circle, Minus } from "lucide-react";
import { BotAvatar } from "../bot-avatar";
import { Button, Text } from "../ui";
import { BotNoticeCard } from "./bot-notice-card";
import { AskCard, ApprovalActions } from "../approval-card-parts";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { botPlanProgress, type BotPlanDecision, type BotPlanView } from "../../shared/bot-plans";
import type { BotAvatar as BotAvatarValue } from "../../shared/bots";

type PlanCardProps = {
  plan: BotPlanView;
  botName: string;
  avatar: BotAvatarValue;
  onRespond(decision: BotPlanDecision): Promise<void>;
};

export function PlanCard(props: PlanCardProps) {
  // Replacing the host-owned plan starts a new interaction. A late answer from
  // the old card cannot clear a new card's busy state, disclosure or error.
  return <PlanCardBody key={`${props.plan.botId}:${props.plan.planId}`} {...props} />;
}

function PlanCardBody({ plan, botName, avatar, onRespond }: PlanCardProps) {
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const detailsId = React.useId();
  const [, tick] = React.useReducer((value: number) => value + 1, 0);
  const active = plan.status === "active";
  const minutes = plan.expiresAt === undefined ? undefined : Math.max(0, Math.ceil((plan.expiresAt - Date.now()) / 60_000));

  // Display-only local clock. The host owns expiry/settlement; no polling or
  // authority is inferred when the count reaches zero.
  React.useEffect(() => {
    if (!active || plan.expiresAt === undefined || !minutes) return;
    const remaining = plan.expiresAt - Date.now();
    const timer = setTimeout(tick, Math.max(1, remaining - (minutes - 1) * 60_000));
    return () => clearTimeout(timer);
  }, [active, plan.expiresAt, minutes]);

  const respond = async (decision: BotPlanDecision) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onRespond(decision);
    } catch (cause) {
      setError(userFacingErrorMessage(cause, "Aiden couldn’t send that plan answer."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (plan.status !== "pending" && !active) {
    const { done, total } = botPlanProgress(plan);
    return <Text as="p" variant="small" color="tertiary">{`Plan ended · ${done} of ${total} steps`}</Text>;
  }

  const eyebrow = active
    ? minutes === undefined ? "Approved" : `Approved · ends in ${minutes} min`
    : plan.from ? `${plan.from} asked ${botName} to do this` : `${botName} has a plan`;
  const review = (
    <div role="region" aria-label="Plan review" tabIndex={0} onKeyDown={jumpToReviewEdge} className={active ? "max-h-[min(40vh,24rem)] overflow-y-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring" : "approval-well mt-3 max-h-[min(40vh,24rem)] overflow-y-auto overscroll-contain bg-well px-4 py-3 text-small focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"}>
      <p className="whitespace-pre-line">{plan.why}</p>
      {active ? (
        <ul aria-label="Plan steps" className="mt-2 space-y-1">
          {plan.steps.map((step, index) => {
            const Icon = step.status === "done" ? Check : step.status === "skipped" ? Minus : Circle;
            const label = step.status === "done" ? "Done" : step.status === "skipped" ? "Skipped" : "Pending";
            return (
              <li key={index} className="flex min-w-0 items-start gap-2">
                <span role="img" aria-label={label} className={step.status === "done" ? "shrink-0 rounded-full bg-status-green-surface p-0.5 text-status-green" : "shrink-0 p-0.5 text-tertiary"}>
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <span className="min-w-0">{step.text}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ol aria-label="Plan steps" className="mt-2 list-decimal space-y-1 pl-5">
          {plan.steps.map((step, index) => <li key={index}>{step.text}</li>)}
        </ol>
      )}
      {/* One row per action the plan covers. */}
      <ul aria-label="Plan coverage" className={active ? "mt-2 space-y-1" : "mt-2 divide-y divide-separator"}>
        {plan.items.map((item) => (
          <li key={item.id} className={active ? undefined : "py-1.5"}>
            <span>{item.line}</span>
            {active && item.used !== undefined && item.max !== undefined ? <span className="ml-1.5 text-tertiary">{`${item.used} of ${item.max} used`}</span> : null}
          </li>
        ))}
      </ul>
      {expanded ? (
        <div id={detailsId} role="region" aria-label="Plan details" className={active ? "mt-2 rounded-card bg-well p-2" : "mt-2 text-tertiary"}>
          <ul className="space-y-1">
            {plan.items.flatMap((item) => item.details.map((detail, index) => <li key={`${item.id}:${index}`}>{detail}</li>))}
          </ul>
        </div>
      ) : null}
    </div>
  );
  const detailsToggle = (
    <Button size="small" variant="transparent" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>
      {expanded ? "Hide details" : "Show details"}
    </Button>
  );

  if (!active) {
    // The batch card (§3.3): one question for every action the plan covers.
    // Deny is `not_now` and Allow once `approve`, as before. An Always that
    // saves one rule per action has no store yet, so the menu is not offered.
    return (
      <AskCard
        label={eyebrow}
        tile={<BotAvatar botId={plan.botId} photoLoading="immediate" avatar={avatar} name={botName} size="large" />}
        eyebrow={eyebrow}
        title="Approve this plan?"
        error={error}
        actions={<ApprovalActions onDeny={() => void respond("not_now")} allowLabel="Allow once" onAllow={() => void respond("approve")} disabled={busy} />}
      >
        <Text as="p" variant="small-strong" className="mt-1 text-center">{plan.title}</Text>
        {review}
        <div className="mt-1 flex justify-center">{detailsToggle}</div>
      </AskCard>
    );
  }

  return (
    <BotNoticeCard
      label={`${botName}’s approved plan`}
      elevated
      className="[overflow-wrap:anywhere]"
      iconTile={<BotAvatar botId={plan.botId} photoLoading="immediate" avatar={avatar} name={botName} size="small" />}
      title={
        <>
          <Text as="span" variant="small" color="tertiary" className="block">{eyebrow}</Text>
          <span className="block text-strong">{plan.title}</span>
        </>
      }
      actions={
        <>
          <Button size="small" variant="filled" disabled={busy} onClick={() => void respond("stop")}>Stop plan</Button>
          {detailsToggle}
        </>
      }
    >
      {review}
      {error ? <p role="alert" className="mt-2 text-status-red">{error}</p> : null}
    </BotNoticeCard>
  );
}

/**
 * Home and End jump the plan review to its top or bottom in one step. Chromium's
 * own keyboard scroll animates, and a Home sent while an End animation was still
 * settling was sometimes lost, leaving the review at the bottom.
 */
function jumpToReviewEdge(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const review = event.currentTarget;
  review.scrollTop = event.key === "Home" ? 0 : review.scrollHeight;
}
