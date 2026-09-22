import assert from "node:assert/strict";
import test from "node:test";
import { createImagesFixture } from "../../create-images/fixtures.js";
import {
  normalizeCreateImagesWorkflowProposalRequest,
  parseCreateImagesWorkflowProposal,
} from "./workflow-proposal.js";

const current = createImagesFixture("starter")!;

function proposal(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    nodes: [
      {
        id: "prompt-proposed",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { text: "A quiet moonlit lake" },
      },
      {
        id: "generate-proposed",
        type: "generate-image",
        position: { x: 340, y: 0 },
        data: {
          providerId: "gemini",
          modelId: "gemini-3.1-flash-image",
          aspectRatio: "1:1",
          imageSize: "1K",
          outputMime: "image/png",
          count: 1,
        },
      },
      {
        id: "output-proposed",
        type: "output",
        position: { x: 680, y: 0 },
        data: {},
      },
    ],
    edges: [
      {
        id: "prompt-to-generate",
        source: "prompt-proposed",
        sourcePort: "text",
        target: "generate-proposed",
        targetPort: "prompt",
      },
      {
        id: "generate-to-output",
        source: "generate-proposed",
        sourcePort: "images",
        target: "output-proposed",
        targetPort: "images",
      },
    ],
    ...overrides,
  });
}

test("workflow proposals use the production graph/schema and return a complete bounded diff", () => {
  const parsed = parseCreateImagesWorkflowProposal(proposal(), current);
  assert.equal(parsed.status, "ready");
  if (parsed.status !== "ready") return;
  assert.equal(parsed.proposal.workflow.id, current.id);
  assert.equal(parsed.proposal.workflow.revision, current.revision + 1);
  assert.deepEqual(parsed.proposal.workflow.assetRefs, []);
  assert.equal(parsed.proposal.diff.maximumImageRequests, 1);
  assert.deepEqual(parsed.proposal.diff.cost, { kind: "unknown" });
  assert.ok(parsed.proposal.diff.nodesAdded > 0);
  assert.ok(parsed.proposal.diff.nodesRemoved > 0);
});

test("workflow proposals fail closed for paths, secrets, code, assets, cycles, unsupported models, and oversized graphs", () => {
  for (const text of [
    proposal({ credential: "secret" }),
    proposal({ note: "/Users/example/private.png" }),
    proposal({ note: "```js\nalert(1)\n```" }),
    proposal({ nodes: [{ id: "image-1", type: "image-input", position: { x: 0, y: 0 }, data: { assetId: "a".repeat(64) } }] }),
    proposal({ nodes: Array.from({ length: 51 }, (_, index) => ({ id: `prompt-${index}`, type: "prompt", position: { x: index, y: 0 }, data: { text: "x" } })), edges: [] }),
  ]) {
    assert.equal(parseCreateImagesWorkflowProposal(text, current).status, "invalid");
  }
  const decoded = JSON.parse(proposal()) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  const generation = decoded.nodes[1]!;
  generation.data = { ...(generation.data as object), modelId: "arbitrary-image-model" };
  assert.equal(parseCreateImagesWorkflowProposal(JSON.stringify(decoded), current).status, "invalid");
  decoded.nodes[1]!.data = {
    ...(decoded.nodes[1]!.data as object),
    modelId: "gemini-3.1-flash-image",
  };
  decoded.edges.push({
    id: "cycle",
    source: "generate-proposed",
    sourcePort: "images",
    target: "generate-proposed",
    targetPort: "references",
  });
  assert.equal(parseCreateImagesWorkflowProposal(JSON.stringify(decoded), current).status, "invalid");
});

test("workflow proposal requests are normalized and bounded", () => {
  assert.equal(normalizeCreateImagesWorkflowProposalRequest("  Build a portrait flow\r\n"), "Build a portrait flow");
  assert.equal(normalizeCreateImagesWorkflowProposalRequest(""), undefined);
  assert.equal(normalizeCreateImagesWorkflowProposalRequest("x".repeat(4_001)), undefined);
});
