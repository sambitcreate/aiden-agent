import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolStep, GenerationTimeline } from "./generation-timeline.js";
import { withInferredImagePlacements } from "./image-placements.js";

function step(toolCallId: string, toolName: string, status: AgentToolStep["status"] = "completed"): AgentToolStep {
  return { id: toolCallId, order: 0, kind: "tool", toolCallId, toolName, label: toolName, status, startedAt: 1, updatedAt: 1 };
}

function timeline(...steps: AgentToolStep[]): GenerationTimeline {
  return { version: 3, generationId: "g", status: "completed", startedAt: 1, finishedAt: 2, steps };
}

const image = (id: string) => ({ id, kind: "image" });

test("old replies pair each source's unplaced images with its own calls, in order", () => {
  const placements = withInferredImagePlacements(
    timeline(step("call-1", "display_image"), step("call-2", "share_image"), step("call-3", "display_image")),
    // Saved order: shared images first, then shown ones.
    [image("shared_a"), image("shown-1"), image("shown-2")],
    new Map(),
  );
  assert.deepEqual(Object.fromEntries(placements), { "shared_a": "call-2", "shown-1": "call-1", "shown-2": "call-3" });
});

test("a call that already owns an image, a failed call and a visual snapshot never take part", () => {
  const placements = withInferredImagePlacements(
    timeline(
      step("call-1", "generate_image"),
      step("call-2", "display_image", "failed"),
      step("call-3", "display_image"),
    ),
    [image("generated"), image(`visual-snapshot_${"a".repeat(64)}`), image("shown")],
    new Map([["generated", "call-1"]]),
  );
  assert.deepEqual(Object.fromEntries(placements), { generated: "call-1", shown: "call-3" });
});

test("a source whose images and calls do not match one for one infers nothing", () => {
  const stored = new Map<string, string>();
  const placements = withInferredImagePlacements(
    timeline(step("call-1", "display_image"), step("call-2", "display_image"), step("call-3", "share_image")),
    [image("shown"), image("shared_a")],
    stored,
  );
  assert.deepEqual(Object.fromEntries(placements), { "shared_a": "call-3" }, "the shared image still pairs");
  assert.equal(withInferredImagePlacements(undefined, [image("shown")], stored), stored);
});
