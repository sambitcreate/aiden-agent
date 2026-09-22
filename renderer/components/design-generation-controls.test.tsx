import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_DESIGN_EXPLORE, DesignGenerationControls } from "./design-generation-controls";
import type { DesignProjectSnapshotV2 } from "../shared/design-projects";

const actions = { onChange: () => {}, onChoose: async () => {}, onArchive: async () => {}, onShow: () => {} };
const project: DesignProjectSnapshotV2 = {
  version: 2, id: "project:one", revision: 1, title: "Example", titlePolicy: { state: "manual" }, chatId: "chat:one", connectionState: "prototype-only", createdAt: 1, updatedAt: 1,
  canvas: { viewport: "desktop", flowViewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }, referenceAssetIds: [],
  generationIntents: [{ id: "intent:one", turnId: "turn:one", request: DEFAULT_DESIGN_EXPLORE, createdAt: 1, directionSetId: "set:one" }],
  directionSets: [{ id: "set:one", sourceIntentId: "intent:one", requestedCount: 2, actualCount: 1, members: [{ lineageId: "lineage:one", mediaId: "design:one" }], chosen: { lineageId: "lineage:one", mediaId: "design:one" }, archived: false, status: "partial" }],
};

test("Explore describes bounded alternatives with accessible controls and freezes during generation", () => {
  const html = renderToStaticMarkup(<DesignGenerationControls {...actions} request={DEFAULT_DESIGN_EXPLORE} disabled />);
  assert.match(html, /Number of directions/);
  assert.match(html, /Creative range/);
  assert.match(html, /<fieldset disabled=""/);
  assert.match(html, /value="4"/);
  assert.doesNotMatch(html, /value="5"/);
});
test("partial direction sets retain chosen alternatives and offer retry without pretending complete", () => {
  const html = renderToStaticMarkup(<DesignGenerationControls {...actions} request={DEFAULT_DESIGN_EXPLORE} project={project} disabled={false} />);
  assert.match(html, /1\/2 directions · partial/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Retry missing/);
  assert.match(html, /Archive set/);
  assert.match(html, /View 1/);
});
test("Refine identifies one revision and archived sets stay out of the default list", () => {
  const html = renderToStaticMarkup(<DesignGenerationControls {...actions} request={{version:1,operation:"refine",base:{lineageId:"lineage:one",mediaId:"design:one"}}} project={{...project,directionSets:project.directionSets!.map(set=>({...set,archived:true}))}} disabled={false} />);
  assert.match(html, /Refine selected revision/);
  assert.match(html, /one revision of this screen/);
  assert.match(html, /Show archived sets/);
  assert.doesNotMatch(html, /Choose 1|View 1|Number of directions/);
});
