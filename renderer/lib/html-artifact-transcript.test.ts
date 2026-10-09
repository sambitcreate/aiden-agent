import assert from "node:assert/strict";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import type { AssistantPresentationRow } from "./assistant-message-presentation";
import { htmlArtifactSlots, reuseUnchangedArtifactLists } from "./html-artifact-transcript";

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
