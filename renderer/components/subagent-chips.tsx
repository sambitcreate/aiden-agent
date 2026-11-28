import * as React from "react";
import { flushSync } from "react-dom";
import { ChevronDown } from "lucide-react";
import { subagentModelDisplay, subagentRunProgressLabel } from "../lib/subagent-panel-state";
import {
  subagentModelLine,
  subagentModelName,
  useSubagentModelCatalog,
} from "../lib/subagent-model-name";
import {
  formatSubagentElapsed,
  isSubagentRunViewStateActive,
  longestSubagentElapsedLabel,
  subagentRoleLabel,
  subagentSnapshotElapsedMilliseconds,
  subagentStatusCounts,
  subagentStatusLabel as subagentViewStatusLabel,
  type SubagentRunViewRole,
  type SubagentStatusWord,
  type SubagentRunViewState,
} from "../lib/subagent-view-state";
import { cn } from "../lib/ui-utils";
import { useCollapsibleBody } from "../lib/use-collapsible-body";
import { useNow } from "../lib/use-now";
import { useObserveSubagentGroup } from "../lib/subagent-group-visibility";
import { type SubagentMessageReferenceV1, type SubagentRunSnapshot } from "../shared/subagent-runs";
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
  if (/^(?:Reading|Listing|Matching|Searching)\b/u.test(activity ?? "")) return "scan-grid";
  if (activity === "Reviewing workspace context") return "tri-step";
  // Older saved runs say "Writing a bounded report".
  if (activity === "Writing its report" || activity === "Writing a bounded report")
    return "compose";
  return fallbackMarkForRole(role);
}

function isActiveState(state: SubagentRunViewState | "finished"): boolean {
  return state !== "finished" && isSubagentRunViewStateActive(state);
}

export function subagentStateLabel(state: SubagentRunViewState | "finished"): string {
  return state === "finished" ? "Done" : subagentViewStatusLabel(state);
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

export function SubagentMark({ role, state, activity, size = 20, className }: SubagentMarkProps) {
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
  const row = Array.from(root.querySelectorAll<HTMLElement>("[data-subagent-chip-run-id]")).find(
    (element) => element.dataset.subagentChipRunId === runId,
  );
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

function subagentGroupSummaryParts(
  states: readonly (SubagentRunViewState | "finished")[],
): { word: SubagentStatusWord; text: string }[] {
  return subagentStatusCounts(states).map(({ word, count }) => ({
    word,
    text: `${count} ${word.toLowerCase()}`,
  }));
}

/** "1 waiting on you · 2 running · 1 done", most urgent first. */
export function subagentGroupSummary(
  states: readonly (SubagentRunViewState | "finished")[],
): string {
  return subagentGroupSummaryParts(states)
    .map((part) => part.text)
    .join(" · ");
}

/** The role every run in a group shares, so the header can name it once; undefined when mixed or unknown. */
export function subagentGroupSharedRole(
  roles: readonly (SubagentRunViewRole | undefined)[],
): SubagentRunViewRole | undefined {
  const first = roles[0];
  if (!first || first === "unknown") return undefined;
  return roles.every((role) => role === first) ? first : undefined;
}

/** "3 implementers" when every run shares a role, otherwise "3 subagents". */
export function subagentGroupCountLabel(
  count: number,
  role: SubagentRunViewRole | undefined,
): string {
  const noun = role && role !== "unknown" ? role : "subagent";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
export function SubagentChips({ reference, runs = [], onOpen, className }: SubagentChipsProps) {
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
  const sectionRef = React.useRef<HTMLElement>(null);
  const bodyId = React.useId();
  const { hidden, open } = useCollapsibleBody(collapsed, bodyRef);

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
  // The composer pill stays away while this card is on screen.
  useObserveSubagentGroup(sectionRef, runIds.length ? groupKey : "");
  if (runIds.length === 0) return null;

  const sharedRole = subagentGroupSharedRole(groupRuns.map((item) => item.role));
  const count = subagentGroupCountLabel(runIds.length, sharedRole);
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
      ref={sectionRef}
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
              <React.Fragment key={part.word}>
                {index > 0 ? " · " : null}
                {/* Once settled, only the failures stand out. */}
                <span className={cn(!active && part.word === "Failed" && "text-red")}>
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
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-(--motion-duration) ease-standard motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="m-0 mt-1 flex list-none flex-col rounded-card bg-well p-1">
            {groupRuns.map((item) => (
              <SubagentGroupRow
                key={item.runId}
                item={item}
                now={now}
                onOpen={onOpen}
                showRole={sharedRole === undefined}
              />
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
  showRole,
}: {
  item: GroupRun;
  now: number;
  onOpen: (runId: string, trigger: HTMLButtonElement) => void;
  /** False when the group header already names the role every run shares. */
  showRole: boolean;
}) {
  const { runId, label, role, state, run } = item;
  const status = subagentStatusLabel(state, run?.activity);
  const model = run ? subagentModelDisplay(run) : undefined;
  const catalog = useSubagentModelCatalog();
  const modelName = run ? subagentModelName(run, catalog) : undefined;
  // Older snapshots never recorded a model choice; their label stays unchanged.
  const spokenModel =
    run && run.modelSelection !== undefined
      ? `Model ${subagentModelLine(run, catalog)}`
      : undefined;
  const elapsedMs = run ? subagentSnapshotElapsedMilliseconds(run, now) : undefined;
  const roleName = showRole ? subagentRoleLabel(role) : null;
  // One line per run: name, what it is doing, and how long it has run.
  const row = (
    <button
      type="button"
      data-subagent-chip-run-id={runId}
      className="flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-1 text-left transition-colors [--keyboard-focus-offset:-2px] duration-150 ease-out hover:bg-list-hover active:bg-list-selection motion-reduce:transition-none"
      aria-label={`Open ${label}. Status: ${status}.${spokenModel ? ` ${spokenModel}.` : ""}`}
      onClick={(event) => onOpen(runId, event.currentTarget)}
    >
      <SubagentMark role={role} state={state} activity={run?.activity} size={16} />
      <span className="min-w-0 flex-1 truncate text-small text-primary">{label}</span>
      {roleName ? (
        <span className="shrink-0 rounded-full bg-control px-1.5 text-mini text-secondary">
          {roleName}
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 max-w-[45%] shrink truncate text-mini text-tertiary",
          state === "failed" && "text-red",
          (state === "timed_out" || state === "needs_attention") && "text-support-warning",
        )}
        title={status}
      >
        {status}
      </span>
      <span className="shrink-0 text-mini whitespace-nowrap text-tertiary tabular-nums">
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
            <dd className="break-words text-secondary [overflow-wrap:anywhere]" title={model.model}>
              {modelName}
            </dd>
            {model.effort && run?.thinkingLevel !== "off" ? (
              <>
                <dt className="text-tertiary">Effort</dt>
                <dd className="text-secondary">{model.effort}</dd>
              </>
            ) : null}
            {model.selection ? (
              <>
                <dt className="text-tertiary">Model choice</dt>
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
