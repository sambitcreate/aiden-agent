import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DEFAULT_NEW_DESIGN_SCREEN_PRESENTATION } from "./design-project-v2-policy.js";
import type { DesignProjectSnapshotV2 } from "../../renderer/shared/design-projects.js";
import type { CommittedGenerativeUiRecoverySource } from "./generative-ui-artifact-store.js";
import { resolveDesignHandoffSources } from "./design-handoff-packet-authority.js";
import { designHandoffReviewDigest, parseDesignHandoffPacket, type DesignHandoffPacketV2 } from "./design-handoff-contract.js";
function withoutDigest(packet: DesignHandoffPacketV2) { const {reviewDigest:_digest,...base}=packet;return base; }
function fixture() {
  const html = '<main>Reviewed source</main>';
  const sha256 = createHash("sha256").update(html).digest("hex");
  const screens = ["a", "b"].map(id=>({lineageId:`lineage:${id}`,revisionId:`design:${id}`,sha256,byteSize:Buffer.byteLength(html)}));
  const base: Omit<DesignHandoffPacketV2,"reviewDigest"> = {version:2,projectId:"project:reviewed",projectRevision:1,source:{bundleId:"bundle:reviewed",...screens[0]!},referenceAssetIds:[],designDecisions:[],responsiveStates:[{viewport:"desktop",width:1200,height:760}],reviewedScope:{brief:"Implement the reviewed checkout",chosenDirections:[],screens,accessibilityNotes:"Check keyboard focus"}};
  const packet: DesignHandoffPacketV2 = {...base,reviewDigest:designHandoffReviewDigest(base)};
  const project: DesignProjectSnapshotV2 = {version:2,id:base.projectId,revision:1,title:"Reviewed",titlePolicy:{state:"manual"},chatId:"chat:reviewed",connectionState:"prototype-only",createdAt:1,updatedAt:1,referenceAssetIds:[],canvas:{viewport:"desktop",flowViewport:{x:0,y:0,zoom:1},nodes:screens.map(screen=>({kind:"artboard",id:`node:${screen.revisionId}`,canonicalOrigin:"generated-artifact",lineageId:screen.lineageId,artifactMediaIds:[screen.revisionId],activeMediaId:screen.revisionId,x:0,y:0,presentation:DEFAULT_NEW_DESIGN_SCREEN_PRESENTATION}))}};
  const sourceFor = async (_chatId:string,mediaId:string):Promise<CommittedGenerativeUiRecoverySource> => ({chatId:project.chatId,generationId:"generation:reviewed",createdAt:1,html,artifact:{version:1,kind:"html",id:sha256,mediaId,title:"Reviewed",mimeType:"text/html",size:Buffer.byteLength(html)}});
  return {packet,project,sourceFor};
}
test("V2 digest binds full reviewed scope and rejects unsafe or oversized contexts",()=>{
  const {packet}=fixture();
  assert.deepEqual(parseDesignHandoffPacket(packet),packet);
  assert.throws(()=>parseDesignHandoffPacket({...packet,reviewedScope:{...packet.reviewedScope,brief:"Changed brief"}}),/digest/u);
  assert.throws(()=>designHandoffReviewDigest({...withoutDigest(packet),reviewedScope:{...packet.reviewedScope,brief:"Read /Users/private/secret"}}),/unsafe/u);
  assert.throws(()=>designHandoffReviewDigest({...withoutDigest(packet),reviewedScope:{...packet.reviewedScope,screens:packet.reviewedScope.screens.map(screen=>({...screen,byteSize:400*1024}))}}),/total size/u);
});
test("V2 source authority rechecks every reviewed Screen and rejects nonprimary corruption or stale selection",async()=>{
  const {packet,project,sourceFor}=fixture();
  const read:string[]=[];
  const sources=await resolveDesignHandoffSources(packet,project,{sourceFor:async(chatId,id)=>{read.push(id);return sourceFor(chatId,id);}});
  assert.deepEqual(read,["design:a","design:b"]);assert.equal(sources.length,2);
  await assert.rejects(resolveDesignHandoffSources(packet,project,{sourceFor:async(chatId,id)=>id==="design:b"?undefined:sourceFor(chatId,id)}),/unavailable/u);
  project.canvas.nodes[1]!.activeMediaId="design:newer";
  await assert.rejects(resolveDesignHandoffSources(packet,project,{sourceFor}),/stale/u);
});
test("V2 semantic bindings cannot silently substitute a language or prototype",async()=>{
  const {packet,project,sourceFor}=fixture();
  const withLanguage={...packet,reviewedScope:{...packet.reviewedScope,designLanguageHash:"a".repeat(64)}};
  withLanguage.reviewDigest=designHandoffReviewDigest(withoutDigest(withLanguage));
  await assert.rejects(resolveDesignHandoffSources(withLanguage,project,{sourceFor}),/Language binding/u);
  const withPrototype={...packet,reviewedScope:{...packet.reviewedScope,prototype:{graphHash:"b".repeat(64),status:"verified" as const,nodeCount:2,edgeCount:1}}};
  withPrototype.reviewDigest=designHandoffReviewDigest(withoutDigest(withPrototype));
  await assert.rejects(resolveDesignHandoffSources(withPrototype,project,{sourceFor}),/prototype binding/u);
});

test("reviewed references require exact content-addressed bytes at context reuse", async () => {
  const {packet,project,sourceFor}=fixture();
  const bytes=Buffer.from("reference image bytes");const id=createHash("sha256").update(bytes).digest("hex");
  project.referenceAssetIds=[id];const base={...withoutDigest(packet),referenceAssetIds:[id]};const reviewed={...base,reviewDigest:designHandoffReviewDigest(base)};
  await resolveDesignHandoffSources(reviewed,project,{sourceFor,referenceFor:async()=>bytes});
  await assert.rejects(resolveDesignHandoffSources(reviewed,project,{sourceFor,referenceFor:async()=>Buffer.from("changed")}),/damaged/u);
  await assert.rejects(resolveDesignHandoffSources(reviewed,project,{sourceFor}),/unproven/u);
});

test("complete serialized context budgets include packet and wrappers before publication",async()=>{
  const {serializeDesignHandoffContext}=await import("./design-handoff-packet-authority.js");
  const {packet}=fixture();const html="x".repeat(512*1024);const sha256=createHash("sha256").update(html).digest("hex");
  const screen={...packet.reviewedScope.screens[0]!,sha256,byteSize:Buffer.byteLength(html)};
  const base={...withoutDigest(packet),source:{...packet.source,...screen},reviewedScope:{...packet.reviewedScope,screens:[screen]}};
  const reviewed={...base,reviewDigest:designHandoffReviewDigest(base)};
  assert.equal(parseDesignHandoffPacket(reviewed).version,2);
  assert.throws(()=>serializeDesignHandoffContext(reviewed,[{revisionId:screen.revisionId,html}]),/complete reviewed handoff context/u);
});
test("benign authentication design briefs pass while credential assignments remain rejected",()=>{
  const {packet}=fixture();
  for(const brief of ["Design password reset","Improve API key management"]){const base={...withoutDigest(packet),reviewedScope:{...packet.reviewedScope,brief}};assert.equal(parseDesignHandoffPacket({...base,reviewDigest:designHandoffReviewDigest(base)}).version,2);}
  for(const brief of ["password: actual-secret","API key = secret-value"]){const base={...withoutDigest(packet),reviewedScope:{...packet.reviewedScope,brief}};assert.throws(()=>designHandoffReviewDigest(base),/unsafe/u);}
});

test("reviewed language overhead participates in the same preflight byte budget",async()=>{
  const {serializeDesignHandoffContext}=await import("./design-handoff-packet-authority.js");
  const {normalizeDesignLanguageDocument,designLanguageContentHash}=await import("./design-language-core.js");
  const {packet}=fixture();const html="x".repeat(510*1024);const sha256=createHash("sha256").update(html).digest("hex");
  const screen={...packet.reviewedScope.screens[0]!,sha256,byteSize:Buffer.byteLength(html)};
  const base={...withoutDigest(packet),source:{...packet.source,...screen},reviewedScope:{...packet.reviewedScope,screens:[screen]}};
  const sources=[{revisionId:screen.revisionId,html}];
  serializeDesignHandoffContext({...base,reviewDigest:designHandoffReviewDigest(base)},sources);
  const language=normalizeDesignLanguageDocument({version:1,name:"Reviewed",guidance:"x".repeat(4000),tokens:{colors:{},spacing:{},typography:{},radii:{}}});
  const withLanguage={...base,reviewedScope:{...base.reviewedScope,designLanguageHash:designLanguageContentHash(language)}};
  assert.throws(()=>serializeDesignHandoffContext({...withLanguage,reviewDigest:designHandoffReviewDigest(withLanguage)},sources,language),/byte limit/u);
});
