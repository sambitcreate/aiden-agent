/** Bounded offline retention diagnostic, separate from the long-running soak.
 * Setup: npm ci; npm --prefix packages/cli ci; npm --prefix packages/cli run build
 * Run: node --expose-gc docs/research/experiments/cli-daemon-lifecycle-retention.mjs
 * Reuses the preserved soak with an independent temporary profile for30seconds.
 * Weak references observe only synthetic SDK objects; no heap/private-data dumps.
 * Collected objects are evidence against retention of those objects only, not a
 * proof that every resource or cache is bounded. Requires explicit forced GC.
 */
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as api from '../../../packages/cli/dist/parity-test-api.js';
assert.equal(typeof globalThis.gc,'function','Run with --expose-gc');
const dir=await mkdtemp(join(tmpdir(),'aiden-retention-observer-'));
const refs=[];
let prototype,originalBind;
try {
 const loader=new api.DefaultResourceLoader({cwd:dir,agentDir:dir,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true});await loader.reload();
 const model={id:'offline',name:'Offline',provider:'fixture',api:'openai-completions',baseUrl:'http://127.0.0.1:1',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const {session:seed}=await api.createAgentSession({cwd:dir,agentDir:dir,model,resourceLoader:loader,sessionManager:api.SessionManager.inMemory(dir),settingsManager:api.SettingsManager.inMemory({}),tools:[]});
 prototype=Object.getPrototypeOf(seed);originalBind=prototype.bindExtensions;seed.dispose();
 prototype.bindExtensions=async function(...args){
  refs.push({session:new globalThis.WeakRef(this),manager:new globalThis.WeakRef(this.sessionManager),agent:new globalThis.WeakRef(this.agent),runner:new globalThis.WeakRef(this.extensionRunner)});
  return originalBind.apply(this,args);
 };
 const output=join(dir,'accelerated-results.json');
 process.argv=[process.argv[0],process.argv[1],'--duration-seconds','30','--interval-seconds','0','--output',output];
 await import('./cli-daemon-lifecycle-soak.mjs');
 const result=JSON.parse(await readFile(output,'utf8'));assert.equal(result.status,'passed');
 const samples=[];
 for(const idleMs of [0,1000,5000]){
  await delay(idleMs);globalThis.gc();await delay(0);globalThis.gc();
  const alive=Object.fromEntries(['session','manager','agent','runner'].map(kind=>[kind,refs.filter(row=>row[kind].deref()!==undefined).length]));
  samples.push({idleMs,alive,...process.memoryUsage(),resources:process.getActiveResourcesInfo()});
 }
 console.log(JSON.stringify({evidenceKind:'synthetic-sdk-object-retention',observed:refs.length,counts:result.counts,receiptCount:result.receipts.length,receiptJsonBytes:JSON.stringify(result.receipts).length,firstHeap:result.receipts[0].heapUsed,lastCycleHeap:result.receipts.at(-1).heapUsed,samples,limitations:['Weak-reference collection is observational, not a timing guarantee.','This includes observer references and imported module top-level state.','Resource/RSS trends alone do not prove a leak.']}));
}finally{if(prototype&&originalBind)prototype.bindExtensions=originalBind;await rm(dir,{recursive:true,force:true});}
