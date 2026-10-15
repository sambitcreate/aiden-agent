/** Research only: persistent synthetic profile and two reused journals.
 * Setup: npm ci; npm --prefix packages/cli ci; npm --prefix packages/cli run build
 * Smoke: node --expose-gc docs/research/experiments/cli-daemon-persistent-soak.mjs --duration-seconds 20 --interval-seconds 0 --max-cycles 4 --restart-after-cycles 2
 * Parent launch: same command --duration-seconds 4800 --interval-seconds 45 --max-cycles 120
 * Optional --output absolute/path.json. SIGINT/SIGTERM cancel the active chat;
 * a 20-second turn watchdog cancels, then a 10-second hard watchdog exits failed.
 * Setup, restart, and final cleanup are outside the turn watchdog; parent supervision
 * must terminate a stuck process. Duration bounds admission, not those cleanup calls.
 * Loopback scripted responses only; no model-quality or compaction efficacy claim.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import * as api from '../../../packages/cli/dist/parity-test-api.js';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const duration=Number(args.get('--duration-seconds')??20),interval=Number(args.get('--interval-seconds')??1),maxCycles=Number(args.get('--max-cycles')??120);
const restartAfter=args.has('--restart-after-cycles')?Number(args.get('--restart-after-cycles')):undefined;
assert.ok(duration>0&&duration<=5100&&Number.isFinite(duration));assert.ok(interval>=0&&interval<=60&&Number.isFinite(interval));
assert.ok(Number.isInteger(maxCycles)&&maxCycles>=2&&maxCycles<=120);
assert.ok(restartAfter===undefined||(Number.isInteger(restartAfter)&&restartAfter>=1&&restartAfter<maxCycles));
assert.ok(!process.env.AIDEN_CONFIG_DIR?.trim(),'Unset AIDEN_CONFIG_DIR to preserve isolated memory storage');
const output=resolve(args.get('--output')??'docs/research/experiments/cli-daemon-persistent-soak-results.json');
const root=mkdtempSync(join(tmpdir(),'aiden-persistent-soak-')),started=Date.now(),deadline=started+duration*1000;
const subject={a:'PERSISTENT_A_TASK_731',b:'PERSISTENT_B_TASK_942'},canary={a:'PERSISTENT_A_USER_731',b:'PERSISTENT_B_USER_942'};
const state={a:'pending',b:'pending'},snapshots={a:0,b:0};
const counts={cycles:0,completedTurns:0,requests:0,binds:0,shutdowns:0,disposals:0,restarts:0,wholePromptChecks:0,journalChecks:0,compactionEntries:0};
const receipts=[],errors=[];let daemon,current,endpoint,ownerSubscriptions=0,cancelled=false;
const record={version:1,evidenceKind:'offline-persistent-profile-lifecycle-soak',status:'running',startedAt:new Date(started).toISOString(),durationSeconds:duration,intervalSeconds:interval,maxCycles,restartAfterCycles:restartAfter??null,node:process.version,forcedGcAvailable:typeof globalThis.gc==='function',counts,receipts,
 sourceSha256:Object.fromEntries(['packages/cli/dist/parity-test-api.js','packages/cli/src/daemon-chats.ts','packages/cli/src/extensions/todo.ts'].map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')])),
 limitations:['Scripted sequential interleaving, not simultaneous execution or model decisions.','Fixed synthetic profile and two bounded journals; no private profiles or real providers.','128k declared context avoids intentional pressure; unexpected hidden summaries fail the two-request protocol. Compaction entries are counted, not assumed absent.','Heap/resource trends are diagnostics and include growing receipts/journals; not proof of a leak or its absence.','SIGINT/SIGTERM and turn timeout are failures. Hard watchdog may leave a synthetic temp directory. Setup/restart/final cleanup are outside turn watchdog and require parent supervision if stuck.']};
function save(){writeFileSync(`${output}.next`,JSON.stringify(record,null,2)+'\n');renameSync(`${output}.next`,output);}
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);assert.equal(url.origin,endpoint,'Only this loopback endpoint is permitted');return originalFetch(input,init);};
const server=createServer(async(req,res)=>{try{
 assert.ok(current,'No provider request outside an admitted turn');let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body),foreign=current.chat==='a'?'b':'a';
 const serialized=JSON.stringify(request.messages);assert.ok(!serialized.includes(subject[foreign]),'Foreign task leaked in full provider history');assert.ok(!serialized.includes(canary[foreign]),'Foreign user leaked in full provider history');assert.ok(serialized.includes(canary[current.chat]),'Own user intent absent');
 assert.ok(Buffer.byteLength(serialized)<300000,'Bounded provider history exceeded300k bytes');current.maxRequestBytes=Math.max(current.maxRequestBytes,Buffer.byteLength(serialized));counts.wholePromptChecks++;counts.requests++;current.requests++;
 assert.ok(current.requests<=2,'Unexpected additional request, including hidden summary');const first=current.requests===1;
 if(!first){const last=request.messages.filter(m=>m.role==='tool').at(-1);assert.ok(last);assert.ok(serialized.includes(subject[current.chat]),'Restored checkpoint absent in provider history');if(current.action.action!=='update')assert.ok(JSON.stringify(last).includes(subject[current.chat]),'Checkpoint absent from listing/create observation');}
 const delta=first?{role:'assistant',tool_calls:[{index:0,id:`persistent-${counts.requests}`,type:'function',function:{name:'todo',arguments:JSON.stringify(current.action)}}]}:{role:'assistant',content:'Verified persistent checkpoint.'};
 res.writeHead(200,{'content-type':'text/event-stream'});for(const [d,finish] of [[delta,null],[{},first?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:d,finish_reason:finish}]})}\n\n`);res.end('data: [DONE]\n\n');
 }catch(error){errors.push(error);res.writeHead(500);res.end('Offline invariant failed');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));endpoint=`http://127.0.0.1:${server.address().port}`;
const model={id:'fixture',name:'Persistent fixture',provider:'fixture',api:'openai-completions',baseUrl:`${endpoint}/v1`,reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const loader=new api.DefaultResourceLoader({cwd:root,agentDir:root,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true});await loader.reload();
const {session:seed}=await api.createAgentSession({cwd:root,agentDir:root,model,resourceLoader:loader,sessionManager:api.SessionManager.inMemory(root),settingsManager:api.SettingsManager.inMemory({}),tools:[]});
const prototype=Object.getPrototypeOf(seed),originalBind=prototype.bindExtensions;seed.dispose();
prototype.bindExtensions=async function(...parameters){counts.binds++;const emit=this.extensionRunner.emit.bind(this.extensionRunner),dispose=this.dispose.bind(this);this.extensionRunner.emit=async event=>{if(event.type==='session_shutdown')counts.shutdowns++;return emit(event);};this.dispose=()=>{counts.disposals++;return dispose();};return originalBind.apply(this,parameters);};
const owner={id:0,documentId:'persistent-soak-owner',isDestroyed:()=>false,onInvalidated:()=>{ownerSubscriptions++;return()=>{ownerSubscriptions--;};},send:(channel,value)=>{if(channel==='chat:error')errors.push(value);}};
function cancel(){cancelled=true;if(current)void daemon?.llmClient.cancelChat(current.chat);}
process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
let workspace;
async function turn(chat,action){
 assert.ok(!cancelled,'Cancelled');current={chat,action,requests:0,maxRequestBytes:0};const stream=`persistent-${counts.completedTurns}`,admission=daemon.llmClient.beginChatTurn(chat,stream,owner.documentId);assert.ok(admission);
 let timedOut=false;const watchdog=setTimeout(()=>{timedOut=true;void daemon.llmClient.cancelChat(chat);},20000);
 const hard=setTimeout(()=>{record.status='failed';record.error='Hard turn watchdog expired';save();console.error(record.error);process.exit(1);},30000);
 try{
  const content=`${canary[chat]} ${action.action} checkpoint ${counts.completedTurns}`;await daemon.chatStore.appendMessage(chat,{role:'user',content});admission.settleAsyncWork();
  assert.equal(await daemon.llmClient.start(stream,{chatId:chat,workspaceId:workspace.id,providerId:'fixture',model:'fixture',messages:[{role:'user',content}]},owner,{usageSource:'chat'}),true);await daemon.llmClient.waitForChatIdle(chat);
  assert.ok(!timedOut&&!cancelled,'Turn timeout or cancellation');assert.deepEqual(errors,[]);assert.equal(current.requests,2);
  const release=api.acquireLease(daemon.sessionPath(chat));release();assert.equal(ownerSubscriptions,0);
  if(action.action==='update')state[chat]=action.status;snapshots[chat]++;
  const branch=api.SessionManager.open(daemon.sessionPath(chat)).getBranch(),foreign=chat==='a'?'b':'a',serialized=JSON.stringify(branch);
  assert.ok(!serialized.includes(subject[foreign])&&!serialized.includes(canary[foreign]),'Foreign evidence in durable branch');
  const todos=branch.filter(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='todo');assert.equal(todos.length,snapshots[chat]);
  for(const entry of todos){assert.notEqual(entry.message.isError,true);const detail=entry.message.details;assert.equal(detail.kind,'aiden.todo.snapshot');assert.equal(detail.version,1);assert.equal(detail.nextId,2);assert.equal(detail.tasks.length,1);assert.equal(detail.tasks[0].id,1);assert.equal(detail.tasks[0].subject,subject[chat]);}
  assert.equal(todos.at(-1).message.details.tasks[0].status,state[chat]);counts.journalChecks++;counts.completedTurns++;
  return current.maxRequestBytes;
 }finally{clearTimeout(watchdog);clearTimeout(hard);admission.release();current=undefined;}
}
try{
 api.atomicJson(join(root,'models.json'),{providers:{fixture:{api:'openai-completions',baseUrl:`${endpoint}/v1`,apiKey:'synthetic-only',models:[model]}}});workspace=await api.workspaceCommand(root,['add',root]);await api.workspaceCommand(root,['access',workspace.id,'full']);daemon=api.createDaemonChats(root);
 for(const chat of ['a','b'])await daemon.chatStore.create({id:chat,title:`Synthetic ${chat}`,workspaceId:workspace.id});
 for(const chat of ['a','b'])await turn(chat,{action:'create',subject:subject[chat]});
 while((Date.now()<deadline||counts.cycles===0)&&counts.cycles<maxCycles){
  assert.ok(!cancelled,'Cancelled');const cycle=counts.cycles+1;let maxRequestBytes=0;
  for(const chat of cycle%2?['a','b']:['b','a']){const action=cycle%2?{action:'update',id:1,status:Math.floor(cycle/2)%2?'pending':'in_progress'}:{action:'list'};maxRequestBytes=Math.max(maxRequestBytes,await turn(chat,action));}
  counts.cycles++;
  if(counts.restarts===0&&(restartAfter===undefined?Date.now()>=started+duration*500:counts.cycles>=restartAfter)){await daemon.stop();daemon=api.createDaemonChats(root);counts.restarts++;}
  assert.equal(counts.binds,counts.completedTurns);assert.equal(counts.shutdowns,counts.completedTurns);assert.equal(counts.disposals,counts.completedTurns);assert.equal(counts.requests,counts.completedTurns*2);
  const journals=Object.fromEntries(['a','b'].map(chat=>{const branch=api.SessionManager.open(daemon.sessionPath(chat)).getBranch();return[chat,{entries:branch.length,bytes:statSync(daemon.sessionPath(chat)).size,compactions:branch.filter(e=>e.type==='compaction').length,snapshots:snapshots[chat],status:state[chat]}];}));
  counts.compactionEntries=journals.a.compactions+journals.b.compactions;
  await delay(50);globalThis.gc?.();const resources=process.getActiveResourcesInfo().reduce((acc,n)=>(acc[n]=(acc[n]??0)+1,acc),{});
  receipts.push({cycle,elapsedMs:Date.now()-started,maxRequestBytes,journals,...process.memoryUsage(),resources});save();console.log(JSON.stringify({cycle,completedTurns:counts.completedTurns,restarts:counts.restarts,maxRequestBytes,journals}));
  const sleep=Math.min(interval*1000,Math.max(0,deadline-Date.now()));if(sleep)await delay(sleep);
 }
 assert.ok(!cancelled,'Cancelled');record.status='passed';record.stopReason=counts.cycles>=maxCycles?'bounded-cycle-cap':'duration';
}catch(error){record.status='failed';record.error=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);process.exitCode=1;}
finally{
 await daemon?.stop();prototype.bindExtensions=originalBind;globalThis.fetch=originalFetch;process.off('SIGINT',cancel);process.off('SIGTERM',cancel);server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});globalThis.gc?.();record.finishedAt=new Date().toISOString();record.finalResources=process.getActiveResourcesInfo();record.finalMemory=process.memoryUsage();save();console.log(JSON.stringify({status:record.status,...counts}));
}
