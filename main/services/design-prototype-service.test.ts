import { DEFAULT_NEW_DESIGN_SCREEN_PRESENTATION } from "./design-project-v2-policy.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { resolvePrototypeGraph, verifyPrototype, playPrototype } from "./design-prototype-service.js";
import { designPrototypeContentHash } from "./design-prototype-core.js";
import type { DesignProjectSnapshotV2 } from "../../renderer/shared/design-projects.js";
import type { CommittedGenerativeUiRecoverySource } from "./generative-ui-artifact-store.js";
import type { openPrototypeHost } from "./design-prototype-host.js";
const html = '<button id="next">Next</button>';
const hash = createHash("sha256").update(html).digest("hex");
function fixture() {
  const project: DesignProjectSnapshotV2 = { version: 2, id: "project:prototype", revision: 1, title: "Prototype", titlePolicy: { state: "manual" }, chatId: "chat:prototype", connectionState: "prototype-only", createdAt: 1, updatedAt: 1, referenceAssetIds: [], canvas: { viewport: "desktop", flowViewport: { x: 0, y: 0, zoom: 1 }, nodes: ["a", "b"].map((id) => ({ kind: "artboard", id: `node:${id}`, canonicalOrigin: "generated-artifact", lineageId: `lineage:${id}`, artifactMediaIds: [`design:${id}`], activeMediaId: `design:${id}`, x: 0, y: 0, presentation: DEFAULT_NEW_DESIGN_SCREEN_PRESENTATION })) } };
  const source = async (_chatId: string, mediaId: string): Promise<CommittedGenerativeUiRecoverySource> => ({ chatId: project.chatId, generationId: "generation:prototype", createdAt: 1, html, artifact: { version: 1, kind: "html", id: hash, mediaId, title: "Screen", mimeType: "text/html", size: Buffer.byteLength(html) } });
  return { project, source };
}
test("prototype evidence requires every real host check and exact current source hashes", async () => {
  const { project, source } = fixture();
  const graph = await resolvePrototypeGraph(project, { mediaIds: ["design:a", "design:b"], entryMediaId: "design:a", edges: [{ id: "edge:next", fromMediaId: "design:a", toMediaId: "design:b", trigger: "click", selector: "#next", transition: "none" }] }, { source });
  project.prototype = { ...graph, revision: 1, contentHash: designPrototypeContentHash(graph) };
  let checked = false;
  const host: typeof openPrototypeHost = async (screens, edges, options) => { checked = true; assert.equal(options.verify, true); assert.equal(screens.length, 2); return { passedEdgeIds: edges.map((edge) => edge.id), windowId: 1, close() {} }; };
  const evidence = await verifyPrototype(project, { source, host, now: () => 123 });
  assert.equal(checked, true); assert.equal(evidence.verifiedAt, 123);
  await assert.rejects(verifyPrototype(project, { source, host: async () => ({ passedEdgeIds: [], windowId: 1, close() {} }) }), /every edge/u);
  project.prototype.verification = evidence;
  let navigationCheck: (() => Promise<void>) | undefined;
  await playPrototype(project, undefined, { source, getProject: async () => project, host: async (_screens, _edges, options) => { navigationCheck = options.beforeNavigate; return { passedEdgeIds: [], windowId: 1, close() {} }; } });
  project.canvas.nodes[0]!.activeMediaId = "design:newer";
  await assert.rejects(navigationCheck!(), /stale/u);
  await assert.rejects(verifyPrototype(project, { source, host }), /stale/u);
});
