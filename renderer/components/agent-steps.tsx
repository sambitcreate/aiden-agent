import * as React from "react";
import { Ban, Check, ChevronRight, CircleAlert, CircleDot, LoaderCircle } from "lucide-react";
import { Text } from "./ui";
import {
  activityTrailNeedsAttention,
  activityTrailSummary,
  agentStepLabel,
  contextGroupLabel,
  groupAgentSteps,
  isActiveStep,
} from "../lib/agent-steps";
import type { AgentToolStep, GenerationTimeline } from "../shared/generation-timeline";

const EXIT_MS = 180;

function StepIcon({ step }: { step: AgentToolStep }) {
  const className =
    step.status === "failed"
      ? "text-red"
      : step.status === "blocked" || step.status === "awaiting_approval"
        ? "text-support-warning"
        : step.status === "completed"
          ? "text-secondary"
          : "text-tertiary";
  const Icon =
    step.status === "failed"
      ? CircleAlert
      : step.status === "blocked"
        ? Ban
        : step.status === "completed"
          ? Check
          : step.status === "cancelled"
            ? CircleDot
            : LoaderCircle;
  return (
    <span
      className="agent-step-icon grid size-4 shrink-0 place-items-center"
      data-status={step.status}
    >
      <Icon className={`size-3.5 ${className}`} aria-hidden="true" />
    </span>
  );
}

function CrossfadeLabel({
  value,
  active,
  alert,
}: {
  value: string;
  active: boolean;
  alert?: boolean;
}) {
  const currentRef = React.useRef(value);
  const [previous, setPrevious] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (currentRef.current === value) return;
    const old = currentRef.current;
    currentRef.current = value;
    setPrevious(old);
    const timer = window.setTimeout(() => setPrevious(null), 180);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <span className="agent-step-label-grid min-w-0">
      {previous ? (
        <span className="agent-step-label-out min-w-0 break-words" aria-hidden="true">
          {previous}
        </span>
      ) : null}
      <span
        key={value}
        className={`agent-step-label-in min-w-0 break-words ${
          active ? "agent-thinking-shimmer" : alert ? "text-red" : ""
        }`}
      >
        {value}
      </span>
    </span>
  );
}

function ToolStepRow({ step }: { step: AgentToolStep }) {
  const active = isActiveStep(step);
  return (
    <div
      className="agent-step-row flex min-w-0 items-center gap-2 py-0.5"
      data-step-id={step.id}
      data-status={step.status}
      role={step.status === "failed" ? "alert" : "listitem"}
    >
      <StepIcon step={step} />
      <Text variant="small" color="secondary" className="min-w-0">
        <CrossfadeLabel
          value={agentStepLabel(step)}
          active={active}
          alert={step.status === "failed"}
        />
      </Text>
    </div>
  );
}

function ContextGroup({ steps }: { steps: AgentToolStep[] }) {
  const active = steps.some(isActiveStep);
  return (
    <details className="agent-step-row group/context" open={active || undefined} role="listitem">
      <summary className="flex min-w-0 list-none items-center gap-2 py-0.5">
        <span
          className="agent-step-icon grid size-4 shrink-0 place-items-center"
          data-status={active ? "running" : "completed"}
        >
          {active ? (
            <LoaderCircle className="size-3.5 text-tertiary" aria-hidden="true" />
          ) : (
            <Check className="size-3.5 text-secondary" aria-hidden="true" />
          )}
        </span>
        <Text variant="small" color="secondary" className="min-w-0 flex-1">
          <CrossfadeLabel value={contextGroupLabel(steps)} active={active} />
        </Text>
        <ChevronRight
          className="size-3.5 shrink-0 text-tertiary transition-transform group-open/context:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="ml-6 mt-1 flex flex-col gap-0.5" role="list">
        {steps.map((step) => (
          <ToolStepRow key={step.id} step={step} />
        ))}
      </div>
    </details>
  );
}

export function AgentSteps({
  timeline,
  animate = true,
}: {
  timeline: GenerationTimeline | null;
  animate?: boolean;
}) {
  const [visible, setVisible] = React.useState(timeline);
  const [exiting, setExiting] = React.useState(false);
  const [open, setOpen] = React.useState(() =>
    timeline ? activityTrailNeedsAttention(timeline) : false,
  );
  const autoOpenKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (timeline) {
      setVisible(timeline);
      setExiting(false);
      const attention = activityTrailNeedsAttention(timeline);
      const attentionKind = timeline.claimCheck
        ? "claim"
        : timeline.status === "running"
          ? "running"
          : attention
            ? "issue"
            : "quiet";
      const autoOpenKey = `${timeline.generationId}:${attentionKind}`;
      if (attention && autoOpenKeyRef.current !== autoOpenKey) {
        autoOpenKeyRef.current = autoOpenKey;
        setOpen(true);
      }
      return;
    }
    if (!visible) return;
    if (document.documentElement.dataset.reduceMotion === "true") {
      setVisible(null);
      setExiting(false);
      return;
    }
    setExiting(true);
    const timer = window.setTimeout(() => {
      setVisible(null);
      setExiting(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [timeline, visible]);

  if (!visible?.steps.length) return null;
  const groups = groupAgentSteps(visible.steps);
  return (
    <details
      className="agent-steps group/activity overflow-hidden rounded-control border border-separator bg-well/40"
      data-presence={exiting ? "exiting" : "visible"}
      data-animate={animate ? "true" : "false"}
      data-state={open ? "open" : "closed"}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-w-0 list-none items-center gap-2 px-3 py-2 outline-none transition-colors hover:bg-list-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring">
        <CircleDot className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
        <Text variant="small-strong" color="secondary" className="min-w-0 flex-1">
          Activity
        </Text>
        <Text
          variant="small"
          className={visible.claimCheck ? "text-support-warning" : "text-tertiary"}
        >
          {activityTrailSummary(visible)}
        </Text>
        <ChevronRight
          className="agent-activity-chevron size-3.5 shrink-0 text-tertiary transition-transform group-open/activity:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="flex flex-col gap-1 border-t border-separator px-3 py-2">
        <div className="flex flex-col gap-1" role="list">
          {groups.map((group) =>
            group.kind === "context" ? (
              <ContextGroup key={group.id} steps={group.steps} />
            ) : (
              <ToolStepRow key={group.id} step={group.steps[0]} />
            ),
          )}
        </div>
        {visible.claimCheck ? (
          <div
            className="mt-1 flex items-start gap-2 rounded-control bg-support-warning/[0.08] px-2.5 py-2"
            role={animate ? "alert" : "note"}
          >
            <CircleAlert
              className="mt-0.5 size-3.5 shrink-0 text-support-warning"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <Text as="span" variant="small-strong" className="block text-support-warning">
                Success not verified
              </Text>
              <Text as="span" variant="small" color="secondary" className="mt-0.5 block">
                A required action or check did not complete. Review the issues above before relying
                on this response.
              </Text>
            </span>
          </div>
        ) : null}
      </div>
    </details>
  );
}
