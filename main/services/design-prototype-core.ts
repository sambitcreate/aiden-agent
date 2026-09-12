import { createHash } from "node:crypto";
import type { DesignPrototypeInputV1, DesignPrototypeGraphV1, DesignPrototypeEdgeV1, DesignPrototypeVerificationV1 } from "../../renderer/shared/design-prototype.js";
export { designPrototypeStatus } from "../../renderer/shared/design-prototype.js";
export const MAX_DESIGN_PROTOTYPE_NODES = 20;
export const MAX_DESIGN_PROTOTYPE_EDGES = 40;
export const MAX_DESIGN_PROTOTYPE_BYTES = 24 * 1024;
const ID = /^[A-Za-z0-9._:@+-]{1,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const SELECTOR = /^(?:#[A-Za-z][A-Za-z0-9_-]{0,63}|\[data-aiden-id="[A-Za-z][A-Za-z0-9_-]{0,63}"\])$/;
const KEYS = new Set(["Enter", " ", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const fail = (): never => {throw new Error("Invalid Design Prototype graph.");};
function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return fail();
  return value as Record<string,unknown>;
}
function exact(value: Record<string,unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key=>!keys.includes(key))) fail();
}
function identity(value: unknown): string {if (typeof value !== "string" || !ID.test(value)) return fail(); return value;}
function hash(value: unknown): string {if (typeof value !== "string" || !HASH.test(value)) return fail(); return value;}
function media(value: unknown): string {const id=identity(value);if (!id.startsWith("design:")) return fail();return id;}
export function normalizeDesignPrototypeInput(value: unknown): DesignPrototypeInputV1 {
  const input=record(value);exact(input,["version","entryMediaId","nodes","edges"]);
  if (input.version!==1 || !Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length>MAX_DESIGN_PROTOTYPE_NODES || !Array.isArray(input.edges) || input.edges.length>MAX_DESIGN_PROTOTYPE_EDGES) return fail();
  const nodes=input.nodes.map(value=>{const node=record(value);exact(node,["lineageId","mediaId","contentHash"]);return {lineageId:identity(node.lineageId),mediaId:media(node.mediaId),contentHash:hash(node.contentHash)};}).sort((a,b)=>a.mediaId.localeCompare(b.mediaId,"en"));
  if (new Set(nodes.map(node=>node.mediaId)).size!==nodes.length || new Set(nodes.map(node=>node.lineageId)).size!==nodes.length) return fail();
  const entryMediaId=media(input.entryMediaId);
  if (!nodes.some(node=>node.mediaId===entryMediaId)) return fail();
  const edges: DesignPrototypeEdgeV1[]=input.edges.map(value=>{
    const edge=record(value);exact(edge,["id","fromMediaId","toMediaId","trigger","selector","transition",...(edge.key !== undefined?["key"]:[])]);
    if (!["click","submit","change","keydown"].includes(edge.trigger as string) || !["none","fade"].includes(edge.transition as string) || typeof edge.selector!=="string" || !SELECTOR.test(edge.selector) || (edge.trigger==="keydown" ? typeof edge.key!=="string" || !KEYS.has(edge.key) : edge.key!==undefined)) return fail();
    const fromMediaId=media(edge.fromMediaId),toMediaId=media(edge.toMediaId);
    if (!nodes.some(node=>node.mediaId===fromMediaId) || !nodes.some(node=>node.mediaId===toMediaId)) return fail();
    return {id:identity(edge.id),fromMediaId,toMediaId,trigger:edge.trigger as DesignPrototypeEdgeV1["trigger"],selector:edge.selector,...(edge.key!==undefined?{key:edge.key as string}:{}),transition:edge.transition as DesignPrototypeEdgeV1["transition"]};
  }).sort((a,b)=>a.id.localeCompare(b.id,"en"));
  if (new Set(edges.map(edge=>edge.id)).size!==edges.length || new Set(edges.map(edge=>JSON.stringify([edge.fromMediaId,edge.trigger,edge.selector,edge.key]))).size!==edges.length) return fail();
  const graph: DesignPrototypeInputV1={version:1,entryMediaId,nodes,edges};
  if (Buffer.byteLength(JSON.stringify(graph),"utf8")>MAX_DESIGN_PROTOTYPE_BYTES) return fail();
  return graph;
}
export function designPrototypeContentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeDesignPrototypeInput(value))).digest("hex");
}
export function normalizeDesignPrototypeVerification(value: unknown, graph: DesignPrototypeInputV1, graphHash: string): DesignPrototypeVerificationV1 {
  const evidence=record(value);exact(evidence,["graphHash","verifiedAt","passedEdgeIds"]);
  if (hash(evidence.graphHash)!==graphHash || !Number.isSafeInteger(evidence.verifiedAt) || (evidence.verifiedAt as number)<0 || !Array.isArray(evidence.passedEdgeIds) || evidence.passedEdgeIds.length!==graph.edges.length || new Set(evidence.passedEdgeIds).size!==graph.edges.length || !evidence.passedEdgeIds.every(id=>graph.edges.some(edge=>edge.id===id))) return fail();
  return {graphHash,verifiedAt:evidence.verifiedAt as number,passedEdgeIds:[...evidence.passedEdgeIds].sort()};
}
export function parseDesignPrototypeGraph(value: unknown): DesignPrototypeGraphV1 | undefined {
  try {
    const raw=record(value);exact(raw,["version","entryMediaId","nodes","edges","revision","contentHash",...(raw.verification!==undefined?["verification"]:[])]);
    if (!Number.isSafeInteger(raw.revision) || (raw.revision as number)<1) return undefined;
    const graph=normalizeDesignPrototypeInput({version:raw.version,entryMediaId:raw.entryMediaId,nodes:raw.nodes,edges:raw.edges});
    const contentHash=designPrototypeContentHash(graph);
    if (hash(raw.contentHash)!==contentHash) return undefined;
    return {...graph,revision:raw.revision as number,contentHash,...(raw.verification!==undefined?{verification:normalizeDesignPrototypeVerification(raw.verification,graph,contentHash)}:{})};
  } catch {return undefined;}
}
