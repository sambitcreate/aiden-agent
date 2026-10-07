import assert from "node:assert/strict";
import test from "node:test";
import { assertGenerationProfileTools, resolveGenerationProfile } from "./generation-profile.js";

const owner = { kind: "design-project", projectId: "project-1" } as const;
const binding = { projectId: "project-1", runId: "run-1" };

test("ordinary chats keep the default profile and refuse a design binding", () => {
  assert.deepEqual(resolveGenerationProfile({}, {}), { kind: "default" });
  assert.throws(() => resolveGenerationProfile({}, { designRun: binding }), /Design project conversation/u);
});

test("a design-owned chat runs only with its own project's binding", () => {
  assert.deepEqual(resolveGenerationProfile({ owner }, { designRun: binding }), {
    kind: "design",
    projectId: "project-1",
    runId: "run-1",
    toolAllowlist: ["render_artifact"],
  });
  // A renderer chat:start carries no binding, so the hidden chat never becomes a workspace chat.
  assert.throws(() => resolveGenerationProfile({ owner }, {}), /belongs to a Design project/u);
  assert.throws(
    () => resolveGenerationProfile({ owner }, { designRun: { projectId: "project-2", runId: "run-1" } }),
    /belongs to a Design project/u,
  );
});

test("the design profile admits render_artifact and nothing else", () => {
  const design = resolveGenerationProfile({ owner }, { designRun: binding });
  assertGenerationProfileTools(design, ["render_artifact"]);
  assert.throws(
    () => assertGenerationProfileTools(design, ["render_artifact", "read", "bash", "read"]),
    /cannot expose: bash, read\./u,
  );
  assertGenerationProfileTools({ kind: "default" }, ["bash", "read"]);
});
