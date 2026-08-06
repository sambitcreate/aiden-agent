import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRunSnapshotV1, SubagentRunSnapshotV2 } from "../shared/subagent-runs.js";
import type { SubagentRunView } from "./subagent-view-state.js";
import {
  buildSubagentTree,
  subagentTreeIsExpanded,
  subagentTreeKeyResult,
  visibleSubagentTreeNodes,
} from "./subagent-tree.js";

function snapshot(runId: string, extra: Partial<SubagentRunSnapshotV2> = {}): SubagentRunSnapshotV2 {
  return {
    version: 2, runId, groupId: "group-root", generationId: "generation-one",
    childId: `child-${runId}`, chatId: "chat-one", workspaceId: "workspace-one",
    revision: 1, role: "scout", label: runId, taskPreview: `Task ${runId}`,
    state: "completed", startedAt: 1, updatedAt: 2, finishedAt: 2,
    modelId: "model-one", turns: 1, tools: 0, tokens: 1, warnings: [],
    depth: 1, execution: "foreground", context: "fresh", authorityRevision: 1,
    ...extra,
  };
}

function view(value: SubagentRunSnapshotV1 | SubagentRunSnapshotV2): SubagentRunView {
  return {
    runId: value.runId, generationId: value.generationId, label: value.label,
    role: value.role, state: value.state, terminal: value.finishedAt !== undefined,
    source: "live", sortKey: `${value.startedAt}:${value.runId}`, snapshot: value,
  };
}

test("strict V2 lineage reconstructs while V1, orphan, and owner mismatch stay flat", () => {
  const parent = view(snapshot("parent"));
  const child = view(snapshot("child", { groupId: "parent:nested-1", depth: 2, parentRunId: "parent" }));
  const orphan = view(snapshot("orphan", { depth: 2, parentRunId: "missing" }));
  const wrongOwner = view(snapshot("wrong-owner", {
    depth: 2, parentRunId: "parent", workspaceId: "workspace-other",
  }));
  const legacy = view({ ...snapshot("legacy"), version: 1 } as SubagentRunSnapshotV1);
  const groups = buildSubagentTree([parent, child, orphan, wrongOwner, legacy]);
  assert.deepEqual(groups.done.map(({ run }) => run.runId), ["parent", "orphan", "wrong-owner", "legacy"]);
  assert.deepEqual(groups.done[0]!.children.map(({ run }) => run.runId), ["child"]);
  assert.equal(groups.done[0]!.children[0]!.level, 2);
  assert.equal(groups.done[0]!.children[0]!.parentRunId, "parent");
});

test("a terminal root remains Active while any visible or hidden descendant is active", () => {
  const groups = buildSubagentTree([
    view(snapshot("parent")),
    view(snapshot("active-child", {
      groupId: "parent:nested-1", depth: 2, parentRunId: "parent",
      state: "running", finishedAt: undefined,
    })),
  ]);
  const root = groups.active[0]!;
  assert.equal(root.run.runId, "parent");
  assert.equal(root.branchActive, true);
  assert.equal(root.activeDescendantCount, 1);
  assert.equal(subagentTreeIsExpanded(root, {}), true);
  assert.equal(subagentTreeIsExpanded(root, { parent: false }), false);
  assert.deepEqual(visibleSubagentTreeNodes(groups, { parent: false }).map(({ run }) => run.runId), ["parent"]);
});

test("keyboard navigation follows stable visible preorder and semantic branch rules", () => {
  const groups = buildSubagentTree([
    view(snapshot("parent")),
    view(snapshot("child-a", { depth: 2, parentRunId: "parent" })),
    view(snapshot("child-b", { depth: 2, parentRunId: "parent" })),
    view(snapshot("sibling")),
  ]);
  assert.deepEqual(subagentTreeKeyResult(groups, { parent: false }, "parent", "ArrowRight"), {
    focusRunId: "parent", expansion: { parent: true },
  });
  assert.equal(subagentTreeKeyResult(groups, { parent: true }, "parent", "ArrowRight").focusRunId, "child-a");
  assert.equal(subagentTreeKeyResult(groups, { parent: true }, "child-a", "ArrowLeft").focusRunId, "parent");
  assert.equal(subagentTreeKeyResult(groups, { parent: true }, "child-b", "ArrowDown").focusRunId, "sibling");
  assert.equal(subagentTreeKeyResult(groups, { parent: true }, "sibling", "Home").focusRunId, "parent");
  assert.equal(subagentTreeKeyResult(groups, { parent: true }, "parent", "End").focusRunId, "sibling");
  assert.deepEqual(subagentTreeKeyResult(groups, { parent: true }, "parent", "ArrowLeft"), {
    focusRunId: "parent", expansion: { parent: false },
  });
});
