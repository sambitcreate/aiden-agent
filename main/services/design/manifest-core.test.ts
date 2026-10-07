import assert from "node:assert/strict";
import test from "node:test";
import { createDesignProjectManifest, parseDesignProjectManifestV1 } from "./manifest-core.js";

const SHA = "a".repeat(64);
const MODEL = { providerId: "openrouter", model: "model-a" };

function manifestFixture() {
  return {
    schema: 1,
    id: "project-1",
    revision: 3,
    title: "Checkout",
    chatId: "chat-1",
    state: "active",
    createdAt: 1_000,
    updatedAt: 2_000,
    canvas: {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: "node-1", kind: "screen", screenId: "screen-1", x: 0, y: 0 }],
    },
    screens: {
      "screen-1": {
        id: "screen-1",
        title: "Cart",
        frame: { preset: "desktop", width: 1440, height: 1024 },
        revisionIds: ["rev-1", "rev-2"],
        activeRevisionId: "rev-1",
        directionSetId: "set-1",
        createdAt: 1_100,
      },
    },
    revisions: {
      "rev-1": {
        id: "rev-1", screenId: "screen-1", runId: "run-1", toolCallId: "call_1", title: "Cart",
        bytes: 120, sha256: SHA, state: "published", createdAt: 1_100, model: MODEL,
      },
      "rev-2": {
        id: "rev-2", screenId: "screen-1", parentRevisionId: "rev-1", runId: "run-2",
        toolCallId: "call_2|fc_2", title: "Cart", bytes: 140, sha256: SHA, state: "draft",
        createdAt: 1_200, model: MODEL,
      },
    },
    directionSets: {
      "set-1": { id: "set-1", runId: "run-1", requestedCount: 2, screenIds: ["screen-1"], archived: false },
    },
    runs: {
      "run-1": {
        id: "run-1", kind: "explore", turnId: "turn-1",
        request: { op: "explore", count: 2, creativeRange: "balanced", aspects: ["layout"] },
        outputCap: 2, status: "partial", endReason: "stopped", directionSetId: "set-1",
        promptMessageId: "message_1", revisionIds: ["rev-1"], startedAt: 1_050, endedAt: 1_150,
      },
      "run-2": {
        id: "run-2", kind: "refine", turnId: "turn-2",
        request: { op: "refine", screenId: "screen-1", baseRevisionId: "rev-1" },
        outputCap: 1, status: "cancelled", revisionIds: ["rev-2"], startedAt: 1_190, endedAt: 1_210,
      },
    },
  };
}

test("a v1 manifest round-trips through JSON unchanged", () => {
  const fixture = manifestFixture();
  assert.deepEqual(parseDesignProjectManifestV1(JSON.parse(JSON.stringify(fixture))), fixture);
});

test("a new project manifest is valid and empty", () => {
  const created = createDesignProjectManifest({ id: "p-1", chatId: "c-1", title: "Landing", now: 5 });
  assert.deepEqual(parseDesignProjectManifestV1(created), created);
  assert.equal(created.revision, 1);
  assert.deepEqual(Object.keys(created.screens), []);
});

test("broken cross references and foreign shapes are rejected, never repaired", () => {
  const corruptions: Array<[string, (m: ReturnType<typeof manifestFixture>) => void]> = [
    ["schema 2", (m) => { (m as { schema: number }).schema = 2; }],
    ["unknown top-level key", (m) => { (m as Record<string, unknown>).designLanguage = {}; }],
    ["path-like id", (m) => { m.id = "../escape"; }],
    ["node points at a missing Screen", (m) => { m.canvas.nodes[0]!.screenId = "screen-9"; }],
    ["Screen without a node", (m) => { m.canvas.nodes = []; }],
    ["Screen lists a missing revision", (m) => { m.screens["screen-1"]!.revisionIds.push("rev-9"); }],
    ["active revision outside its Screen", (m) => { m.screens["screen-1"]!.activeRevisionId = "rev-9"; }],
    ["record key differs from id", (m) => {
      const revisions = m.revisions as Record<string, unknown>;
      revisions["rev-x"] = revisions["rev-1"];
      delete revisions["rev-1"];
    }],
    ["chosen Screen outside its set", (m) => { (m.directionSets["set-1"] as Record<string, unknown>).chosenScreenId = "screen-9"; }],
    ["run claims another run's revision", (m) => { m.runs["run-1"]!.revisionIds.push("rev-2"); }],
    ["uppercase digest", (m) => { m.revisions["rev-1"]!.sha256 = "A".repeat(64); }],
    ["oversized revision", (m) => { m.revisions["rev-1"]!.bytes = 256 * 1024 + 1; }],
    ["unknown revision state", (m) => { (m.revisions["rev-1"] as { state: string }).state = "archived"; }],
    ["revision not listed by its Screen", (m) => { m.screens["screen-1"]!.revisionIds = ["rev-1"]; }],
    ["end reason on a run that is not partial", (m) => { (m.runs["run-2"] as Record<string, unknown>).endReason = "stopped"; }],
    ["unknown end reason", (m) => { (m.runs["run-1"] as Record<string, unknown>).endReason = "bored"; }],
    ["run fills a missing direction set", (m) => { m.runs["run-1"]!.directionSetId = "set-9"; }],
    ["Refine run with a direction set", (m) => { (m.runs["run-2"] as Record<string, unknown>).directionSetId = "set-1"; }],
    ["tool call id with a C1 control", (m) => { m.revisions["rev-1"]!.toolCallId = "call\u0085_1"; }],
    ["title with a bidi override", (m) => { m.screens["screen-1"]!.title = "Cart\u202e"; }],
    ["model id with a lone surrogate", (m) => { m.revisions["rev-1"]!.model.model = "model\ud800"; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const manifest = manifestFixture();
    corrupt(manifest);
    assert.equal(parseDesignProjectManifestV1(manifest), undefined, label);
  }
});
