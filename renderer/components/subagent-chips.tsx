import * as React from "react";
import { flushSync } from "react-dom";
import { ChevronDown } from "lucide-react";
import { subagentModelDisplay, subagentRunProgressLabel } from "../lib/subagent-panel-state";
import {
  formatSubagentElapsed,
  isSubagentRunViewStateActive,
  longestSubagentElapsedLabel,
  subagentRoleLabel,
  subagentSnapshotElapsedMilliseconds,
  type SubagentRunViewRole,
  type SubagentRunViewState,
} from "../lib/subagent-view-state";
import { cn } from "../lib/ui-utils";
import { useCollapsibleBody } from "../lib/use-collapsible-body";
import { useNow } from "../lib/use-now";
import {
  type SubagentMessageReferenceV1,
  type SubagentRunSnapshot,
} from "../shared/subagent-runs";
import type { ActivityMark } from "../shared/activity-marks";
import { AidenActivityMark } from "./aiden-activity-mark";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui";

function fallbackMarkForRole(role: SubagentRunViewRole | undefined): ActivityMark {
  if (role === "scout") return "scan-grid";
  if (role === "planner") return "tri-step";
  return "quad-shuffle";
}

export function subagentActivityMark(
  state: SubagentRunViewState | "finished",
  role?: SubagentRunViewRole,
  activity?: string,
): ActivityMark {
  if (state === "queued" || state === "starting") return "bounce";
  // A waiting child is blocked on the user, whatever its free-form question says.
  if (state === "needs_attention") return "glance";
  if (/^(?:Reading|Listing|Matching|Searching)\b/u.test(activity ?? ""))
    return "scan-grid";
  if (activity === "Reviewing workspace context") return "tri-step";
  if (activity === "Writing a bounded report") return "compose";
  return fallbackMarkForRole(role);
}

function isActiveState(state: SubagentRunViewState | "finished"): boolean {
  return state !== "finished" && isSubagentRunViewStateActive(state);
}

export function subagentStateLabel(
  state: SubagentRunViewState | "finished",
): string {
  if (state === "queued") return "Queued";
  if (state === "starting") return "Starting";
  if (state === "running") return "Working";
  if (state === "completed") return "Finished";
  if (state === "failed") return "Failed";
  if (state === "timed_out") return "Timed out";
  if (state === "interrupted") return "Interrupted";
  if (state === "needs_attention") return "Needs attention";
  if (state === "stopped") return "Stopped";
  if (state === "unknown") return "Outcome unknown";
  return "Finished";
}

export function subagentStatusLabel(
  state: SubagentRunViewState | "finished",
  activity?: string,
): string {
  return subagentRunProgressLabel(state, activity);
}

export interface SubagentMarkProps {
  role?: SubagentRunViewRole;
  state: SubagentRunViewState | "finished";
  activity?: string;
  size?: number;
  className?: string;
}

export function SubagentMark({
  role,
  state,
  activity,
  size = 20,
  className,
}: SubagentMarkProps) {
  const active = isActiveState(state);

  return (
    <AidenActivityMark
      mark={subagentActivityMark(state, role, activity)}
      size={size}
      active={active}
      className={cn("shrink-0 opacity-70", className)}
      data-subagent-mark-state={active ? "active" : "terminal"}
    />
  );
}

export interface SubagentMarkStackItem {
  key: string;
  role?: SubagentRunViewRole;
  state: SubagentRunViewState | "finished";
  activity?: string;
}

const MAX_STACKED_MARKS = 3;

/** Up to three overlapping run marks and a "+N" count, for a batch summary. */
export function SubagentMarkStack({
  items,
  className,
  ringClassName = "bg-popover",
}: {
  items: readonly SubagentMarkStackItem[];
  className?: string;
  /** The surface behind the stack, so overlapping marks read as separate discs. */
  ringClassName?: string;
}) {
  const shown = items.slice(0, MAX_STACKED_MARKS);
  const extra = items.length - shown.length;
  const disc = (index: number) =>
    cn("grid size-6 place-items-center rounded-full", ringClassName, index > 0 && "-ml-2");
  return (
    <span className={cn("flex shrink-0 items-center", className)} aria-hidden="true">
      {shown.map((item, index) => (
        <span key={item.key} className={disc(index)}>
          <span className="grid size-5 place-items-center rounded-full bg-control">
            <SubagentMark
              role={item.role}
              state={item.state}
              activity={item.activity}
              size={13}
              className="opacity-90"
            />
          </span>
        </span>
      ))}
      {extra > 0 ? (
        <span className={disc(shown.length)}>
          <span className="grid size-5 place-items-center rounded-full bg-control text-mini font-medium text-secondary tabular-nums">
            +{extra}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The transcript control that stands for a run: its row, or the header of its
 * group while the group is collapsed and the row is inert.
 */
export function subagentRunTranscriptTarget(
  runId: string,
  root: ParentNode = document,
): HTMLElement | null {
  const row = Array.from(
    root.querySelectorAll<HTMLElement>("[data-subagent-chip-run-id]"),
  ).find((element) => element.dataset.subagentChipRunId === runId);
  if (!row) return null;
  if (!row.closest("[inert]")) return row;
  return (
    row
      .closest("[data-subagent-group]")
      ?.querySelector<HTMLElement>(":scope > [data-subagent-chip-group-toggle]") ?? null
  );
}

/**
 * Scrolls a run's transcript row into view and focuses it, expanding its group
 * first when the group is collapsed. Returns false when the run has no row.
 */
export function revealSubagentRunInTranscript(
  runId: string,
  { instant = false }: { instant?: boolean } = {},
  root: ParentNode = document,
): boolean {
  let target = subagentRunTranscriptTarget(runId, root);
  if (!target) return false;
  if (target.hasAttribute("data-subagent-chip-group-toggle")) {
    // Expand now so the row is focusable before it is revealed.
    flushSync(() => target?.click());
    target = subagentRunTranscriptTarget(runId, root) ?? target;
  }
  target.scrollIntoView({ block: "center", behavior: instant ? "auto" : "smooth" });
  target.focus({ preventScroll: true });
  return true;
}

export interface SubagentChipsProps {
  reference?: SubagentMessageReferenceV1;
  runs?: readonly SubagentRunSnapshot[];
  onOpen: (runId: string, trigger: HTMLButtonElement) => void;
  className?: string;
}

const SUMMARY_ORDER: ReadonlyArray<readonly [SubagentRunViewState | "finished", string]> = [
  ["needs_attention", "needs attention"],
  ["running", "working"],
  ["starting", "starting"],
  ["queued", "queued"],
  ["failed", "failed"],
  ["timed_out", "timed out"],
  ["interrupted", "interrupted"],
  ["unknown", "outcome unknown"],
  ["stopped", "stopped"],
  ["completed", "completed"],
  ["finished", "finished"],
];

function subagentGroupSummaryParts(
  states: readonly (SubagentRunViewState | "finished")[],
): { state: SubagentRunViewState | "finished"; text: string }[] {
  const counts = new Map<SubagentRunViewState | "finished", number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  return SUMMARY_ORDER.filter(([state]) => counts.has(state)).map(([state, text]) => ({
    state,
    text: `${counts.get(state)} ${text}`,
  }));
}

/** "1 needs attention · 2 working · 1 completed", most urgent first. */
export function subagentGroupSummary(states: readonly (SubagentRunViewState | "finished")[]): string {
  return subagentGroupSummaryParts(states)
    .map((part) => part.text)
    .join(" · ");
}

/**
 * Session memory of which transcript groups the person collapsed, keyed by
 * generation. The live group and the saved message that replaces it are
 * different elements, so the choice must outlive either one.
 */
const collapsedGroups = new Set<string>();
/** Older choices are forgotten first; their groups have long scrolled out of reach. */
const MAX_REMEMBERED_COLLAPSED_GROUPS = 200;

interface GroupRun {
  runId: string;
  label: string;
  role?: SubagentRunViewRole;
  state: SubagentRunViewState | "finished";
  run?: SubagentRunSnapshot;
}

/**
 * The transcript's record of one generation's subagents: a collapsible card
 * with a stacked summary header and one row per run that opens it in the
 * side panel. Rows keep `data-subagent-chip-run-id` so focus survives the
 * live-to-saved handoff and the composer pill can reveal them.
 */
export function SubagentChips({
  reference,
  runs = [],
  onOpen,
  className,
}: SubagentChipsProps) {
  const snapshotsById = React.useMemo(
    () => new Map(runs.map((run) => [run.runId, run] as const)),
    [runs],
  );
  const runIds = reference?.runIds ?? runs.map((run) => run.runId);
  const groupKey = reference?.generationId ?? runs[0]?.generationId ?? runIds[0] ?? "";
  // The live group's element carries on into the next turn's generation, so the
  // choice is read again whenever the group it stands for changes.
  const [choice, setChoice] = React.useState(() => ({
    groupKey,
    collapsed: collapsedGroups.has(groupKey),
  }));
  const collapsed = choice.groupKey === groupKey ? choice.collapsed : collapsedGroups.has(groupKey);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const bodyId = React.useId();
  const { hidden, open, onTransitionEnd } = useCollapsibleBody(collapsed, bodyRef);

  const groupRuns: GroupRun[] = runIds.map((runId, index) => {
    const run = snapshotsById.get(runId);
    const referencedItem =
      reference?.items?.[index]?.runId === runId ? reference.items[index] : undefined;
    return {
      runId,
      label: run?.label ?? referencedItem?.label ?? `Subagent ${index + 1}`,
      role: run?.role ?? referencedItem?.role,
      state: run?.state ?? referencedItem?.state ?? "finished",
      run,
    };
  });
  const active = groupRuns.some((item) => isActiveState(item.state));
  const now = useNow(active);
  if (runIds.length === 0) return null;

  const count = `${runIds.length} subagent${runIds.length === 1 ? "" : "s"}`;
  const attention = groupRuns.some((item) => item.state === "needs_attention");
  const elapsed = longestSubagentElapsedLabel(
    groupRuns.map((item) => item.run),
    now,
  );
  const summaryParts = subagentGroupSummaryParts(groupRuns.map((item) => item.state));
  const summary = summaryParts.map((part) => part.text).join(" · ");
  const toggle = () => {
    const next = !collapsed;
    collapsedGroups.delete(groupKey);
    if (next) collapsedGroups.add(groupKey);
    for (const key of collapsedGroups) {
      if (collapsedGroups.size <= MAX_REMEMBERED_COLLAPSED_GROUPS) break;
      collapsedGroups.delete(key);
    }
    setChoice({ groupKey, collapsed: next });
  };

  return (
    <section
      className={cn("min-w-0", className)}
      role="group"
      aria-label={count}
      data-subagent-group={groupKey}
    >
      <button
        type="button"
        // The visible elapsed time ticks every second; keep it out of the name.
        aria-label={`${active ? "Kicked off" : "Ran"} ${count}. ${summary}.`}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={toggle}
        data-subagent-chip-group-toggle={groupKey}
        className="flex min-h-10 w-full [--keyboard-focus-offset:-2px] min-w-0 items-center gap-2.5 rounded-control py-1 pr-2.5 pl-1 text-left transition-colors duration-150 ease-out hover:bg-list-hover motion-reduce:transition-none"
      >
        <SubagentMarkStack
          ringClassName="bg-transparent"
          items={groupRuns.map((item) => ({
            key: item.runId,
            role: item.role,
            state: item.state,
            activity: item.run?.activity,
          }))}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-small-strong text-primary">
            {active ? "Kicked off" : "Ran"} {count}
          </span>
          <span
            className={cn(
              "truncate text-mini",
              attention ? "text-support-warning" : active ? "text-status-accent" : "text-tertiary",
            )}
          >
            {summaryParts.map((part, index) => (
              <React.Fragment key={part.state}>
                {index > 0 ? " · " : null}
                {/* Once settled, only the failures stand out. */}
                <span
                  className={cn(
                    !active && part.state === "failed" && "text-red",
                    !active && part.state === "timed_out" && "text-support-warning",
                  )}
                >
                  {part.text}
                </span>
              </React.Fragment>
            ))}
          </span>
        </span>
        {elapsed ? (
          <span className="shrink-0 text-mini text-tertiary tabular-nums">{elapsed}</span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-tertiary transition-transform duration-150 motion-reduce:transition-none",
            !collapsed && "rotate-180",
          )}
        />
      </button>
      <div
        ref={bodyRef}
        id={bodyId}
        inert={collapsed ? true : undefined}
        aria-hidden={collapsed ? true : undefined}
        hidden={hidden}
        onTransitionEnd={onTransitionEnd}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--motion-duration) ease-standard motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="m-0 mt-1 flex list-none flex-col rounded-card bg-well p-1">
            {groupRuns.map((item) => (
              <SubagentGroupRow key={item.runId} item={item} now={now} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function SubagentGroupRow({
  item,
  now,
  onOpen,
}: {
  item: GroupRun;
  now: number;
  onOpen: (runId: string, trigger: HTMLButtonElement) => void;
}) {
  const { runId, label, role, state, run } = item;
  const status = subagentStatusLabel(state, run?.activity);
  const model = run ? subagentModelDisplay(run) : undefined;
  // Older snapshots never recorded a model choice; their label stays unchanged.
  const recordedModel = run?.modelSelection !== undefined ? model : undefined;
  const elapsedMs = run ? subagentSnapshotElapsedMilliseconds(run, now) : undefined;
  const roleName = subagentRoleLabel(role);
  const row = (
    <button
      type="button"
      data-subagent-chip-run-id={runId}
      className="grid min-h-11 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control px-2 py-1 text-left transition-colors [--keyboard-focus-offset:-2px] duration-150 ease-out hover:bg-list-hover active:bg-list-selection motion-reduce:transition-none"
      aria-label={`Open ${label}. Status: ${status}.${recordedModel ? ` ${recordedModel.spoken}.` : ""}`}
      onClick={(event) => onOpen(runId, event.currentTarget)}
    >
      <SubagentMark role={role} state={state} activity={run?.activity} size={18} />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-small text-primary">{label}</span>
          {roleName ? (
            <span className="shrink-0 rounded-full bg-control px-1.5 text-mini text-secondary">
              {roleName}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "truncate text-mini text-tertiary",
            state === "failed" && "text-red",
            (state === "timed_out" || state === "needs_attention") && "text-support-warning",
          )}
          title={status}
        >
          {status}
        </span>
      </span>
      <span className="text-mini whitespace-nowrap text-tertiary tabular-nums">
        {elapsedMs === undefined ? "" : formatSubagentElapsed(elapsedMs)}
      </span>
    </button>
  );
  if (!model) return <li>{row}</li>;
  return (
    <li>
      <HoverCard openDelay={200} closeDelay={100}>
        <HoverCardTrigger asChild>{row}</HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="start"
          className="w-[min(18rem,calc(100vw-2rem))]"
          data-subagent-model-card={runId}
        >
          <p className="truncate text-small font-medium text-primary">{label}</p>
          <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-mini">
            <dt className="text-tertiary">Model</dt>
            <dd className="break-words text-secondary [overflow-wrap:anywhere]">{model.model}</dd>
            {model.effort ? (
              <>
                <dt className="text-tertiary">Effort</dt>
                <dd className="text-secondary">{model.effort}</dd>
              </>
            ) : null}
            {model.selection ? (
              <>
                <dt className="text-tertiary">Choice</dt>
                <dd className="text-secondary">{model.selection}</dd>
              </>
            ) : null}
            <dt className="text-tertiary">Status</dt>
            <dd className="break-words text-secondary">{status}</dd>
          </dl>
        </HoverCardContent>
      </HoverCard>
    </li>
  );
}
