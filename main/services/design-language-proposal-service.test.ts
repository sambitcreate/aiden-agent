import assert from "node:assert/strict";
import test from "node:test";
import { prepareDesignLanguageProposal } from "./design-language-proposal-service.js";
import type { DesignProjectSnapshotV2 } from "../../renderer/shared/design-projects.js";
import type { DesignLanguageDocumentV1 } from "../../renderer/shared/design-language.js";
const project:DesignProjectSnapshotV2={version:2,id:"project:one",revision:1,title:"One",titlePolicy:{state:"manual"},chatId:"chat:one",connectionState:"prototype-only",createdAt:1,updatedAt:1,canvas:{viewport:"desktop",flowViewport:{x:0,y:0,zoom:1},nodes:[]},referenceAssetIds:[]};
const document:DesignLanguageDocumentV1={version:1,name:"Calm",guidance:"Use generous spacing.",tokens:{colors:{accent:"#123456"},spacing:{},typography:{},radii:{}}};
const sources={derive:async()=>({document,provenance:{kind:"derived" as const,lineageId:"lineage:one",mediaId:"design:one",contentHash:"a".repeat(64)}}),workspace:async()=>({document,provenance:{kind:"workspace-snapshot" as const,id:"snapshot:one",revision:1,contentHash:"a".repeat(64)}})};
test("review identity binds exact source provenance even when semantic values do not change",async()=>{
  const first=await prepareDesignLanguageProposal(project,{projectId:project.id,mode:"workspace"},sources);
  const changed=await prepareDesignLanguageProposal(project,{projectId:project.id,mode:"workspace"},{...sources,workspace:async()=>({document,provenance:{kind:"workspace-snapshot",id:"snapshot:one",revision:2,contentHash:"b".repeat(64)}})});
  assert.equal(first.contentHash,changed.contentHash);
  assert.notEqual(first.reviewHash,changed.reviewHash);
});
test("proposal rejects forged provenance and imports only the exported subset",async()=>{
  await assert.rejects(prepareDesignLanguageProposal(project,{projectId:project.id,mode:"describe",document,provenance:{kind:"authored"}} as never,sources),/Invalid/);
  const authored=await prepareDesignLanguageProposal(project,{projectId:project.id,mode:"describe",document},sources);
  const imported=await prepareDesignLanguageProposal(project,{projectId:project.id,mode:"import",text:authored.markdown},sources);
  assert.equal(authored.contentHash,imported.contentHash);
  assert.deepEqual(imported.provenance,{kind:"imported"});
  await assert.rejects(prepareDesignLanguageProposal(project,{projectId:project.id,mode:"import",text:"---\ninclude: /private\n---"},sources));
});
