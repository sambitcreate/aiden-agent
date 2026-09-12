import type { DesignProjectCanvasV2 } from "./design-projects.js";
export interface DesignPrototypeNodeV1 { lineageId: string; mediaId: string; contentHash: string }
export interface DesignPrototypeEdgeV1 {
  id: string;
  fromMediaId: string;
  toMediaId: string;
  trigger: "click" | "submit" | "change" | "keydown";
  selector: string;
  key?: string;
  transition: "none" | "fade";
}
export interface DesignPrototypeInputV1 { version: 1; entryMediaId: string; nodes: DesignPrototypeNodeV1[]; edges: DesignPrototypeEdgeV1[] }
export interface DesignPrototypeVerificationV1 { graphHash: string; verifiedAt: number; passedEdgeIds: string[] }
export interface DesignPrototypeGraphV1 extends DesignPrototypeInputV1 {
  revision: number;
  contentHash: string;
  verification?: DesignPrototypeVerificationV1;
}
export type DesignPrototypeStatusV1 = "static" | "unverified" | "verified" | "stale" | "broken";
/** Display state is derived, never accepted as renderer-authored graph data. */
export function designPrototypeStatus(graph: DesignPrototypeGraphV1, canvas: DesignProjectCanvasV2): DesignPrototypeStatusV1 {
  const sources = graph.nodes.map(source => canvas.nodes.find(node => node.kind === "artboard" && node.lineageId === source.lineageId && node.artifactMediaIds.includes(source.mediaId)));
  if (sources.some(source => !source)) return "broken";
  if (sources.some((source,index) => source!.activeMediaId !== graph.nodes[index]!.mediaId)) return "stale";
  if (!graph.edges.length) return "static";
  return graph.verification?.graphHash === graph.contentHash && graph.verification.passedEdgeIds.length === graph.edges.length &&
    graph.edges.every(edge => graph.verification!.passedEdgeIds.includes(edge.id)) ? "verified" : "unverified";
}
