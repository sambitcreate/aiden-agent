import assert from "node:assert/strict";
import test from "node:test";
import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import type { AssistantPresentationRow } from "./assistant-message-presentation";
import {
  reduceUiDrafts,
  reduceUiVisuals,
  reuseUnchangedUiLists,
  uiVisualsByMessage,
  uiVisualSlots,
} from "./ui-visual-transcript";
import type { ChatMessage } from "./types";

function visual(id: string, toolCallId?: string): ChatUiVisualV1 {
  return {
    version: 1,
    kind: "ui",
    id,
    ...(toolCallId ? { toolCallId } : {}),
    title: id,
    catalogVersion: 1,
    tree: { t: "Visual", k: "0" },
    fallbackText: id,
  };
}

function activityRow(key: string, toolCallId: string): AssistantPresentationRow {
  return {
    kind: "activity",
    key,
    steps: [{ id: "tool-1", order: 0, kind: "tool", toolCallId, toolName: "render_ui", label: "Draw visual", status: "completed", startedAt: 1, updatedAt: 1 }],
  } as AssistantPresentationRow;
}

test("native visuals sit after their tool row; unplaced ones trail; drafts yield to presented visuals", () => {
  const rows = [activityRow("row-a", "call-1"), activityRow("row-b", "call-2")];
  const slots = uiVisualSlots(rows, [visual("ui-1", "call-1"), visual("ui-x", "call-9"), visual("ui-y")], new Map([
    ["call-1", visual("draft-call-1", "call-1")],
    ["call-2", visual("draft-call-2", "call-2")],
  ]));
  assert.deepEqual(slots.byRowKey.get("row-a")?.map((entry) => entry.id), ["ui-1"]);
  assert.deepEqual(slots.trailing.map((entry) => entry.id), ["ui-x", "ui-y"]);
  assert.equal(slots.draftsByRowKey.get("row-a"), undefined);
  assert.deepEqual(slots.draftsByRowKey.get("row-b")?.map((entry) => entry.id), ["draft-call-2"]);
});

test("live events update the presented list and the draft map", () => {
  let visuals: readonly ChatUiVisualV1[] = [];
  let drafts: ReadonlyMap<string, ChatUiVisualV1> = new Map();
  drafts = reduceUiDrafts(drafts, { version: 1, operation: "ui_draft", toolCallId: "call-1", visual: visual("draft-call-1", "call-1") });
  assert.equal(drafts.size, 1);
  const presented = visual("ui-1", "call-1");
  visuals = reduceUiVisuals(visuals, { version: 1, operation: "ui", visual: presented });
  drafts = reduceUiDrafts(drafts, { version: 1, operation: "ui", visual: presented });
  assert.equal(drafts.size, 0);
  const revised = { ...presented, fallbackText: "revised" };
  visuals = reduceUiVisuals(visuals, { version: 1, operation: "ui", visual: revised });
  assert.deepEqual(visuals.map((entry) => entry.fallbackText), ["revised"]);
  drafts = reduceUiDrafts(drafts, { version: 1, operation: "ui_draft", toolCallId: "call-2", visual: visual("draft-call-2", "call-2") });
  drafts = reduceUiDrafts(drafts, { version: 1, operation: "draft_end", toolCallId: "call-2" });
  assert.equal(drafts.size, 0);
  assert.deepEqual(reduceUiVisuals(visuals, { version: 1, operation: "reset" }), []);
  const unchanged = reduceUiDrafts(drafts, { version: 1, operation: "draft_end", toolCallId: "call-9" });
  assert.equal(unchanged, drafts, "irrelevant events keep identity");
});

test("a saved visual stays hidden while its live copy still owns the streaming row", () => {
  const message = { id: "m-1", role: "assistant", content: "", createdAt: 1, uiVisuals: [visual("ui-1"), visual("ui-2")] } as ChatMessage;
  const during = uiVisualsByMessage([message], new Set(["ui-1"]), true);
  assert.deepEqual(during.get("m-1")?.map((entry) => entry.id), ["ui-2"]);
  const after = uiVisualsByMessage([message], new Set(["ui-1"]), false);
  assert.deepEqual(after.get("m-1")?.map((entry) => entry.id), ["ui-1", "ui-2"]);
  const again = reuseUnchangedUiLists(after, uiVisualsByMessage([message], new Set(), false));
  assert.equal(again.get("m-1"), after.get("m-1"), "unchanged lists keep identity for memoized rows");
});
