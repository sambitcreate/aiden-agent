import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { detectUnverifiedSuccessClaim } from "./claim-check.js";
import type { AgentToolStep, GenerationTimeline } from "./generation-timeline.js";

function timeline(toolName: string, status: AgentToolStep["status"]): GenerationTimeline {
  return {
    version: 2,
    generationId: "generation-1",
    status: "completed",
    startedAt: 1,
    finishedAt: 2,
    steps: [
      {
        id: "tool-1",
        order: 0,
        kind: "tool",
        toolCallId: "call-1",
        toolName,
        label: toolName,
        status,
        startedAt: 1,
        updatedAt: 2,
        finishedAt: 2,
      },
    ],
  };
}

test("flags a success claim after a failed mutating tool", () => {
  assert.deepEqual(
    detectUnverifiedSuccessClaim("Done — I updated the file.", timeline("edit_file", "failed")),
    { kind: "unverified_success", stepIds: ["tool-1"] },
  );
  assert.deepEqual(
    detectUnverifiedSuccessClaim("The task is completed.", timeline("github__merge_pr", "failed")),
    { kind: "unverified_success", stepIds: ["tool-1"] },
  );
  assert.deepEqual(
    detectUnverifiedSuccessClaim(
      "Done — I updated the automation.",
      timeline("edit_automation", "failed"),
    ),
    { kind: "unverified_success", stepIds: ["tool-1"] },
  );
});

test("keeps completed and read-only failures quiet", () => {
  assert.equal(
    detectUnverifiedSuccessClaim("Done.", timeline("edit_file", "completed")),
    undefined,
  );
  assert.equal(detectUnverifiedSuccessClaim("Done.", timeline("read_file", "failed")), undefined);
});

test("does not mistake negative or qualified prose for false success", () => {
  const failed = timeline("run_command", "failed");
  assert.equal(detectUnverifiedSuccessClaim("I could not complete the task.", failed), undefined);
  assert.equal(
    detectUnverifiedSuccessClaim("I implemented the change, but the tests failed.", failed),
    undefined,
  );
  assert.equal(
    detectUnverifiedSuccessClaim(
      "The edit failed. I described an updated approach instead.",
      failed,
    ),
    undefined,
  );
  assert.equal(
    detectUnverifiedSuccessClaim("The edit failed. No files were updated.", failed),
    undefined,
  );
  assert.deepEqual(
    detectUnverifiedSuccessClaim("The tests failed, but the work is done.", failed),
    { kind: "unverified_success", stepIds: ["tool-1"] },
  );
});

test("associates a later failure acknowledgement with the failed action", () => {
  for (const content of [
    "Done — I updated the file. The tests failed.",
    "I implemented the change, but the tests failed.",
    "Done — I updated the file, but the tests did not pass.",
    "I saved the file; however, the build failed.",
    "I edited the file, though lint did not pass.",
  ]) {
    assert.deepEqual(
      detectUnverifiedSuccessClaim(content, timeline("edit_file", "failed")),
      { kind: "unverified_success", stepIds: ["tool-1"] },
      content,
    );
  }
  assert.equal(
    detectUnverifiedSuccessClaim(
      "Done — I updated the file, but the edit failed.",
      timeline("edit_file", "failed"),
    ),
    undefined,
  );
  assert.equal(
    detectUnverifiedSuccessClaim("Done, but the tests failed.", timeline("run_command", "failed")),
    undefined,
  );
});

test("ignores unrelated, hypothetical, and future completion prose", () => {
  const failed = timeline("edit_file", "failed");
  for (const content of [
    "I completed my review.",
    "This would be completed after you grant access.",
    "Once completed, the file will contain the new value.",
    "The task will be completed after approval.",
  ]) {
    assert.equal(detectUnverifiedSuccessClaim(content, failed), undefined, content);
  }
});

test("recognizes concise first-person and status-list success claims", () => {
  const failed = timeline("write_file", "failed");
  assert.deepEqual(detectUnverifiedSuccessClaim("I've saved the file.", failed), {
    kind: "unverified_success",
    stepIds: ["tool-1"],
  });
  assert.deepEqual(detectUnverifiedSuccessClaim("Files updated", failed), {
    kind: "unverified_success",
    stepIds: ["tool-1"],
  });
});

test("all generation settlement paths attach the structured claim check", () => {
  const source = readFileSync(
    new URL("../../main/services/llm-client.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.match(/attachClaimCheck\(/gu)?.length, 4);
  assert.doesNotMatch(source, /const finalTimeline = timeline\.finish/u);
});
