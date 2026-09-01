import assert from "node:assert/strict";
import test from "node:test";
import {
  countDesignProjectSourceMatches,
  designProjectArtboardLabel,
  designProjectOriginLabel,
  designProjectSourceMatchRanges,
  designProjectSourceLines,
  filterDesignProjects,
  type DesignProjectSummary,
} from "./design-projects.js";

const projects: DesignProjectSummary[] = [
  {
    id: "connected",
    title: "Storefront",
    connectionState: "connected",
    hasPrototypeArtboards: false,
    updatedAt: 20,
    artboardCount: 2,
    health: "ready",
  },
  {
    id: "mixed",
    title: "Checkout exploration",
    connectionState: "connected",
    hasPrototypeArtboards: true,
    updatedAt: 30,
    artboardCount: 3,
    health: "needs-repair",
  },
  {
    id: "prototype",
    title: "Account settings",
    connectionState: "prototype-only",
    hasPrototypeArtboards: true,
    updatedAt: 10,
    artboardCount: 1,
    health: "ready",
  },
];

test("project filtering is case-insensitive, stable, and keeps mixed projects visible", () => {
  assert.deepEqual(
    filterDesignProjects(projects, "all", "").map((project) => project.id),
    ["mixed", "connected", "prototype"],
  );
  assert.deepEqual(
    filterDesignProjects(projects, "prototype", "CHECKOUT").map((project) => project.id),
    ["mixed"],
  );
  assert.deepEqual(
    filterDesignProjects(projects, "connected-app", "").map((project) => project.id),
    ["mixed", "connected"],
  );
});

test("project labels keep origin and artboard grammar explicit", () => {
  assert.equal(designProjectOriginLabel("prototype-only", true), "Prototype");
  assert.equal(designProjectOriginLabel("connected", false), "Connected App");
  assert.equal(designProjectOriginLabel("connected", true), "Prototype + Connected App");
  assert.equal(designProjectArtboardLabel(1), "1 artboard");
  assert.equal(designProjectArtboardLabel(2), "2 artboards");
});

test("source helpers preserve blank lines and count non-overlapping find matches", () => {
  assert.deepEqual(designProjectSourceLines("one\n\nthree"), ["one", "", "three"]);
  assert.equal(countDesignProjectSourceMatches("Design design DESIGN", " design "), 3);
  assert.equal(countDesignProjectSourceMatches("aaaa", "aa"), 2);
  assert.equal(countDesignProjectSourceMatches("source", ""), 0);
  assert.deepEqual(designProjectSourceMatchRanges("Design design", "design"), [
    [0, 6],
    [7, 13],
  ]);
});
