import assert from "node:assert/strict";
import test from "node:test";
import {normalizeDesignPrototypeInput,designPrototypeContentHash,parseDesignPrototypeGraph,designPrototypeStatus,normalizeDesignPrototypeVerification} from "./design-prototype-core.js";
import type {DesignProjectCanvasV2} from "../../renderer/shared/design-projects.js";
const input=()=>({version:1,entryMediaId:"design:a",nodes:[{lineageId:"lineage:a",mediaId:"design:a",contentHash:"a".repeat(64)},{lineageId:"lineage:b",mediaId:"design:b",contentHash:"b".repeat(64)}],edges:[{id:"edge:next",fromMediaId:"design:a",toMediaId:"design:b",trigger:"click",selector:"#next",transition:"fade"}]});
const canvas=():DesignProjectCanvasV2=>({viewport:"desktop",flowViewport:{x:0,y:0,zoom:1},nodes:input().nodes.map(node=>({id:node.lineageId,kind:"artboard",canonicalOrigin:"generated-artifact",x:0,y:0,lineageId:node.lineageId,activeMediaId:node.mediaId,artifactMediaIds:[node.mediaId],presentation:{surface:"web",frame:{preset:"desktop",width:1000,height:800}}}))});
test("Prototype canonical graph hashing includes exact sources and rejects forged state",()=>{
  const graph=normalizeDesignPrototypeInput(input());
  const contentHash=designPrototypeContentHash(graph);
  assert.equal(designPrototypeContentHash({...graph,nodes:[...graph.nodes].reverse()}),contentHash);
  assert.notEqual(designPrototypeContentHash({...graph,nodes:graph.nodes.map(node=>({...node,contentHash:"c".repeat(64)}))}),contentHash);
  assert.ok(parseDesignPrototypeGraph({...graph,revision:1,contentHash}));
  assert.equal(parseDesignPrototypeGraph({...graph,revision:1,contentHash:"0".repeat(64)}),undefined);
  assert.throws(()=>normalizeDesignPrototypeInput({...input(),status:"verified"}));
  assert.throws(()=>normalizeDesignPrototypeInput({...input(),verification:{passedEdgeIds:["edge:next"]}}));
});
test("Prototype rejects malformed references, selectors, keys, transitions and limits",()=>{
  for (const patch of [{toMediaId:"design:missing"},{fromMediaId:"https://outside"},{selector:"a[href]"},{selector:"#id > script"},{selector:'[data-aiden-id="unsafe\\x"]'},{trigger:"load"},{transition:"script"},{trigger:"keydown"},{key:"Enter"},{trigger:"keydown",key:"F12"}]) assert.throws(()=>normalizeDesignPrototypeInput({...input(),edges:[{...input().edges[0],...patch}]}));
  assert.throws(()=>normalizeDesignPrototypeInput({...input(),nodes:[...input().nodes,input().nodes[0]]}));
  assert.throws(()=>normalizeDesignPrototypeInput({...input(),edges:[...input().edges,{...input().edges[0],id:"edge:ambiguous"}]}));
  assert.throws(()=>normalizeDesignPrototypeInput({...input(),nodes:Array.from({length:21},(_,i)=>({lineageId:`lineage:${i}`,mediaId:`design:${i}`,contentHash:"a".repeat(64)}))}));
  assert.throws(()=>normalizeDesignPrototypeInput({...input(),edges:Array.from({length:41},(_,i)=>({...input().edges[0],id:`edge:${i}`,selector:`#link${i}`}))}));
  assert.doesNotThrow(()=>normalizeDesignPrototypeInput({...input(),edges:[{...input().edges[0],trigger:"keydown",key:"Enter",selector:'[data-aiden-id="next"]'}]}));
});
test("Prototype status distinguishes verification, active revisions, and missing sources",()=>{
  const inputGraph=normalizeDesignPrototypeInput(input());
  const graph={...inputGraph,revision:1,contentHash:designPrototypeContentHash(inputGraph)};
  assert.equal(designPrototypeStatus(graph,canvas()),"unverified");
  const verification=normalizeDesignPrototypeVerification({graphHash:graph.contentHash,verifiedAt:1,passedEdgeIds:["edge:next"]},graph,graph.contentHash);
  const verified={...graph,verification};
  assert.equal(designPrototypeStatus(verified,canvas()),"verified");
  const stale=canvas();stale.nodes[0]!.activeMediaId="design:new";
  assert.equal(designPrototypeStatus(verified,stale),"stale");
  const broken=canvas();broken.nodes=[];
  assert.equal(designPrototypeStatus(verified,broken),"broken");
  assert.equal(designPrototypeStatus({...graph,edges:[]},canvas()),"static");
  assert.throws(()=>normalizeDesignPrototypeVerification({graphHash:graph.contentHash,verifiedAt:1,passedEdgeIds:[]},graph,graph.contentHash));
  assert.throws(()=>normalizeDesignPrototypeVerification({graphHash:graph.contentHash,verifiedAt:1,passedEdgeIds:["edge:forged"]},graph,graph.contentHash));
});

test("Prototype start Screen is explicit regardless of canonical node order",()=>{
 const graph=normalizeDesignPrototypeInput({...input(),entryMediaId:"design:b"});
 assert.equal(graph.nodes[0].mediaId,"design:a");
 assert.equal(graph.entryMediaId,"design:b");
 assert.notEqual(designPrototypeContentHash(graph),designPrototypeContentHash(input()));
 assert.throws(()=>normalizeDesignPrototypeInput({...input(),entryMediaId:"design:missing"}));
});
