import type * as React from "react";
import {
  Bell,
  BellOff,
  CirclePause,
  Clock,
  Cpu,
  Earth,
  FolderOpen,
  Folder,
  Plug,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { Badge, Text } from "./ui";
import { cn } from "../lib/ui-utils";
import type { AssistantAutomationApprovalDetails, ScheduledTaskApprovalDetails } from "../shared/assistant";
import { formatScheduledTaskCadence, scheduledTaskEnabledAfterApproval } from "../shared/scheduled-task-presentation";

export type ScheduleApprovalDetails = ScheduledTaskApprovalDetails | AssistantAutomationApprovalDetails;

const HEADLINES: Record<ScheduledTaskApprovalDetails["action"], string> = {
  create: "Save this scheduled task?",
  update: "Update this scheduled task?",
  pause: "Pause this scheduled task?",
  resume: "Resume this scheduled task?",
  remove: "Delete this scheduled task?",
  run_now: "Run this scheduled task now?",
};

/** The card's question for a schedule approval, by what saving it would do. */
export function scheduleApprovalHeadline(details: ScheduleApprovalDetails): string {
  if (details.kind === "scheduled-task") return HEADLINES[details.action];
  return details.action === "create" ? HEADLINES.create : "Change this automation?";
}

export const SCHEDULE_APPROVAL_FOOTER = "Scheduled work runs on your desktop while Aiden is open and the computer is awake.";

/** "today at 9:00 AM", "tomorrow at 9:00 AM", or "Thu, Oct 23 at 9:00 AM", in this computer's time. */
export function formatScheduleNextRun(timestamp: number, now = Date.now()): string {
  const at = new Date(timestamp);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const date = at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${date} at ${time}`;
}

/** Whether the task will start on its own after this approval, so a next run is worth naming. */
function runsOnItsOwn(details: ScheduleApprovalDetails): boolean {
  if (!scheduledTaskEnabledAfterApproval(details) || !details.schedulerEnabled || details.nextRunAt <= 0) return false;
  return details.kind !== "scheduled-task" || details.action !== "remove";
}

function Fact({
  icon: Icon,
  label,
  warning = false,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  label: string;
  warning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-w-0 pl-9.5">
      <dt className="text-small text-tertiary">
        <span
          className={cn(
            "absolute top-0.5 left-0 grid size-7 place-items-center rounded-full",
            warning ? "bg-status-warning-surface text-status-warning" : "bg-control text-secondary",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        {label}
      </dt>
      <dd className="min-w-0 break-words text-small-strong text-primary">{children}</dd>
    </div>
  );
}

function Note({ tone, icon: Icon, children }: {
  tone: "warning" | "neutral";
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  children: React.ReactNode;
}) {
  return (
    <p
      role="note"
      className={cn(
        "approval-well flex shrink-0 items-start gap-2 px-3.5 py-2.5 text-small",
        tone === "warning" ? "bg-status-warning-surface text-status-warning" : "bg-well text-secondary",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 text-pretty">{children}</span>
    </p>
  );
}

/**
 * The review body of a scheduled-task or automation approval: what the task
 * is, when it runs, where and with what access, and the exact instructions.
 * The desktop authorizes the exact host scope, so project and connector ids
 * stay visible next to their names.
 */
export function ScheduledTaskApproval({
  details,
  descriptionId,
  now = Date.now(),
}: {
  details: ScheduleApprovalDetails;
  descriptionId: string;
  now?: number;
}) {
  const cadence = formatScheduledTaskCadence(details.cron, details.timezone, new Date(now));
  const script = details.kind === "scheduled-task" && details.mode === "script" ? details.script : null;
  const body = script ?? details.prompt;
  const full = details.permission === "full";
  const removing = details.kind === "scheduled-task" && details.action === "remove";
  // Pausing says so in the question; "stays paused" is for a task saved or run while paused.
  const staysPaused =
    !scheduledTaskEnabledAfterApproval(details) && !removing && !(details.kind === "scheduled-task" && details.action === "pause");
  const connectors = details.mcpServerIds.map((id, index) => ({ id, name: details.mcpServerNames[index] ?? id }));
  const legacyGlobalMcp = details.kind === "scheduled-task" && details.legacyGlobalMcp;

  return (
    <div id={descriptionId} className="mt-3 flex min-h-[min(7rem,12dvh)] flex-col gap-2 text-left" data-scheduled-task-approval="true">
      {/* A tall review scrolls here, so the question, notes and buttons stay on screen above the composer.
          It keeps a few lines even in a cramped window; the card scrolls for the rest. */}
      <div
        role="group"
        aria-label="Task details"
        tabIndex={0}
        className="approval-well min-h-0 space-y-2 overflow-y-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <div className="approval-well bg-well">
          <div className="px-4 pt-3.5 pb-3">
            <Text variant="strong" as="p" className="line-clamp-2 break-words">
              {details.name}
            </Text>
            <Text variant="regular" as="p" className="mt-0.5 break-words">
              {cadence}
            </Text>
            {runsOnItsOwn(details) ? (
              <Text variant="small" color="secondary" as="p" className="mt-1 flex items-center gap-1.5">
                <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                Next run {formatScheduleNextRun(details.nextRunAt, now)}
              </Text>
            ) : null}
          </div>
          <div className="@container mx-4 border-t border-separator py-3">
            <dl className="grid gap-x-6 gap-y-3 @md:grid-cols-2">
              <Fact
                icon={details.workspaceName ? FolderOpen : connectors.length > 0 ? Plug : full ? Earth : Folder}
                label="Runs in"
              >
                {details.workspaceName ? (
                  <>
                    {details.workspaceName}
                    {details.workspaceId ? (
                      <span className="block font-mono text-mini font-normal break-all text-tertiary">
                        <span className="sr-only">Project id </span>
                        {details.workspaceId}
                      </span>
                    ) : null}
                  </>
                ) : connectors.length > 0 ? (
                  <ul className="space-y-0.5">
                    {connectors.map((connector) => (
                      <li key={connector.id}>
                        {connector.name}{" "}
                        <span className="font-mono text-mini font-normal break-all text-tertiary">
                          <span className="sr-only">id </span>
                          {connector.id}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : full ? (
                  "Anywhere on your computer"
                ) : (
                  "No project"
                )}
              </Fact>
              <Fact icon={full ? ShieldAlert : ShieldCheck} label="Access" warning={full}>
                <Badge color={full ? "warning" : "gray"} className="mt-0.5">
                  {full ? "Full access" : "Read-only"}
                </Badge>
              </Fact>
              {script !== null ? (
                <Fact icon={SquareTerminal} label="Runs">
                  Script
                </Fact>
              ) : (
                <Fact icon={Cpu} label="Model">
                  {[details.providerName, details.modelName].filter(Boolean).join(" · ")}
                </Fact>
              )}
              <Fact icon={details.notify ? Bell : BellOff} label="Notifications">
                {details.notify ? "On" : "Off"}
              </Fact>
              <Fact icon={Earth} label="Time zone">
                {details.timezone}
              </Fact>
            </dl>
          </div>
        </div>
        {body ? (
          <div className="approval-well bg-well">
            <Text variant="small-strong" color="tertiary" as="p" className="px-4 pt-2.5">
              {script !== null ? "Script" : "Instructions"}
            </Text>
            <Text
              variant="small"
              as="p"
              aria-label={script !== null ? "Script" : "Instructions"}
              className={cn(
                "select-text px-4 pt-1 pb-3 whitespace-pre-wrap break-words text-primary",
                script !== null && "font-mono",
              )}
            >
              {body}
            </Text>
          </div>
        ) : null}
      </div>
      {!details.schedulerEnabled ? (
        <Note tone="warning" icon={TriangleAlert}>
          Scheduling is off. This task will be saved but will not run automatically until you enable scheduling.
        </Note>
      ) : staysPaused ? (
        <Note tone="neutral" icon={CirclePause}>
          This task stays paused.
        </Note>
      ) : null}
      {legacyGlobalMcp ? (
        <Note tone="neutral" icon={Plug}>
          This older task used every enabled connector. Approving limits it to the connectors listed here.
        </Note>
      ) : null}
    </div>
  );
}
