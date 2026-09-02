import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseDesignDirectEdit,
  parseDesignDirectEditTarget,
  parseRendererDirectEditGestureId,
  parseRendererPrototypeGestureId,
  proposeDesignDirectEdit,
  type DesignDirectEditProofV1,
  type DesignDirectEditTargetV1,
} from "./design-direct-edit-core.js";

test("renderer prototype gesture IDs accept only canonical bounded UUID v4 identities", () => {
  const valid = "gesture:550e8400-e29b-41d4-a716-446655440000";
  assert.equal(parseRendererDirectEditGestureId(valid), valid);
  assert.equal(parseRendererPrototypeGestureId(valid), valid);
  for (const invalid of [
    "gesture:one",
    "gesture:550e8400-e29b-11d4-a716-446655440000",
    "gesture:550E8400-E29B-41D4-A716-446655440000",
    `${valid}:extra`,
    "550e8400-e29b-41d4-a716-446655440000",
  ]) {
    assert.equal(parseRendererPrototypeGestureId(invalid), undefined);
  }
});

const PROOF: DesignDirectEditProofV1 = {
  selectorMatchCount: 1,
  componentMatchCount: 1,
  literalDefinitionMatchCount: 1,
  computedClass: false,
  dynamicValue: false,
  localizedText: false,
  richText: false,
  semanticColorTokens: ["--surface-raised", "--text-primary"],
};

function prototypeTarget(): DesignDirectEditTargetV1 {
  return {
    origin: "prototype",
    projectId: "project:one",
    lineageId: "lineage:hero",
    mediaId: "design:revision-one",
    artifactId: "a".repeat(64),
    selection: {
      selector: '[data-aiden-id="hero"]',
      tagName: "section",
      elementId: "hero",
    },
    proof: PROOF,
  };
}

function connectedTarget(): Extract<
  DesignDirectEditTargetV1,
  { origin: "connected-app" }
> {
  const preimage = '<section data-aiden-id="hero">Hello</section>';
  return {
    origin: "connected-app",
    projectId: "project:one",
    lineageId: "lineage:hero",
    mediaId: "source-capture:one",
    workspaceId: "workspace:one",
    path: "src/Hero.tsx",
    sourceVersion: "b".repeat(64),
    start: 100,
    end: 100 + preimage.length,
    preimage,
    preimageHash: createHash("sha256").update(preimage).digest("hex"),
    selection: { selector: '[data-aiden-id="hero"]', tagName: "section" },
    proof: PROOF,
  };
}

test("literal matrix accepts bounded values and rejects unsafe CSS and markup text", () => {
  for (const edit of [
    { kind: "spacing", property: "padding", value: "16px" },
    { kind: "size", property: "width", value: "100%" },
    { kind: "alignment", property: "justify-content", value: "space-between" },
    { kind: "color-token", property: "color", token: "--text-primary" },
    { kind: "radius", property: "border-radius", value: "0.75rem" },
    { kind: "static-text", text: "Create account" },
  ]) {
    assert.ok(parseDesignDirectEdit(edit), JSON.stringify(edit));
  }
  for (const edit of [
    { kind: "spacing", property: "padding", value: "calc(1px + 2vw)" },
    { kind: "spacing", property: "padding", value: "var(--space)" },
    { kind: "size", property: "width", value: "101%" },
    { kind: "color-token", property: "color", token: "red" },
    { kind: "radius", property: "border-radius", value: "url(x)" },
    { kind: "static-text", text: "<strong>Rich</strong>" },
    { kind: "static-text", text: "{localized.label}" },
  ]) {
    assert.equal(parseDesignDirectEdit(edit), undefined, JSON.stringify(edit));
  }
});

test("targets fail closed for ambiguity, computed/dynamic bindings, repeated definitions, and bad preimages", () => {
  assert.ok(parseDesignDirectEditTarget(prototypeTarget()));
  for (const proof of [
    { ...PROOF, selectorMatchCount: 2 },
    { ...PROOF, componentMatchCount: 2 },
    { ...PROOF, literalDefinitionMatchCount: 2 },
    { ...PROOF, computedClass: true },
    { ...PROOF, dynamicValue: true },
    { ...PROOF, localizedText: true },
    { ...PROOF, richText: true },
    { ...PROOF, semanticColorTokens: ["red"] },
  ]) {
    assert.equal(
      parseDesignDirectEditTarget({ ...prototypeTarget(), proof }),
      undefined,
    );
  }
  assert.ok(parseDesignDirectEditTarget(connectedTarget()));
  assert.equal(
    parseDesignDirectEditTarget({
      ...connectedTarget(),
      preimageHash: "c".repeat(64),
    }),
    undefined,
  );
  assert.equal(
    parseDesignDirectEditTarget({
      ...connectedTarget(),
      path: "../secrets.tsx",
    }),
    undefined,
  );
});

test("one gesture deterministically maps to one proposal and undo identity without writing", () => {
  const edit = { kind: "spacing", property: "padding", value: "16px" } as const;
  const first = proposeDesignDirectEdit({
    gestureId: "gesture:one",
    target: prototypeTarget(),
    edit,
  });
  const replay = proposeDesignDirectEdit({
    gestureId: "gesture:one",
    target: prototypeTarget(),
    edit,
  });
  assert.deepEqual(replay, first);
  assert.equal(first.kind, "prototype-revision-request");
  assert.equal(first.mutationRule, "create-immutable-artifact-revision");
  assert.match(first.proposalId, /^proposal:[a-f0-9]{64}$/u);
  assert.equal(
    first.undoId.slice("undo:".length),
    first.proposalId.slice("proposal:".length),
  );
});

test("color proposals require membership in the bound semantic token snapshot", () => {
  assert.throws(
    () =>
      proposeDesignDirectEdit({
        gestureId: "gesture:unknown-token",
        target: prototypeTarget(),
        edit: {
          kind: "color-token",
          property: "color",
          token: "--not-in-snapshot",
        },
      }),
    /not present/u,
  );
});

test("connected proposal preserves exact hash/preimage binding for mandatory Designer Action review", () => {
  const target = connectedTarget();
  const proposal = proposeDesignDirectEdit({
    gestureId: "gesture:connected",
    target,
    edit: {
      kind: "color-token",
      property: "background-color",
      token: "--surface-raised",
    },
  });
  assert.equal(proposal.kind, "designer-action-request");
  if (proposal.kind !== "designer-action-request") return;
  assert.equal(proposal.mutationRule, "review-designer-action");
  assert.equal(proposal.sourceVersion, target.sourceVersion);
  assert.equal(proposal.preimage, target.preimage);
  assert.equal(proposal.preimageHash, target.preimageHash);
});
