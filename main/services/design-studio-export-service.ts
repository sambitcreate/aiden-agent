import { createHash } from "node:crypto";
import type { DesignProjectSnapshotV2, DesignScreenPresentationV2 } from "../../renderer/shared/design-projects.js";
import type { DesignStudioExportRequest, DesignStudioExportPreview } from "../../renderer/shared/design-studio-export.js";
import type { CommittedGenerativeUiRecoverySource } from "./generative-ui-artifact-store.js";
import { isUsablePublishedDesignSource } from "./design-artifact-source-authority.js";
import { assertPortableDesignExportHtml, encodeDeterministicZip, safeDesignExportSlug } from "./design-project-export-core.js";
import { exportDesignLanguageMarkdown, designLanguageContentHash } from "./design-language-core.js";
import { designPrototypeStatus } from "./design-prototype-core.js";
const hash=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const safeText=(value:unknown,max:number):string=>{
  if(typeof value!=="string" || Buffer.byteLength(value)>max || Buffer.from(value).toString("utf8")!==value || [...value].some(c=>(c.charCodeAt(0)<32&&!"\n\r\t".includes(c))||c.charCodeAt(0)===127) || /[\p{Cf}\p{Cs}]/u.test(value) || /(?:file:\/\/|https?:\/\/|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)|\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password|authorization)\s*[:=]\s*["']?[^\s"']{8,}|\bbearer\s+[A-Za-z0-9._~+/-]{8,})/iu.test(value)) throw new Error("Reviewed text contains unsupported paths, resources, or sensitive fields.");
  return value.trim();
};
export function parseDesignStudioExportRequest(value:unknown):DesignStudioExportRequest {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid project export scope.");
  const v=value as Record<string,unknown>;
  const keys=["projectId","mediaIds","referenceAssetIds","brief","accessibilityNotes","includeLanguage","includePrototype"];
  if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))||typeof v.projectId!=="string"||!/^[A-Za-z0-9._:@+-]{1,256}$/u.test(v.projectId)||typeof v.includeLanguage!=="boolean"||typeof v.includePrototype!=="boolean")throw new Error("Invalid project export scope.");
  const ids=(input:unknown,max:number)=>{if(!Array.isArray(input)||input.length>max||input.some(id=>typeof id!=="string"||!/^[A-Za-z0-9._:@+-]{1,256}$/u.test(id))||new Set(input).size!==input.length)throw new Error("Choose a bounded unique export scope.");return [...input].sort() as string[];};
  const mediaIds=ids(v.mediaIds,20);if(!mediaIds.length)throw new Error("Choose at least one Screen.");
  return {projectId:v.projectId,mediaIds,referenceAssetIds:ids(v.referenceAssetIds,10),brief:safeText(v.brief,4096),accessibilityNotes:safeText(v.accessibilityNotes,2048),includeLanguage:v.includeLanguage,includePrototype:v.includePrototype};
}
type Dependencies={source:(chatId:string,mediaId:string)=>Promise<CommittedGenerativeUiRecoverySource|undefined>;reference:(id:string)=>Promise<{bytes:Uint8Array;asset:{mimeType:string}}|undefined>;validateLanguage?:()=>Promise<void>};
export async function prepareDesignStudioExport(project:DesignProjectSnapshotV2,value:unknown,dependencies:Dependencies){
  const request=parseDesignStudioExportRequest(value);
  if(request.projectId!==project.id)throw new Error("Export scope does not belong to this project.");
  const entries:Array<{path:string;bytes:Uint8Array}>=[];
  const sources:CommittedGenerativeUiRecoverySource[]=[];
  const screens:Array<{lineageId:string;revisionId:string;sha256:string;byteSize:number;path:string;presentation:DesignScreenPresentationV2}>=[];
  for(const mediaId of request.mediaIds){
    const node=project.canvas.nodes.find(n=>n.kind==="artboard"&&n.activeMediaId===mediaId);
    if(!node||node.kind!=="artboard")throw new Error("A reviewed Screen is stale or missing.");
    const source=await dependencies.source(project.chatId,mediaId);
    if(!isUsablePublishedDesignSource(project,source))throw new Error("A reviewed Screen source is unavailable or damaged.");
    const bytes=assertPortableDesignExportHtml(source.html);
    const path=`screens/screen-${String(screens.length+1).padStart(2,"0")}.html`;
    entries.push({path,bytes});sources.push(source);
    screens.push({lineageId:node.lineageId,revisionId:mediaId,sha256:hash(bytes),byteSize:bytes.byteLength,path,presentation:node.presentation});
  }
  const references:Array<{id:string;path:string;sha256:string;byteSize:number}>=[];
  for(const id of request.referenceAssetIds){
    if(!project.referenceAssetIds.includes(id))throw new Error("A reviewed reference is outside this project.");
    const stored=await dependencies.reference(id);if(!stored)throw new Error("A reviewed reference is unavailable.");
    const extension=({"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp","image/bmp":"bmp","image/heic":"heic","image/heif":"heif"} as Record<string,string>)[stored.asset.mimeType];
    if(!extension)throw new Error("Unsupported reference image.");
    const path=`references/reference-${String(references.length+1).padStart(2,"0")}.${extension}`;
    entries.push({path,bytes:stored.bytes});references.push({id,path,sha256:hash(stored.bytes),byteSize:stored.bytes.byteLength});
  }
  const language=request.includeLanguage?project.designLanguages?.find(l=>l.id===project.activeDesignLanguage?.id):undefined;
  if(request.includeLanguage&&(!language||language.contentHash!==project.activeDesignLanguage?.contentHash||language.contentHash!==designLanguageContentHash(language.document)))throw new Error("The applied Design Language is missing or changed.");
  if(language)await dependencies.validateLanguage?.();
  const designMarkdown=language?exportDesignLanguageMarkdown(language.document):"# Design Language\n\nNo Design Language included in this reviewed scope.\n";
  const prototype=request.includePrototype?project.prototype:undefined;
  if(request.includePrototype&&!prototype)throw new Error("Save a prototype before including it.");
  if(prototype){
    const status=designPrototypeStatus(prototype,project.canvas);
    if(status==="stale"||status==="broken"||prototype.nodes.some(node=>!screens.some(screen=>screen.revisionId===node.mediaId&&screen.sha256===node.contentHash)))throw new Error("Include every exact prototype Screen or omit the prototype.");
    entries.push({path:"prototype.json",bytes:Buffer.from(JSON.stringify({...prototype,status},null,2)+"\n")});
  }
  const chosenDirections=(project.directionSets??[]).filter(set=>!set.archived&&set.chosen&&request.mediaIds.includes(set.chosen.mediaId)).map(set=>({setId:set.id,mediaId:set.chosen!.mediaId})).sort((a,b)=>a.setId.localeCompare(b.setId,"en"));
  const title=safeText(project.title,640);
  const briefMarkdown=`# ${title}\n\n${request.brief||"No project brief supplied."}\n\n## Accessibility notes\n\n${request.accessibilityNotes||"No accessibility assessment supplied."}\n\nThis bundle contains reviewed prototype sources. Verification applies only to recorded prototype links; it is not a general accessibility assessment.\n`;
  const manifest={schema:"aiden.design-project.export",version:2,project:{id:project.id,revision:project.revision,title},screens,references,chosenDirections,...(language?{designLanguage:{contentHash:language.contentHash}}:{}),...(prototype?{prototype:{graphHash:prototype.contentHash,status:designPrototypeStatus(prototype,project.canvas),entryMediaId:prototype.entryMediaId,nodeCount:prototype.nodes.length,edgeCount:prototype.edges.length}}:{})};
  const manifestJson=JSON.stringify(manifest,null,2)+"\n";
  entries.push({path:"manifest.json",bytes:Buffer.from(manifestJson)},{path:"PROJECT.md",bytes:Buffer.from(briefMarkdown)},{path:"DESIGN.md",bytes:Buffer.from(designMarkdown)});
  const bytes=encodeDeterministicZip(entries);
  const preview:DesignStudioExportPreview={projectRevision:project.revision,reviewDigest:hash(bytes),fileName:`${safeDesignExportSlug(title)}-project.zip`,entryPaths:entries.map(e=>e.path).sort(),manifestJson,briefMarkdown,designMarkdown,byteSize:bytes.byteLength};
  return {request,preview,manifest,sources,bytes,languageDocument:language?.document};
}

export async function designStudioHandoffPacket(bundle:Awaited<ReturnType<typeof prepareDesignStudioExport>>) {
  const {designHandoffReviewDigest,parseDesignHandoffPacket}=await import("./design-handoff-contract.js");
  const {manifest,request}=bundle;
  const screens=manifest.screens.map(({lineageId,revisionId,sha256,byteSize})=>({lineageId,revisionId,sha256,byteSize}));
  const first=screens[0]!;
  const responsiveStates=manifest.screens.map(screen=>({viewport:screen.presentation.frame.preset==="custom"?"desktop" as const:screen.presentation.frame.preset,width:screen.presentation.frame.width,height:screen.presentation.frame.height})).filter((state,index,all)=>all.findIndex(s=>s.viewport===state.viewport)===index);
  const packet={version:2 as const,projectId:manifest.project.id,projectRevision:manifest.project.revision,source:{bundleId:`bundle:${bundle.preview.reviewDigest}`,...first},referenceAssetIds:request.referenceAssetIds,designDecisions:[],responsiveStates,reviewedScope:{screens,chosenDirections:manifest.chosenDirections,brief:request.brief.replace(/\s+/gu," "),accessibilityNotes:request.accessibilityNotes.replace(/\s+/gu," "),...(manifest.designLanguage?{designLanguageHash:manifest.designLanguage.contentHash}:{}),...(manifest.prototype?{prototype:{graphHash:manifest.prototype.graphHash,status:manifest.prototype.status,nodeCount:manifest.prototype.nodeCount,edgeCount:manifest.prototype.edgeCount}}:{})}};
  const parsed=parseDesignHandoffPacket({...packet,reviewDigest:designHandoffReviewDigest(packet)});
  const {serializeDesignHandoffContext}=await import("./design-handoff-packet-authority.js");
  serializeDesignHandoffContext(parsed,bundle.sources.map(source=>({revisionId:source.artifact.mediaId,html:source.html})),bundle.languageDocument);
  return parsed;
}
