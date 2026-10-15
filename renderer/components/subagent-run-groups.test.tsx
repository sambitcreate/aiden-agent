import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { SubagentRunSnapshot, SubagentRunSnapshotV2 } from "../shared/subagent-runs";
import type { SubagentRunView, SubagentRunViewState } from "../lib/subagent-view-state";
import { groupSubagentRuns } from "../lib/subagent-panel-state";
import { SubagentRunGroups } from "./subagent-run-groups";

afterEach(cleanup);

const ACTIVE = new Set<SubagentRunViewState>(["queued", "starting", "running", "needs_attention"]);

function runView(runId: string, state: SubagentRunViewState, extra: Partial<SubagentRunSnapshotV2> = {}): SubagentRunView {
  const terminal = !ACTIVE.has(state);
  const snapshot: SubagentRunSnapshotV2 = {
    version: 2,
    runId,
    groupId: "group-1",
    generationId: "generation-1",
    childId: `child-${runId}`,
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "scout",
    label: `Run ${runId}`,
    taskPreview: "Look around",
    state: state === "unknown" ? "unknown" : state,
    startedAt: 1_000,
    updatedAt: 2_000,
    ...(terminal ? { finishedAt: 61_000 } : {}),
    modelId: "test-model",
    turns: 1,
    tools: 1,
    tokens: 12_000,
    warnings: [],
    depth: 1,
    execution: "foreground",
    context: "fresh",
    authorityRevision: 1,
    ...extra,
  };
  return {
    runId,
    generationId: "generation-1",
    label: snapshot.label,
    role: snapshot.role,
    state,
    terminal,
    source: "live",
    sortKey: runId,
    snapshot,
  };
}

test("groupSubagentRuns places every state in its group, in display order, omitting empty groups", () => {
  const states: SubagentRunViewState[] = [
    "completed",
    "unknown",
    "interrupted",
    "needs_attention",
    "timed_out",
    "running",
    "stopped",
    "failed",
    "starting",
    "queued",
  ];
  const groups = groupSubagentRuns(states.map((state) => runView(state, state)));
  assert.deepEqual(
    groups.map((group) => [group.title, group.runs.map((run) => run.runId)]),
    [
      ["Running", ["running", "starting", "queued"]],
      ["Needs attention", ["needs_attention"]],
      ["Failed", ["unknown", "timed_out", "failed"]],
      ["Stopped", ["interrupted", "stopped"]],
      ["Completed", ["completed"]],
    ],
  );

  assert.deepEqual(
    groupSubagentRuns([runView("a", "failed"), runView("b", "completed")]).map((group) => group.title),
    ["Failed", "Completed"],
  );
  assert.deepEqual(groupSubagentRuns([]), []);
});

function mount(runs: SubagentRunView[], stopPendingRunIds: readonly string[] = []) {
  const opened: string[] = [];
  const stopped: SubagentRunSnapshot[] = [];
  render(
    <SubagentRunGroups
      runs={runs}
      stopPendingRunIds={stopPendingRunIds}
      onOpen={(runId) => opened.push(runId)}
      onStop={(run) => {
        stopped.push(run);
      }}
    />,
  );
  return { opened, stopped };
}

test("Completed starts folded and opens to show its runs", () => {
  mount([runView("live", "running"), runView("c1", "completed"), runView("c2", "completed"), runView("c3", "completed")]);
  const fold = screen.getByRole("button", { name: /Completed/u });
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.match(fold.textContent ?? "", /3/u);
  const completed = screen.getByRole("group", { name: "Completed, 3" });
  assert.equal(within(completed).queryByRole("button", { name: /Run c1/u }), null);

  fireEvent.click(fold);

  assert.equal(fold.getAttribute("aria-expanded"), "true");
  for (const id of ["c1", "c2", "c3"]) assert.ok(within(completed).getByRole("button", { name: new RegExp(`^Run ${id}`, "u") }));
});

test("Stop appears only on active runs and stops that run", () => {
  const { stopped } = mount([
    runView("live", "running", { activity: "Reading files" }),
    runView("waiting", "needs_attention"),
    runView("broken", "failed", { error: "Provider returned 429" }),
    runView("halted", "stopped"),
  ]);
  const stops = screen.getAllByRole("button", { name: /^Stop /u });
  assert.deepEqual(
    stops.map((button) => button.getAttribute("aria-label")),
    ["Stop Run live", "Stop Run waiting"],
  );
  assert.ok(screen.getByText("Provider returned 429"));

  fireEvent.click(stops[0]);
  assert.deepEqual(stopped.map((run) => run.runId), ["live"]);
});

test("a run that is already stopping shows a disabled Stopping… control", () => {
  const { stopped } = mount([runView("live", "running")], ["live"]);
  const pending = screen.getByRole("button", { name: "Stopping Run live" });
  assert.equal((pending as HTMLButtonElement).disabled, true);
  assert.match(pending.textContent ?? "", /Stopping…/u);
  fireEvent.click(pending);
  assert.deepEqual(stopped, []);
});

test("clicking a row opens that run", () => {
  const { opened } = mount([runView("live", "running"), runView("broken", "failed")]);
  fireEvent.click(screen.getByRole("button", { name: /^Run broken/u }));
  assert.deepEqual(opened, ["broken"]);
});

test("finished runs show their duration", () => {
  mount([runView("broken", "failed")]);
  const row = screen.getByRole("button", { name: /^Run broken/u });
  assert.match(row.textContent ?? "", /1m 0s/u);
});

test("active runs show live elapsed time that ticks each second", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 11_000 });
  mount([runView("live", "running")]);
  const row = screen.getByRole("button", { name: /^Run live/u });
  assert.match(row.textContent ?? "", /10s/u);

  act(() => t.mock.timers.tick(1_000));
  assert.match(row.textContent ?? "", /11s/u);

  cleanup();
  t.mock.timers.reset();
});
