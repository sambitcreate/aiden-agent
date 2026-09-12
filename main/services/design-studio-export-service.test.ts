import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { prepareDesignStudioExport, parseDesignStudioExportRequest, designStudioHandoffPacket } from "./design-studio-export-service.js";
import type { DesignProjectSnapshotV2 } from "../../renderer/shared/design-projects.js";
import type { CommittedGenerativeUiRecoverySource } from "./generative-ui-artifact-store.js";
import { designPrototypeContentHash } from "./design-prototype-core.js";
const html='<!doctype html><html><head></head><body><button id="next">Next</button></body></html>';
const sha=createHash("sha256").update(html).digest("hex");
function fixture(){
 const project:DesignProjectSnapshotV2={version:2,id:"project:export",revision:1,title:"Example",titlePolicy:{state:"manual"},chatId:"chat:export",connectionState:"prototype-only",createdAt:1,updatedAt:1,referenceAssetIds:["asset:one"],canvas:{viewport:"desktop",flowViewport:{x:0,y:0,zoom:1},nodes:["a","b"].map(id=>({id:`node:${id}`,kind:"artboard",canonicalOrigin:"generated-artifact",lineageId:`lineage:${id}`,activeMediaId:`design:${id}`,artifactMediaIds:[`design:${id}`],x:0,y:0,presentation:{surface:"web",frame:{preset:"phone",width:390,height:844}}}))}};
 const source=async (_chat:string,mediaId:string):Promise<CommittedGenerativeUiRecoverySource>=>({chatId:project.chatId,generationId:"gen:export",createdAt:1,html,artifact:{version:1,kind:"html",id:sha,mediaId,title:"Screen",mimeType:"text/html",size:Buffer.byteLength(html)}});
 const reference=async()=>({bytes:Buffer.from([1,2,3]),asset:{mimeType:"image/png"}});
 const request={projectId:project.id,mediaIds:["design:b","design:a"],referenceAssetIds:["asset:one"],brief:"Checkout flow",accessibilityNotes:"Review keyboard labels",includeLanguage:false,includePrototype:false};
 return {project,source,reference,request};
}
test("identical reviewed scope exports identical bytes independent of selection order",async()=>{
 const f=fixture();const first=await prepareDesignStudioExport(f.project,f.request,f);
 const second=await prepareDesignStudioExport(f.project,{...f.request,mediaIds:[...f.request.mediaIds].reverse()},f);
 assert.deepEqual(first.bytes,second.bytes);assert.equal(first.preview.reviewDigest,second.preview.reviewDigest);
 assert.deepEqual(first.preview.entryPaths,["DESIGN.md","PROJECT.md","manifest.json","references/reference-01.png","screens/screen-01.html","screens/screen-02.html"]);
 assert.equal(first.manifest.screens[0].presentation.frame.width,390);
 const changed=await prepareDesignStudioExport({...f.project,revision:2},f.request,f);assert.notEqual(changed.preview.reviewDigest,first.preview.reviewDigest);
 const brief=await prepareDesignStudioExport(f.project,{...f.request,brief:"Different reviewed brief"},f);assert.notEqual(brief.preview.reviewDigest,first.preview.reviewDigest);
 const packet=await designStudioHandoffPacket(first);assert.equal(packet.version,2);if(packet.version!==2)throw Error();assert.equal(packet.reviewedScope.screens.length,2);assert.deepEqual(packet.responsiveStates,[{viewport:"phone",width:390,height:844}]);assert.equal(packet.reviewedScope.brief,"Checkout flow");
});
test("export rejects unknown scope, unsafe prose, missing membership, and stale prototype subsets",async()=>{
 const f=fixture();for(const patch of [{transcript:"secret"},{brief:"/Users/private/file"},{brief:"api_key = secretvalue123456"},{brief:"bad\u0000"},{mediaIds:["design:a","design:a"]}])assert.throws(()=>parseDesignStudioExportRequest({...f.request,...patch}));
 await assert.rejects(prepareDesignStudioExport(f.project,{...f.request,mediaIds:["design:foreign"]},f),/stale or missing/);
 await assert.rejects(prepareDesignStudioExport(f.project,{...f.request,referenceAssetIds:["asset:foreign"]},f),/outside/);
 const graph={version:1 as const,entryMediaId:"design:a",nodes:["a","b"].map(id=>({lineageId:`lineage:${id}`,mediaId:`design:${id}`,contentHash:sha})),edges:[]};
 f.project.prototype={...graph,revision:1,contentHash:designPrototypeContentHash(graph)};
 await assert.rejects(prepareDesignStudioExport(f.project,{...f.request,mediaIds:["design:a"],includePrototype:true},f),/every exact/);
 const complete=await prepareDesignStudioExport(f.project,{...f.request,includePrototype:true},f);assert.equal(complete.manifest.prototype?.status,"static");assert.ok(complete.preview.entryPaths.includes("prototype.json"));
});
test("changed source bytes and references invalidate the review digest",async()=>{
 const f=fixture();const original=await prepareDesignStudioExport(f.project,f.request,f);
 const changed=await prepareDesignStudioExport(f.project,f.request,{...f,reference:async()=>({bytes:Buffer.from([3,2,1]),asset:{mimeType:"image/png"}})});assert.notEqual(original.preview.reviewDigest,changed.preview.reviewDigest);
 await assert.rejects(prepareDesignStudioExport(f.project,f.request,{...f,source:async()=>undefined}),/unavailable/);
});

test("reviewed authentication UI prose is allowed without accepting secret assignments",async()=>{
 const f=fixture();const bundle=await prepareDesignStudioExport({...f.project,title:"Password reset"},{...f.request,brief:"Design a password reset screen and API key management page",accessibilityNotes:"Improve authorization settings"},f);
 assert.match(bundle.preview.briefMarkdown,/password reset screen/);
 const packet=await designStudioHandoffPacket(bundle);assert.equal(packet.version,2);
 assert.throws(()=>parseDesignStudioExportRequest({...f.request,brief:'api_key = "supersecrettoken123"'}));
});
