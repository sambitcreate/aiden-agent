import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFirstPublishedScreenTitle,
  applyManualDesignProjectTitle,
  createDesignProjectTitleState,
  migrateDesignProjectTitleStateFromV1,
  migrateDesignScreenPresentationFromViewport,
  normalizeDesignProjectTitlePolicyV2,
  normalizeDesignProjectTitleStateV2,
  normalizeDesignScreenPresentationV2,
} from "./design-project-v2-policy.js";

test("blank projects are auto-eligible while explicit and migrated titles are manual", () => {
  assert.deepEqual(createDesignProjectTitleState({ origin: "blank" }), {
    title: "Untitled Design",
    titlePolicy: { state: "auto-eligible" },
  });
  assert.deepEqual(createDesignProjectTitleState({ origin: "manual", title: "  Checkout  " }), {
    title: "Checkout",
    titlePolicy: { state: "manual" },
  });
  assert.deepEqual(migrateDesignProjectTitleStateFromV1("Legacy concept"), {
    title: "Legacy concept",
    titlePolicy: { state: "manual" },
  });
  assert.throws(
    () => createDesignProjectTitleState({ origin: "blank", title: "Not a placeholder" }),
    /Only the blank/u,
  );
});

test("only the first successful Screen publication can apply an automatic title", () => {
  const eligible = createDesignProjectTitleState({ origin: "blank" });
  const unchangedWithoutScreen = applyFirstPublishedScreenTitle({
    current: eligible,
    candidateTitle: "Checkout",
    successfulScreenCountBefore: 0,
    successfulScreenCountAfter: 0,
    sourceLineageId: "lineage:checkout",
    sourceMediaId: "design:checkout",
  });
  assert.equal(unchangedWithoutScreen, eligible);

  const applied = applyFirstPublishedScreenTitle({
    current: eligible,
    candidateTitle: "  Checkout flow  ",
    successfulScreenCountBefore: 0,
    successfulScreenCountAfter: 1,
    sourceLineageId: "lineage:checkout",
    sourceMediaId: "design:checkout",
  });
  assert.deepEqual(applied, {
    title: "Checkout flow",
    titlePolicy: {
      state: "auto-applied",
      sourceLineageId: "lineage:checkout",
      sourceMediaId: "design:checkout",
    },
  });

  assert.deepEqual(
    applyFirstPublishedScreenTitle({
      current: applied,
      candidateTitle: "A later Screen",
      successfulScreenCountBefore: 1,
      successfulScreenCountAfter: 2,
      sourceLineageId: "lineage:later",
      sourceMediaId: "design:later",
    }),
    applied,
  );
});

test("manual titles always win and malformed first titles consume automatic eligibility", () => {
  const manual = applyManualDesignProjectTitle(
    createDesignProjectTitleState({ origin: "blank" }),
    "My chosen name",
  );
  assert.deepEqual(
    applyFirstPublishedScreenTitle({
      current: manual,
      candidateTitle: "Generated replacement",
      successfulScreenCountBefore: 0,
      successfulScreenCountAfter: 3,
      sourceLineageId: "lineage:first",
      sourceMediaId: "design:first",
    }),
    manual,
  );

  const eligible = createDesignProjectTitleState({ origin: "blank" });
  assert.deepEqual(
    applyFirstPublishedScreenTitle({
      current: eligible,
      candidateTitle: "bad\nname",
      successfulScreenCountBefore: 0,
      successfulScreenCountAfter: 1,
      sourceLineageId: "lineage:first",
      sourceMediaId: "design:first",
    }),
    { title: "Untitled Design", titlePolicy: { state: "manual" } },
  );
  assert.throws(
    () =>
      applyFirstPublishedScreenTitle({
        current: eligible,
        candidateTitle: "Checkout",
        successfulScreenCountBefore: -1,
        successfulScreenCountAfter: 1,
        sourceLineageId: "lineage:first",
        sourceMediaId: "design:first",
      }),
    /publication counts/u,
  );
});

test("title policy parsers reject extra fields and incomplete automatic provenance", () => {
  assert.deepEqual(normalizeDesignProjectTitlePolicyV2({ state: "manual" }), {
    state: "manual",
  });
  assert.equal(
    normalizeDesignProjectTitlePolicyV2({ state: "manual", sourceMediaId: "design:forged" }),
    undefined,
  );
  assert.equal(
    normalizeDesignProjectTitlePolicyV2({
      state: "auto-applied",
      sourceLineageId: "lineage:one",
    }),
    undefined,
  );
  assert.equal(
    normalizeDesignProjectTitleStateV2({
      title: "A manually chosen name",
      titlePolicy: { state: "auto-eligible" },
    }),
    undefined,
  );
  assert.deepEqual(
    normalizeDesignProjectTitleStateV2({
      title: "Checkout",
      titlePolicy: {
        state: "auto-applied",
        sourceLineageId: "lineage:one",
        sourceMediaId: "design:one",
      },
    }),
    {
      title: "Checkout",
      titlePolicy: {
        state: "auto-applied",
        sourceLineageId: "lineage:one",
        sourceMediaId: "design:one",
      },
    },
  );
});

test("V1 viewport migration preserves frame geometry and separates surface intent", () => {
  assert.deepEqual(migrateDesignScreenPresentationFromViewport("desktop"), {
    surface: "unknown",
    frame: { preset: "desktop", width: 1200, height: 760 },
  });
  assert.deepEqual(migrateDesignScreenPresentationFromViewport("tablet"), {
    surface: "unknown",
    frame: { preset: "tablet", width: 768, height: 900 },
  });
  assert.deepEqual(migrateDesignScreenPresentationFromViewport("phone"), {
    surface: "unknown",
    frame: { preset: "phone", width: 390, height: 844 },
  });

  assert.deepEqual(
    normalizeDesignScreenPresentationV2({
      surface: "web",
      frame: { preset: "phone", width: 390, height: 844 },
    }),
    {
      surface: "web",
      frame: { preset: "phone", width: 390, height: 844 },
    },
    "surface intent is independent from preview geometry",
  );
  assert.deepEqual(
    normalizeDesignScreenPresentationV2({
      surface: "app",
      frame: { preset: "custom", width: 430, height: 932 },
    }),
    {
      surface: "app",
      frame: { preset: "custom", width: 430, height: 932 },
    },
  );
});

test("Screen presentation rejects contradictory presets, unsafe dimensions, and extra fields", () => {
  for (const presentation of [
    { surface: "web", frame: { preset: "desktop", width: 1280, height: 760 } },
    { surface: "app", frame: { preset: "custom", width: 0, height: 844 } },
    { surface: "app", frame: { preset: "custom", width: 390.5, height: 844 } },
    { surface: "app", frame: { preset: "custom", width: 16_385, height: 844 } },
    { surface: "app", frame: { preset: "phone", width: 390, height: 844, scale: 2 } },
    { surface: "print", frame: { preset: "custom", width: 1200, height: 760 } },
  ]) {
    assert.equal(normalizeDesignScreenPresentationV2(presentation), undefined);
  }
});
