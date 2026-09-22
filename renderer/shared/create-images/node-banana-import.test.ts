import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowGraph } from "./ports.js";
import { parseWorkflowDocument } from "./schema.js";
import {
  CreateImagesNodeBananaImportError,
  convertNodeBananaWorkflow,
} from "./node-banana-import.js";

function ids(): () => string {
  let next = 0;
  return () => `imported-${++next}`;
}

test("Node Banana conversion maps the supported image graph and externalizes inline media", () => {
  const converted = convertNodeBananaWorkflow(
    {
      version: 1,
      name: "Node Banana edit",
      directoryPath: "/private/source",
      providerSettings: { apiKey: "must-not-survive" },
      nodes: [
        {
          id: "image-1",
          type: "imageInput",
          position: { x: 10, y: 20 },
          data: {
            filename: "reference.webp",
            image: "data:image/webp;base64,UklGRgAAAAA=",
            imageRef: "/private/reference.webp",
          },
        },
        {
          id: "prompt-1",
          type: "prompt",
          position: { x: 10, y: 200 },
          data: { prompt: "Turn it yellow" },
        },
        {
          id: "generation-1",
          type: "nanoBanana",
          position: { x: 380, y: 100 },
          data: {
            aspectRatio: "16:9",
            resolution: "2K",
            selectedModel: {
              provider: "gemini",
              modelId: "gemini-3.1-flash-image-preview",
              apiKey: "must-not-survive",
            },
            outputImage: "data:image/png;base64,AAAA",
            parameters: { secret: "must-not-survive" },
          },
        },
        {
          id: "output-1",
          type: "outputGallery",
          position: { x: 760, y: 100 },
          data: { images: ["data:image/png;base64,AAAA"] },
        },
        {
          id: "audio-1",
          type: "generateAudio",
          position: { x: 900, y: 300 },
          data: { credential: "must-not-survive" },
        },
      ],
      edges: [
        {
          id: "image-edge",
          source: "image-1",
          sourceHandle: "image",
          target: "generation-1",
          targetHandle: "image",
        },
        {
          id: "prompt-edge",
          source: "prompt-1",
          sourceHandle: "text",
          target: "generation-1",
          targetHandle: "text",
        },
        {
          id: "output-edge",
          source: "generation-1",
          sourceHandle: "image",
          target: "output-1",
          targetHandle: "image",
        },
        { id: "unsupported-edge", source: "audio-1", target: "output-1" },
      ],
    },
    {
      workflowId: "workflow-imported",
      now: "2026-08-19T12:00:00.000Z",
      nextId: ids(),
    },
  );

  assert.equal(parseWorkflowDocument(converted.workflow).success, true);
  assert.deepEqual(
    converted.workflow.nodes.map((node) => node.type),
    ["image-input", "prompt", "generate-image", "output-gallery"],
  );
  assert.equal(converted.workflow.edges.length, 3);
  assert.deepEqual(converted.workflow.assetRefs, []);
  assert.equal(converted.inlineImages.length, 1);
  assert.equal(converted.inlineImages[0]?.mediaType, "image/webp");
  assert.equal(converted.report.skippedNodeCount, 1);
  assert.equal(converted.report.skippedEdgeCount, 1);
  assert.equal(converted.report.entries.length, 5);
  assert.equal(
    converted.report.entries.some(
      (entry) => entry.sourceType === "generateAudio" && entry.action === "skipped",
    ),
    true,
  );
  const serialized = JSON.stringify(converted.workflow);
  assert.equal(serialized.includes("must-not-survive"), false);
  assert.equal(serialized.includes("/private/"), false);
  assert.equal(serialized.includes("data:image"), false);
  assert.deepEqual(
    validateWorkflowGraph(converted.workflow).filter(
      (issue) => !["missing_asset", "missing_provider", "missing_model"].includes(issue.code),
    ),
    [],
  );
});

test("Node Banana conversion rejects unsupported versions and bounded graph overflow", () => {
  const input = {
    workflowId: "workflow-imported",
    now: "2026-08-19T12:00:00.000Z",
    nextId: ids(),
  };
  assert.throws(
    () => convertNodeBananaWorkflow({ version: 2, nodes: [], edges: [] }, input),
    CreateImagesNodeBananaImportError,
  );
  assert.throws(
    () =>
      convertNodeBananaWorkflow(
        { version: 1, nodes: Array.from({ length: 501 }, () => ({})), edges: [] },
        input,
      ),
    /graph limits/u,
  );
});
