import { parseDesignLanguageBindingV1, type DesignLanguageBindingV1 } from "./design-language.js";
/** Explicit, durable generation intent. IDs are resolved and authorized in main. */
export interface DesignGenerationMemberV1 { lineageId: string; mediaId: string }
export type DesignGenerationAspectV1 = "layout" | "color" | "typography" | "content";
export type DesignGenerationRequestV1 =
  | { version: 1; operation: "explore"; count: 2 | 3 | 4; creativeRange: "close" | "balanced" | "bold"; aspects: DesignGenerationAspectV1[]; base?: DesignGenerationMemberV1; retryDirectionSetId?: string }
  | { version: 1; operation: "refine"; base: DesignGenerationMemberV1 };
export interface DesignGenerationIntentV1 { id: string; turnId: string; request: DesignGenerationRequestV1; createdAt: number; published?: boolean; designLanguage?: DesignLanguageBindingV1; expectedCurrentMediaId?: string; directionSetId?: string }
export interface DesignDirectionSetV1 { id: string; sourceIntentId: string; requestedCount: 2 | 3 | 4; actualCount: number; members: DesignGenerationMemberV1[]; chosen?: DesignGenerationMemberV1; archived: boolean; status: "partial" | "complete" }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:@+-]{1,256}$/.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export function parseDesignGenerationMemberV1(v: unknown): DesignGenerationMemberV1 | undefined {
  return record(v) && keys(v, ["lineageId", "mediaId"]) && identity(v.lineageId) && identity(v.mediaId) && v.mediaId.startsWith("design:") ? {lineageId:v.lineageId, mediaId:v.mediaId} : undefined;
}
export function parseDesignGenerationRequestV1(v: unknown): DesignGenerationRequestV1 | undefined {
  if (!record(v) || v.version !== 1) return undefined;
  const base = v.base === undefined ? undefined : parseDesignGenerationMemberV1(v.base);
  if (v.base !== undefined && !base) return undefined;
  if (v.operation === "refine" && base && keys(v,["version","operation","base"])) return {version:1, operation:"refine",base};
  if (v.operation !== "explore" || !keys(v,["version","operation","count","creativeRange","aspects","base","retryDirectionSetId"]) || ![2,3,4].includes(v.count as number) || !["close","balanced","bold"].includes(v.creativeRange as string) || !Array.isArray(v.aspects) || v.aspects.length > 4 || new Set(v.aspects).size !== v.aspects.length || !v.aspects.every(a => ["layout","color","typography","content"].includes(a)) || (v.retryDirectionSetId !== undefined && !identity(v.retryDirectionSetId))) return undefined;
  return {version:1,operation:"explore",count:v.count as 2|3|4,creativeRange:v.creativeRange as "close"|"balanced"|"bold",aspects:[...v.aspects],...(base?{base}:{}),...(v.retryDirectionSetId ? {retryDirectionSetId:v.retryDirectionSetId as string}:{})};
}
export function parseDesignGenerationRecordsV1(intents: unknown, sets: unknown): {generationIntents: DesignGenerationIntentV1[]; directionSets: DesignDirectionSetV1[]} | undefined {
  if (!Array.isArray(intents) || !Array.isArray(sets) || intents.length > 256 || sets.length > 256) return undefined;
  const generationIntents: DesignGenerationIntentV1[] = [];
  for (const v of intents) {
    if (!record(v) || !keys(v,["id","turnId","request","createdAt","directionSetId","expectedCurrentMediaId","published","designLanguage"]) || !identity(v.id) || !identity(v.turnId) || !Number.isSafeInteger(v.createdAt) || (v.createdAt as number)<0 || (v.directionSetId !== undefined && !identity(v.directionSetId))) return undefined;
    if (v.designLanguage !== undefined && !parseDesignLanguageBindingV1(v.designLanguage)) return undefined;
    if (v.published !== undefined && typeof v.published !== "boolean") return undefined;
    if (v.expectedCurrentMediaId !== undefined && (!identity(v.expectedCurrentMediaId) || !v.expectedCurrentMediaId.startsWith("design:"))) return undefined;
    const request = parseDesignGenerationRequestV1(v.request);
    if (!request || Boolean(request.base) !== (v.expectedCurrentMediaId !== undefined) || generationIntents.some(i => i.id===v.id || i.turnId===v.turnId) || (request.operation === "explore") !== (v.directionSetId !== undefined)) return undefined;
    generationIntents.push({...v,request} as unknown as DesignGenerationIntentV1);
  }
  const directionSets: DesignDirectionSetV1[] = [];
  for (const v of sets) {
    if (!record(v) || !keys(v,["id","sourceIntentId","requestedCount","actualCount","members","chosen","archived","status"]) || !identity(v.id) || !identity(v.sourceIntentId) || ![2,3,4].includes(v.requestedCount as number) || !Array.isArray(v.members) || v.members.length > (v.requestedCount as number) || v.actualCount !== v.members.length || typeof v.archived!=="boolean" || v.status !== (v.members.length===v.requestedCount ? "complete":"partial") || directionSets.some(s=>s.id===v.id)) return undefined;
    const members = v.members.map(parseDesignGenerationMemberV1);
    if (members.some(m=>!m) || new Set(members.map(m=>m!.lineageId)).size!==members.length || new Set(members.map(m=>m!.mediaId)).size!==members.length) return undefined;
    const chosen = v.chosen === undefined ? undefined : parseDesignGenerationMemberV1(v.chosen);
    if (v.chosen !== undefined && (!chosen || !members.some(m=>m!.lineageId===chosen.lineageId && m!.mediaId===chosen.mediaId))) return undefined;
    const source = generationIntents.find(i=>i.id===v.sourceIntentId);
    if (!source || source.directionSetId!==v.id || source.request.operation!=="explore" || source.request.count!==v.requestedCount || source.request.retryDirectionSetId) return undefined;
    directionSets.push({...v,members,...(chosen?{chosen}:{})} as DesignDirectionSetV1);
  }
  if (generationIntents.some(i=>i.directionSetId && !directionSets.some(s=>s.id===i.directionSetId))) return undefined;
  return {generationIntents,directionSets};
}
