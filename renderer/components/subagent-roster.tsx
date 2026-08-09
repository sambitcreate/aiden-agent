import * as React from "react";
import { ChevronRight } from "lucide-react";
import {
  buildSubagentTree,
  subagentTreeIsExpanded,
  subagentTreeKeyResult,
  visibleSubagentTreeNodes,
  type SubagentTreeGroups,
  type SubagentTreeKey,
  type SubagentTreeNode,
} from "../lib/subagent-tree";
import { cn } from "../lib/ui-utils";
import {
  splitSubagentRunViews,
  type SubagentRunView,
  type SubagentRunViewState,
} from "../lib/subagent-view-state";
import { SubagentOrb, subagentStateLabel } from "./subagent-chips";
import { Text } from "./ui";

export interface SubagentRunGroups {
  active: SubagentRunView[];
  done: SubagentRunView[];
}

export function groupSubagentRuns(runs: readonly SubagentRunView[]): SubagentRunGroups {
  return splitSubagentRunViews(runs);
}

function stateTone(state: SubagentRunViewState): string {
  if (state === "failed") return "text-red";
  if (state === "timed_out" || state === "needs_attention") return "text-support-warning";
  return "text-tertiary";
}

const NAVIGATION_KEYS = new Set<SubagentTreeKey>([
  "ArrowUp",
  "ArrowDown",
  "ArrowRight",
  "ArrowLeft",
  "Home",
  "End",
]);

function RosterNode({
  node,
  expansion,
  focusedRunId,
  selectedRunId,
  onToggle,
  onFocusRun,
  onSelect,
  onKeyDown,
}: {
  node: SubagentTreeNode;
  expansion: Readonly<Record<string, boolean>>;
  focusedRunId: string | null;
  selectedRunId: string | null;
  onToggle: (runId: string, expanded: boolean) => void;
  onFocusRun: (runId: string) => void;
  onSelect: (runId: string, trigger: HTMLButtonElement) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, runId: string) => void;
}) {
  const run = node.run;
  const expanded = subagentTreeIsExpanded(node, expansion);
  const selected = run.runId === selectedRunId;
  const displayState = node.level === 1 && node.branchActive ? "Active" : subagentStateLabel(run.state);
  const hiddenCount = expanded ? 0 : node.descendantCount;
  const orbState = node.level === 1 && node.branchActive ? "running" : run.state;
  return (
    <div data-subagent-tree-node={run.runId}>
      <div
        className={cn("flex min-w-0 items-center", node.level === 2 && "pl-5")}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${run.label}`}
            onClick={() => onToggle(run.runId, !expanded)}
            className="ml-1 grid size-6 shrink-0 place-items-center rounded-control text-tertiary outline-none hover:bg-list-hover focus-visible:bg-list-selection motion-reduce:transition-none"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="ml-1 size-6 shrink-0" />
        )}
        <button
          type="button"
          role="treeitem"
          aria-level={node.level}
          aria-posinset={node.position}
          aria-setsize={node.setSize}
          aria-expanded={node.children.length > 0 ? expanded : undefined}
          data-subagent-treeitem={run.runId}
          data-subagent-run-id={run.runId}
          tabIndex={focusedRunId === run.runId ? 0 : -1}
          aria-current={selected ? "true" : undefined}
          aria-label={`${run.label}, ${run.role}, ${displayState}${hiddenCount ? `, ${hiddenCount} hidden descendant${hiddenCount === 1 ? "" : "s"}` : ""}`}
          onFocus={() => onFocusRun(run.runId)}
          onKeyDown={(event) => onKeyDown(event, run.runId)}
          onClick={(event) => onSelect(run.runId, event.currentTarget)}
          className={cn(
            "mr-1 flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-2 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover focus-visible:bg-list-selection active:bg-list-selection motion-reduce:transition-none",
            selected && "bg-list-selection",
          )}
        >
          <SubagentOrb role={run.role} state={orbState} activity={run.snapshot?.activity} />
          <span className="min-w-0 flex-1">
            <Text as="span" variant="small-strong" truncate className="block">
              {run.label}
            </Text>
            <Text as="span" variant="small" color="secondary" truncate className="mt-0.5 block">
              {run.snapshot?.taskPreview ??
                (run.role === "unknown" ? "Saved subagent result" : run.role)}
            </Text>
          </span>
          {hiddenCount > 0 ? (
            <Text as="span" variant="small" color="tertiary" className="shrink-0">
              +{hiddenCount}
            </Text>
          ) : null}
          <Text
            as="span"
            variant="small"
            color="tertiary"
            className={cn("shrink-0", stateTone(run.state))}
          >
            {displayState}
          </Text>
        </button>
      </div>
      {node.children.length > 0 && expanded ? (
        <div role="group" aria-label={`Children of ${run.label}`}>
          {node.children.map((child) => (
            <RosterNode
              key={child.run.runId}
              node={child}
              expansion={expansion}
              focusedRunId={focusedRunId}
              selectedRunId={selectedRunId}
              onToggle={onToggle}
              onFocusRun={onFocusRun}
              onSelect={onSelect}
              onKeyDown={onKeyDown}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RosterGroup({
  label,
  nodes,
  ...props
}: {
  label: "Active" | "Done";
  nodes: readonly SubagentTreeNode[];
  expansion: Readonly<Record<string, boolean>>;
  focusedRunId: string | null;
  selectedRunId: string | null;
  onToggle: (runId: string, expanded: boolean) => void;
  onFocusRun: (runId: string) => void;
  onSelect: (runId: string, trigger: HTMLButtonElement) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, runId: string) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <div role="group" aria-label={`${label} subagents`}>
      <Text as="div" variant="small-strong" color="tertiary" className="px-3 pb-1 pt-3">
        {label} · {nodes.length}
      </Text>
      {nodes.map((node) => (
        <RosterNode key={node.run.runId} node={node} {...props} />
      ))}
    </div>
  );
}

export interface SubagentRosterProps {
  runs: readonly SubagentRunView[];
  selectedRunId: string | null;
  onSelect: (runId: string, trigger: HTMLButtonElement) => void;
  className?: string;
}

export function SubagentRoster({ runs, selectedRunId, onSelect, className }: SubagentRosterProps) {
  const treeRef = React.useRef<HTMLDivElement | null>(null);
  const groups = React.useMemo<SubagentTreeGroups>(() => buildSubagentTree(runs), [runs]);
  const [expansion, setExpansion] = React.useState<Readonly<Record<string, boolean>>>({});
  const visible = React.useMemo(
    () => visibleSubagentTreeNodes(groups, expansion),
    [groups, expansion],
  );
  const [focusedRunId, setFocusedRunId] = React.useState<string | null>(
    selectedRunId ?? visible[0]?.run.runId ?? null,
  );

  React.useLayoutEffect(() => {
    if (visible.some(({ run }) => run.runId === focusedRunId)) return;
    const selected = visible.find(({ run }) => run.runId === selectedRunId);
    setFocusedRunId(selected?.run.runId ?? visible[0]?.run.runId ?? null);
  }, [focusedRunId, selectedRunId, visible]);

  const focusRun = (runId: string) => {
    setFocusedRunId(runId);
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      treeRef.current?.querySelector<HTMLButtonElement>(
        `[data-subagent-run-id="${runId}"]`,
      )?.focus();
    });
  };
  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    runId: string,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(runId, event.currentTarget);
      return;
    }
    if (!NAVIGATION_KEYS.has(event.key as SubagentTreeKey)) return;
    event.preventDefault();
    const result = subagentTreeKeyResult(
      groups,
      expansion,
      runId,
      event.key as SubagentTreeKey,
    );
    if (result.expansion) setExpansion(result.expansion);
    focusRun(result.focusRunId);
  };
  const shared = {
    expansion,
    focusedRunId,
    selectedRunId,
    onToggle: (runId: string, expanded: boolean) =>
      setExpansion((current) => ({ ...current, [runId]: expanded })),
    onFocusRun: setFocusedRunId,
    onSelect,
    onKeyDown: handleKeyDown,
  };
  return (
    <nav aria-label="Subagents" className={cn("min-h-0 overflow-y-auto pb-3", className)}>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Subagent run hierarchy"
        className="flex flex-col gap-0.5 px-1.5"
      >
        <RosterGroup label="Active" nodes={groups.active} {...shared} />
        <RosterGroup label="Done" nodes={groups.done} {...shared} />
      </div>
    </nav>
  );
}
