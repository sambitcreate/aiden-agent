import { createHash } from "node:crypto";
import type { DesignProjectSnapshotV2 } from "../../renderer/shared/design-projects.js";
import type { DesignPrototypeEdgeV1 } from "../../renderer/shared/design-prototype.js";
import { normalizeDesignPrototypeInput, parseDesignPrototypeGraph, designPrototypeStatus } from "./design-prototype-core.js";
import { isUsablePublishedDesignSource } from "./design-artifact-source-authority.js";
import type { CommittedGenerativeUiRecoverySource } from "./generative-ui-artifact-store.js";
import { openPrototypeHost } from "./design-prototype-host.js";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";

type Dependencies = { source?: (chatId: string, mediaId: string) => Promise<CommittedGenerativeUiRecoverySource | undefined>; host?: typeof openPrototypeHost; now?: () => number; getProject?: (projectId: string) => Promise<DesignProjectSnapshotV2 | undefined> };
async function sourceFor(project: DesignProjectSnapshotV2, mediaId: string, dependencies: Dependencies) {
  const read = dependencies.source ?? (await import("./generative-ui-artifact-store.js")).generativeUiArtifactStore.committedRecoverySourceFor.bind((await import("./generative-ui-artifact-store.js")).generativeUiArtifactStore);
  const source = await read(project.chatId, mediaId);
  if (!isUsablePublishedDesignSource(project, source)) throw new Error("Prototype source must be an exact committed Screen revision.");
  return source;
}
export async function resolvePrototypeGraph(project: DesignProjectSnapshotV2, request: { mediaIds: string[]; entryMediaId: string; edges: DesignPrototypeEdgeV1[] }, dependencies: Dependencies = {}) {
  if (!Array.isArray(request.mediaIds) || !request.mediaIds.length || request.mediaIds.length > 20 || new Set(request.mediaIds).size !== request.mediaIds.length) throw new Error("Select a bounded unique set of Screens.");
  const nodes = [];
  for (const mediaId of request.mediaIds) {
    const node = project.canvas.nodes.find((item) => item.kind === "artboard" && item.artifactMediaIds.includes(mediaId));
    if (!node?.lineageId || node.activeMediaId !== mediaId) throw new Error("Prototype Screen is stale or missing.");
    const source = await sourceFor(project, mediaId, dependencies);
    nodes.push({ lineageId: node.lineageId, mediaId, contentHash: createHash("sha256").update(source.html).digest("hex") });
  }
  return normalizeDesignPrototypeInput({ version: 1, entryMediaId: request.entryMediaId, nodes, edges: request.edges });
}
async function resolveSaved(project: DesignProjectSnapshotV2, dependencies: Dependencies) {
  const graph = parseDesignPrototypeGraph(project.prototype);
  if (!graph) throw new Error("Save a valid prototype graph first.");
  const status = designPrototypeStatus(graph, project.canvas);
  if (status === "stale" || status === "broken") throw new Error("Prototype references stale or missing Screens.");
  const screens = [];
  for (const node of graph.nodes) {
    const source = await sourceFor(project, node.mediaId, dependencies);
    if (createHash("sha256").update(source.html).digest("hex") !== node.contentHash) throw new Error("Prototype source hash changed.");
    screens.push({ mediaId: node.mediaId, html: source.html });
  }
  return { graph, screens, status };
}
export async function verifyPrototype(project: DesignProjectSnapshotV2, dependencies: Dependencies = {}) {
  const { graph, screens } = await resolveSaved(project, dependencies);
  if (!graph.edges.length) throw new Error("Static Screens have no prototype interactions to verify.");
  const result = await (dependencies.host ?? openPrototypeHost)(screens, graph.edges, { verify: true, entryMediaId: graph.entryMediaId });
  if (result.passedEdgeIds.length !== graph.edges.length || new Set(result.passedEdgeIds).size !== graph.edges.length || graph.edges.some((edge) => !result.passedEdgeIds.includes(edge.id))) throw new Error("Prototype checks did not verify every edge.");
  return { graphHash: graph.contentHash, verifiedAt: (dependencies.now ?? Date.now)(), passedEdgeIds: result.passedEdgeIds };
}
export async function playPrototype(project: DesignProjectSnapshotV2, owner?: Pick<RendererDocumentOwner, "onInvalidated" | "isDestroyed">, dependencies: Dependencies = {}) {
  const { graph, screens, status } = await resolveSaved(project, dependencies);
  if (status !== "verified") throw new Error("Verify every prototype interaction before playing.");
  if (owner?.isDestroyed()) throw new Error("The prototype owner is unavailable.");
  let close = () => {};
  let invalidated = false;
  const release = owner?.onInvalidated(() => { invalidated = true; close(); });
  try {
    const result = await (dependencies.host ?? openPrototypeHost)(screens, graph.edges, { verify: false, entryMediaId: graph.entryMediaId, onClosed: () => release?.(), beforeNavigate: async () => {
      const read = dependencies.getProject ?? (await import("./design-project-store-main.js")).designProjectStore.get.bind((await import("./design-project-store-main.js")).designProjectStore);
      const current = await read(project.id);
      if (!current) throw new Error("Prototype project is no longer available.");
      const resolved = await resolveSaved(current, dependencies);
      if (resolved.status !== "verified" || resolved.graph.contentHash !== graph.contentHash || resolved.graph.revision !== graph.revision) throw new Error("Prototype changed. Reopen the verified graph.");
    } });
    close = result.close;
    if (invalidated || owner?.isDestroyed()) { close(); throw new Error("The prototype owner expired."); }
    return { windowId: result.windowId };
  } catch (error) { release?.(); throw error; }
}
