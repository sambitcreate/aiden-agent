import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyDesignCommentDatabase,
  parseDesignCommentBody,
  parseDesignCommentDatabase,
  parseDesignCommentTarget,
  type DesignCommentTargetV1,
} from "./design-comment-contract.js";

const HASH_A = "a".repeat(64);

function generatedTarget(): DesignCommentTargetV1 {
  return {
    projectId: "project:one",
    lineageId: "lineage:hero",
    mediaId: "design:revision-one",
    element: {
      selector: '[data-aiden-id="hero"]',
      selectorMatchCount: 1,
      tagName: "section",
      elementId: "hero",
    },
    source: { kind: "generated-artifact", artifactId: HASH_A },
  };
}

test("comment target requires project, lineage, immutable revision, and exact selector/source identity", () => {
  assert.deepEqual(
    parseDesignCommentTarget(generatedTarget()),
    generatedTarget(),
  );
  assert.equal(
    parseDesignCommentTarget({ ...generatedTarget(), mediaId: undefined }),
    undefined,
  );
  assert.equal(
    parseDesignCommentTarget({
      ...generatedTarget(),
      element: { ...generatedTarget().element, selectorMatchCount: 2 },
    }),
    undefined,
  );
  assert.equal(
    parseDesignCommentTarget({
      ...generatedTarget(),
      source: { kind: "generated-artifact", artifactId: "not-a-hash" },
    }),
    undefined,
  );
  assert.equal(
    parseDesignCommentTarget({
      ...generatedTarget(),
      transientSelectionId: "guest",
    }),
    undefined,
  );
});

test("connected source identities are relative, hash/range pinned, and exact-key parsed", () => {
  const target = {
    ...generatedTarget(),
    source: {
      kind: "connected-source",
      workspaceId: "workspace:one",
      path: "src/Hero.tsx",
      sourceVersion: HASH_A,
      start: 10,
      end: 20,
      preimageHash: "b".repeat(64),
    },
  };
  assert.ok(parseDesignCommentTarget(target));
  assert.equal(
    parseDesignCommentTarget({
      ...target,
      source: { ...target.source, path: "../outside.tsx" },
    }),
    undefined,
  );
  assert.equal(
    parseDesignCommentTarget({
      ...target,
      source: { ...target.source, end: 10 },
    }),
    undefined,
  );
});

test("comment bodies and databases enforce control, count, duplicate, and byte bounds", () => {
  assert.equal(
    parseDesignCommentBody("Review this spacing."),
    "Review this spacing.",
  );
  assert.equal(
    parseDesignCommentBody("First point\nSecond point"),
    "First point\nSecond point",
  );
  assert.equal(parseDesignCommentBody(" padded "), undefined);
  assert.equal(parseDesignCommentBody("unsafe\0text"), undefined);
  assert.deepEqual(
    parseDesignCommentDatabase(emptyDesignCommentDatabase()),
    emptyDesignCommentDatabase(),
  );
  assert.equal(
    parseDesignCommentDatabase({
      version: 1,
      revision: 0,
      comments: [],
      extra: true,
    }),
    undefined,
  );
});
