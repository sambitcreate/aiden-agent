import * as React from "react";
import { Ban, Check, ChevronRight, CircleAlert, CircleDot, LoaderCircle } from "lucide-react";
import { Text } from "./ui";
import {
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

  React.useEffect(() => {
    if (timeline) {
      setVisible(timeline);
      setExiting(false);
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
    <div
      className="agent-steps flex flex-col gap-1"
      data-presence={exiting ? "exiting" : "visible"}
      data-animate={animate ? "true" : "false"}
      role="list"
      aria-label="Agent steps"
    >
      {groups.map((group) =>
        group.kind === "context" ? (
          <ContextGroup key={group.id} steps={group.steps} />
        ) : (
          <ToolStepRow key={group.id} step={group.steps[0]} />
        ),
      )}
    </div>
  );
}
