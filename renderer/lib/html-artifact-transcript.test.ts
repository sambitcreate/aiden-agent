import assert from "node:assert/strict";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import type { AssistantPresentationRow } from "./assistant-message-presentation";
import {
  htmlArtifactSlots,
  reduceVisualDrafts,
  reuseUnchangedArtifactLists,
  type VisualDrafts,
} from "./html-artifact-transcript";

const DRAFT_SRC = `aiden-genui://preview/${"d".repeat(64)}`;

test("present clears the draft for its toolCallId; draft_end and reset clear too", () => {
  let drafts: VisualDrafts = new Map();
  drafts = reduceVisualDrafts(drafts, { version: 1, operation: "draft", toolCallId: "c1", title: "A", src: DRAFT_SRC });
  drafts = reduceVisualDrafts(drafts, { version: 1, operation: "draft", toolCallId: "c2", src: DRAFT_SRC });
  assert.deepEqual([...drafts.keys()], ["c1", "c2"]);
  const art = {
    version: 1 as const, kind: "html" as const, id: "i".repeat(64), title: "A",
    mimeType: "text/html" as const, size: 1, mediaId: "m".repeat(64),
  };
  drafts = reduceVisualDrafts(drafts, { version: 1, operation: "present", artifact: art, toolCallId: "c1" });
  assert.deepEqual([...drafts.keys()], ["c2"]);
  const unchanged = reduceVisualDrafts(drafts, { version: 1, operation: "present", artifact: art });
  assert.equal(unchanged, drafts);
  drafts = reduceVisualDrafts(drafts, { version: 1, operation: "draft_end", toolCallId: "c2" });
  assert.equal(drafts.size, 0);
  drafts = reduceVisualDrafts(drafts, { version: 1, operation: "draft", toolCallId: "c3", src: DRAFT_SRC });
  assert.equal(reduceVisualDrafts(drafts, { version: 1, operation: "reset" }).size, 0);
});

test("drafts sit in the row of their pending tool call and never beside a presented visual", () => {
  const drafts: VisualDrafts = new Map([
    ["call_a", { src: DRAFT_SRC, title: "A" }],
    ["call_b", { src: DRAFT_SRC }],
    ["call_gone", { src: DRAFT_SRC }],
  ]);
  const a = artifact("a");
  const slots = htmlArtifactSlots(rows, [a], new Map([[a.mediaId, "call_a"]]), drafts);
  assert.deepEqual(slots.draftsByRowKey.get("activity-5-a"), undefined);
  assert.deepEqual(slots.draftsByRowKey.get("activity-11-b"), [{ toolCallId: "call_b", src: DRAFT_SRC }]);
  assert.equal([...slots.draftsByRowKey.values()].flat().some((d) => d.toolCallId === "call_gone"), false);
});

const artifact = (n: string): ChatHtmlArtifactV1 => ({
  version: 1, kind: "html", id: n.repeat(64), title: `A${n}`,
  mimeType: "text/html", size: 1, mediaId: n.repeat(64),
});
const toolStep = (toolCallId: string) => ({
  id: `s-${toolCallId}`, order: 0, kind: "tool" as const, toolCallId,
  toolName: "render_artifact", label: "Render artifact", status: "completed" as const,
  startedAt: 0, updatedAt: 0,
});
const rows: AssistantPresentationRow[] = [
  { key: "text-0", kind: "text", content: "Intro", startOffset: 0, endOffset: 5 },
  { key: "activity-5-a", kind: "activity", contentOffset: 5, steps: [toolStep("call_a")] },
  { key: "text-5", kind: "text", content: "Middle", startOffset: 5, endOffset: 11 },
  { key: "activity-11-b", kind: "activity", contentOffset: 11, steps: [toolStep("call_b"), toolStep("call_c")] },
];

test("placed artifacts land after the activity row that produced them", () => {
  const a = artifact("a"), b = artifact("b"), c = artifact("c");
  const slots = htmlArtifactSlots(rows, [a, b, c], new Map([
    [a.mediaId, "call_a"], [b.mediaId, "call_b"], [c.mediaId, "call_c"],
  ]));
  assert.deepEqual(slots.byRowKey.get("activity-5-a"), [a]);
  assert.deepEqual(slots.byRowKey.get("activity-11-b"), [b, c]);
  assert.deepEqual(slots.trailing, []);
});

test("unplaced and orphaned artifacts trail the message once", () => {
  const a = artifact("a"), legacy = artifact("l"), orphan = artifact("o");
  const slots = htmlArtifactSlots(rows, [legacy, a, orphan], new Map([
    [a.mediaId, "call_a"], [orphan.mediaId, "call_missing"],
  ]));
  assert.deepEqual(slots.byRowKey.get("activity-5-a"), [a]);
  assert.deepEqual(slots.trailing, [legacy, orphan]);
});

test("legacy messages without presentation rows trail everything", () => {
  const a = artifact("a");
  const slots = htmlArtifactSlots(null, [a], new Map([[a.mediaId, "call_a"]]));
  assert.equal(slots.byRowKey.size, 0);
  assert.deepEqual(slots.trailing, [a]);
});

test("unchanged anchor lists keep their identity so memoized rows skip re-rendering", () => {
  const a = artifact("a"), b = artifact("b");
  const first = reuseUnchangedArtifactLists(undefined, new Map([["message:1", [a]], ["message:2", [b]]]));
  const recomputed = reuseUnchangedArtifactLists(first, new Map([["message:1", [{ ...a }]], ["message:2", [b]]]));
  assert.equal(recomputed.get("message:1"), first.get("message:1"));
  assert.equal(recomputed.get("message:2"), first.get("message:2"));

  const replaced = { ...a, id: "z".repeat(64) };
  const changed = reuseUnchangedArtifactLists(recomputed, new Map([["message:1", [replaced]], ["message:2", [b]]]));
  assert.notEqual(changed.get("message:1"), first.get("message:1"));
  assert.deepEqual(changed.get("message:1"), [replaced]);
  assert.equal(changed.get("message:2"), first.get("message:2"));

  const grown = reuseUnchangedArtifactLists(changed, new Map([["message:2", [b, a]]]));
  assert.equal(grown.has("message:1"), false);
  assert.deepEqual(grown.get("message:2"), [b, a]);
});
