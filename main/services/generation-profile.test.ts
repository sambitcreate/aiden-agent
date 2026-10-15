import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGenerationProfileTools,
  resolveGenerationProfile,
  selectRuntimeExtensions,
  type GenerationProfile,
} from "./generation-profile.js";

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
    extensionIds: ["aiden.design.render"],
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

test("a design run composes only its own extension, even when advisor and codemode are offered", () => {
  const design: GenerationProfile = {
    kind: "design",
    projectId: "project-1",
    runId: "run-1",
    toolAllowlist: ["render_artifact"],
    extensionIds: ["aiden.design.render"],
  };
  const designExtension = { id: "design" };
  assert.deepEqual(
    selectRuntimeExtensions(design, { base: [designExtension], advisor: { id: "advisor" }, codemode: { id: "codemode" } }),
    [designExtension],
  );
});

test("the default profile keeps base, advisor, then codemode in order and omits absent ones", () => {
  const base = [{ id: "a" }, { id: "b" }];
  const advisor = { id: "advisor" };
  const codemode = { id: "codemode" };
  assert.deepEqual(
    selectRuntimeExtensions({ kind: "default" }, { base, advisor, codemode }),
    [...base, advisor, codemode],
  );
  assert.deepEqual(selectRuntimeExtensions({ kind: "default" }, { base, advisor: null, codemode: undefined }), base);
});
