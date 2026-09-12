import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import { inspectDesignProjectHealth } from "./design-project-health.js";
import { OMITTED_DESIGN_HTML_SENTINEL } from "./generative-ui-html.js";

const VALID_HTML = "<!doctype html><html><body><main>Saved design</main></body></html>";

function artifact(mediaId: string, html: string, parent?: string): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id: createHash("sha256").update(html).digest("hex"),
    title: "Checkout",
    mimeType: "text/html",
    size: Buffer.byteLength(html, "utf8"),
    mediaId,
    ...(parent ? { revisionOfMediaId: parent } : {}),
  };
}

function project(
  mediaIds: string[],
  activeMediaId = mediaIds[mediaIds.length - 1],
): DesignProjectSnapshotV1 {
  return {
    version: 1,
    id: "project:health",
    revision: 1,
    title: "Health",
    chatId: "chat:health",
    connectionState: "prototype-only",
    createdAt: 1,
    updatedAt: 1,
    referenceAssetIds: [],
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: "node:health",
          kind: "artboard",
          canonicalOrigin: "generated-artifact",
          lineageId: "lineage:health",
          artifactMediaIds: mediaIds,
          ...(activeMediaId ? { activeMediaId } : {}),
          x: 0,
          y: 0,
        },
      ],
    },
  };
}

test("semantic artifact health rejects the exact omitted-HTML sentinel", async () => {
  const source = {
    artifact: artifact("design:broken", OMITTED_DESIGN_HTML_SENTINEL),
    html: OMITTED_DESIGN_HTML_SENTINEL,
  };
  assert.deepEqual(
    await inspectDesignProjectHealth(project(["design:broken"]), {
      artifactSource: async () => source,
      hasReferenceAsset: async () => true,
    }),
    {
      health: "needs-repair",
      recoveryMessage:
        "A saved artboard revision is incomplete. Its history was preserved for repair.",
      recoveryAction: "recover-artifact",
    },
  );
});

test("semantic artifact health distinguishes missing and hash-corrupt revisions", async () => {
  const missing = await inspectDesignProjectHealth(project(["design:missing"]), {
    artifactSource: async () => undefined,
    hasReferenceAsset: async () => true,
  });
  assert.match(missing.recoveryMessage ?? "", /missing/iu);

  const corrupt = artifact("design:corrupt", VALID_HTML);
  corrupt.id = "0".repeat(64);
  const damaged = await inspectDesignProjectHealth(project(["design:corrupt"]), {
    artifactSource: async () => ({ artifact: corrupt, html: VALID_HTML }),
    hasReferenceAsset: async () => true,
  });
  assert.match(damaged.recoveryMessage ?? "", /incomplete/iu);
});

test("a valid immutable descendant repairs health across restart without deleting history", async () => {
  const sources = new Map([
    [
      "design:broken",
      {
        artifact: artifact("design:broken", OMITTED_DESIGN_HTML_SENTINEL),
        html: OMITTED_DESIGN_HTML_SENTINEL,
      },
    ],
    [
      "design:recovered",
      {
        artifact: artifact("design:recovered", VALID_HTML, "design:broken"),
        html: VALID_HTML,
      },
    ],
  ]);
  const restartedProjection = project(["design:broken", "design:recovered"], "design:recovered");
  assert.deepEqual(
    await inspectDesignProjectHealth(restartedProjection, {
      artifactSource: async (_chatId, mediaId) => sources.get(mediaId),
      hasReferenceAsset: async () => true,
    }),
    { health: "ready" },
  );
  assert.deepEqual(restartedProjection.canvas.nodes[0]?.artifactMediaIds, [
    "design:broken",
    "design:recovered",
  ]);
});
