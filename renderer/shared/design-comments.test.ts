import assert from "node:assert/strict";
import test from "node:test";
import {
  designCommentDisplayOrder,
  designCommentIsCurrent,
  designCommentTargetLabel,
  parseDesignCommentDraft,
  parseDesignCommentProjectView,
  parseDesignCommentTarget,
  type DesignCommentTargetV1,
  type DesignCommentV1,
} from "./design-comments.js";

const HASH_A = "a".repeat(64);

function target(): DesignCommentTargetV1 {
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

function comment(
  id: string,
  overrides: Partial<DesignCommentV1> = {},
): DesignCommentV1 {
  return {
    version: 1,
    id,
    revision: 1,
    target: target(),
    body: "Review this spacing.",
    status: "open",
    stale: false,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

test("renderer target parser keeps exact durable identity and rejects transient authority", () => {
  assert.deepEqual(parseDesignCommentTarget(target()), target());
  assert.equal(
    parseDesignCommentTarget({ ...target(), selectionId: "temporary" }),
    undefined,
  );
  assert.equal(
    parseDesignCommentTarget({
      ...target(),
      element: { ...target().element, selectorMatchCount: 2 },
    }),
    undefined,
  );
  assert.equal(
    parseDesignCommentTarget({
      ...target(),
      source: { kind: "generated-artifact", artifactId: "short" },
    }),
    undefined,
  );
});

test("renderer projection is exact-key, bounded, duplicate-safe, and internally consistent", () => {
  const current = comment("comment:one");
  assert.deepEqual(
    parseDesignCommentProjectView(
      { databaseRevision: 1, comments: [current] },
      "project:one",
    ),
    {
      databaseRevision: 1,
      comments: [current],
    },
  );
  assert.equal(
    parseDesignCommentProjectView(
      {
        databaseRevision: 1,
        comments: [current],
        capability: "leak",
      },
      "project:one",
    ),
    undefined,
  );
  assert.equal(
    parseDesignCommentProjectView(
      {
        databaseRevision: 1,
        comments: [current, current],
      },
      "project:one",
    ),
    undefined,
  );
  assert.equal(
    parseDesignCommentProjectView(
      {
        databaseRevision: 1,
        comments: [{ ...current, status: "resolved" }],
      },
      "project:one",
    ),
    undefined,
  );
  assert.equal(
    parseDesignCommentProjectView(
      { databaseRevision: 1, comments: [current] },
      "project:other",
    ),
    undefined,
  );
});

test("draft parser rejects padding, controls, oversize text, and rich transient data", () => {
  assert.equal(
    parseDesignCommentDraft("Review the selected element."),
    "Review the selected element.",
  );
  assert.equal(
    parseDesignCommentDraft("First point\nSecond point"),
    "First point\nSecond point",
  );
  assert.equal(parseDesignCommentDraft(" padded "), undefined);
  assert.equal(parseDesignCommentDraft("bad\0comment"), undefined);
  assert.equal(parseDesignCommentDraft("x".repeat(4_001)), undefined);
});

test("helpers preserve open-first review order and exact current-target semantics", () => {
  const open = comment("comment:open", { updatedAt: 20 });
  const stale = comment("comment:stale", {
    stale: true,
    staleAt: 30,
    updatedAt: 30,
  });
  const resolved = comment("comment:resolved", {
    status: "resolved",
    resolvedAt: 40,
    updatedAt: 40,
  });
  assert.deepEqual(
    designCommentDisplayOrder([resolved, stale, open]).map(({ id }) => id),
    ["comment:open", "comment:stale", "comment:resolved"],
  );
  assert.equal(designCommentIsCurrent(open, target()), true);
  assert.equal(designCommentIsCurrent(stale, target()), false);
  assert.match(
    designCommentTargetLabel(target()),
    /section#hero on saved revision/u,
  );
});

test("connected target labels expose only a relative source path", () => {
  const connected: DesignCommentTargetV1 = {
    ...target(),
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
  assert.ok(parseDesignCommentTarget(connected));
  assert.equal(
    designCommentTargetLabel(connected),
    "section#hero in src/Hero.tsx",
  );
  assert.equal(
    parseDesignCommentTarget({
      ...connected,
      source: { ...connected.source, path: "/Users/example/private/Hero.tsx" },
    }),
    undefined,
  );
});
