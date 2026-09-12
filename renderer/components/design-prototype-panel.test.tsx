import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignPrototypePanel } from "./design-prototype-panel";
import type { DesignProjectSnapshotV2 } from "../shared/design-projects";
const project:DesignProjectSnapshotV2={version:2,id:"project:one",revision:1,title:"One",titlePolicy:{state:"manual"},chatId:"chat:one",connectionState:"prototype-only",createdAt:1,updatedAt:1,canvas:{viewport:"desktop",flowViewport:{x:0,y:0,zoom:1},nodes:[]},referenceAssetIds:[]};
const render=(value:DesignProjectSnapshotV2)=>renderToStaticMarkup(<DesignPrototypePanel project={value} disabled={false} screenTitles={{}} prepareProject={async()=>value} onProjectChange={()=>{}}/>);
test("empty projects cannot save, verify, or play a prototype",()=>{
  const html=render(project);
  for(const label of ["Save prototype","Verify links","Play prototype"]) assert.match(html,new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
  assert.match(html,/Prototype · No prototype/);
  assert.match(html,/aria-label="Prototype element selector"/);
});
test("a graph without matching source membership cannot be played",()=>{
  const hash="a".repeat(64);
  const html=render({...project,prototype:{version:1,entryMediaId:"design:a",revision:1,contentHash:hash,nodes:[{lineageId:"lineage:a",mediaId:"design:a",contentHash:hash}],edges:[{id:"edge:a",fromMediaId:"design:a",toMediaId:"design:a",trigger:"click",selector:"#go",transition:"none"}],verification:{graphHash:hash,verifiedAt:1,passedEdgeIds:["edge:a"]}}});
  assert.match(html,/Prototype · broken/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>Play prototype<\/button>/);
});
