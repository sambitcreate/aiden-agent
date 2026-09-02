import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { CHAT_ARTIFACT_VERSION } from "../../renderer/shared/chat-artifacts.js";
import { HTML_ARTIFACT_MIME_TYPE } from "../../renderer/shared/generative-ui.js";
import type { DesignProjectSnapshotV1 } from "./design-project-contract.js";
import { newArtboardOwnership } from "./design-generated-revision-contract.js";
import type { CommittedGenerativeUiRecoverySource } from "./generative-ui-artifact-store.js";
import {
  isUsablePublishedDesignSource,
  latestActiveDesignArtifact,
  projectOwnsDesignMedia,
  projectOwnsPublishedDesignSource,
  requireCommittedDesignContextHtml,
} from "./design-generation-context.js";
import { isUsableLiveDesignCandidateSource } from "./design-artifact-source-authority.js";

const HTML = "<!doctype html><html><body>valid</body></html>";

function artifact(mediaId: string, html = HTML): ChatHtmlArtifactV1 {
  return {
    version: CHAT_ARTIFACT_VERSION,
    kind: "html",
    id: createHash("sha256").update(html).digest("hex"),
    title: mediaId,
    mimeType: HTML_ARTIFACT_MIME_TYPE,
    size: Buffer.byteLength(html),
    mediaId,
  };
}

function project(activeMediaId?: string, lineageId = "lineage:context"): DesignProjectSnapshotV1 {
  return {
    version: 1,
    id: "project:context",
    revision: 1,
    title: "Context",
    chatId: "chat:context",
    connectionState: "prototype-only",
    createdAt: 1,
    updatedAt: 1,
    canvas: {
      viewport: "desktop",
      flowViewport: { x: 0, y: 0, zoom: 1 },
      nodes: activeMediaId
        ? [
            {
              id: "node:context",
              kind: "artboard",
              canonicalOrigin: "generated-artifact",
              x: 0,
              y: 0,
              lineageId,
              artifactMediaIds: [activeMediaId],
              activeMediaId,
            },
          ]
        : [],
    },
    referenceAssetIds: [],
  };
}

function recoverySource(
  item: ChatHtmlArtifactV1,
  publication?: CommittedGenerativeUiRecoverySource["designPublication"],
): CommittedGenerativeUiRecoverySource {
  const ownership = newArtboardOwnership("project:context", item.mediaId);
  return {
    chatId: "chat:context",
    generationId: "generation:context",
    artifact: item,
    html: HTML,
    createdAt: 1,
    ...(publication ? { designOwnership: ownership, designPublication: publication } : {}),
  };
}

test("implicit Design context ignores later removed or suppressed transcript artifacts", () => {
  const owned = artifact("design:owned");
  const suppressed = artifact("design:suppressed");
  const chat = {
    messages: [
      { role: "assistant", htmlArtifacts: [owned] },
      { role: "assistant", htmlArtifacts: [suppressed] },
    ],
  };
  assert.equal(latestActiveDesignArtifact(chat, project(owned.mediaId))?.mediaId, owned.mediaId);
  assert.equal(latestActiveDesignArtifact(chat, project()), undefined);
  assert.equal(projectOwnsDesignMedia(project(owned.mediaId), suppressed.mediaId), false);
});

test("preview and export authority requires exact published project and lineage membership", () => {
  const item = artifact("design:published");
  const published = recoverySource(item, "published");
  const lineageId = published.designOwnership!.lineageId;
  const owner = project(item.mediaId, lineageId);

  assert.equal(projectOwnsPublishedDesignSource(owner, published), true);
  assert.equal(isUsablePublishedDesignSource(owner, published), true);
  for (const publication of ["candidate", "eligible", "suppressed"] as const) {
    assert.equal(
      projectOwnsPublishedDesignSource(owner, recoverySource(item, publication)),
      false,
      `${publication} Design bytes must not be previewable or exportable`,
    );
    assert.equal(isUsablePublishedDesignSource(owner, recoverySource(item, publication)), false);
  }
  assert.equal(
    projectOwnsPublishedDesignSource(project(item.mediaId, "lineage:other"), published),
    false,
  );
  assert.equal(
    projectOwnsPublishedDesignSource({ ...owner, id: "project:other" }, published),
    false,
  );
  assert.equal(
    projectOwnsPublishedDesignSource(owner, {
      ...published,
      chatId: "chat:other",
    }),
    false,
  );
});

test("live candidate preview authority is pending-only and exact to its project lineage", () => {
  const item = artifact("design:live");
  const candidate = {
    version: 1 as const,
    chatId: "chat:context",
    generationId: "generation:live",
    artifact: item,
    html: HTML,
    committed: false,
    stagedAt: 1,
    designOwnership: newArtboardOwnership("project:context", item.mediaId),
    designPublication: "candidate" as const,
  };

  assert.equal(isUsableLiveDesignCandidateSource(project(), candidate), true);
  assert.equal(isUsableLiveDesignCandidateSource(project(), { ...candidate, committed: true }), false);
  assert.equal(
    isUsableLiveDesignCandidateSource(project(), {
      ...candidate,
      designPublication: "eligible",
    }),
    false,
  );
  assert.equal(
    isUsableLiveDesignCandidateSource({ ...project(), id: "project:other" }, candidate),
    false,
  );

  const base = project("design:base", "lineage:live");
  const revision = {
    ...candidate,
    artifact: { ...item, revisionOfMediaId: "design:base" },
    designOwnership: {
      version: 1 as const,
      kind: "revision" as const,
      projectId: base.id,
      lineageId: "lineage:live",
      baseMediaId: "design:base",
    },
  };
  assert.equal(isUsableLiveDesignCandidateSource(base, revision), true);
  assert.equal(
    isUsableLiveDesignCandidateSource(project("design:newer", "lineage:live"), revision),
    false,
  );
});

test("legacy Design rows fall back only when exact project membership is unannotated", () => {
  const item = artifact("design:legacy");
  const legacy = recoverySource(item);
  assert.equal(projectOwnsPublishedDesignSource(project(item.mediaId), legacy), true);
  assert.equal(projectOwnsPublishedDesignSource(project(), legacy), false);
  assert.equal(
    projectOwnsPublishedDesignSource(project(item.mediaId), {
      ...legacy,
      designPublication: "published",
    }),
    false,
    "partially annotated rows fail closed",
  );
});

test("provider Design context requires committed exact and semantically valid bytes", () => {
  const expected = artifact("design:owned");
  assert.equal(
    requireCommittedDesignContextHtml(expected, recoverySource(expected)),
    HTML,
  );
  assert.throws(
    () => requireCommittedDesignContextHtml(expected, undefined),
    /no longer available/iu,
  );
  assert.throws(
    () =>
      requireCommittedDesignContextHtml(expected, {
        ...recoverySource(expected),
        html: `${HTML} `,
      }),
    /damaged/iu,
  );
  assert.throws(
    () =>
      requireCommittedDesignContextHtml(expected, {
        ...recoverySource(expected),
        artifact: { ...expected, title: "mismatched" },
      }),
    /damaged/iu,
  );
});

test("provider Design context rejects exact committed bytes until project publication", () => {
  const expected = artifact("design:owned");
  const eligible = recoverySource(expected, "eligible");
  const owner = project(expected.mediaId, eligible.designOwnership!.lineageId);
  assert.throws(
    () => requireCommittedDesignContextHtml(expected, eligible, owner),
    /damaged/iu,
  );
  assert.equal(
    requireCommittedDesignContextHtml(expected, recoverySource(expected, "published"), owner),
    HTML,
  );
  assert.throws(
    () => requireCommittedDesignContextHtml(expected, recoverySource(expected, "published")),
    /damaged/iu,
    "modern ownership metadata requires an exact durable project even without an explicit target",
  );
});
