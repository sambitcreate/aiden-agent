/** Offline stronger isolation oracle, complementary to the long lifecycle soak.
 * Setup: npm ci; npm --prefix packages/cli ci; npm --prefix packages/cli run build
 * Run: node docs/research/experiments/cli-daemon-isolation.mjs
 * Four turns, actual daemon+SDK+JSONL journals, localhost scripted provider only.
 * Examines whole provider messages and complete durable todo snapshots, not only
 * the last tool's text. Canary absence proves only these synthetic boundaries.
 */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as api from '../../../packages/cli/dist/parity-test-api.js';
const dir=await mkdtemp(join(tmpdir(),'aiden-isolation-'));
const subjects={a:'PRIVATE_A_CHECKPOINT_731',b:'PRIVATE_B_CHECKPOINT_942'};
const canaries={a:'PRIVATE_A_USER_REQUEST_731',b:'PRIVATE_B_USER_REQUEST_942'};
let current,daemon;
const observations=[],errors=[];
const server=createServer(async(req,res)=>{
 try {
  let text='';for await(const chunk of req)text+=chunk;
  const request=JSON.parse(text);assert.ok(current);
  const foreign=current.chat==='a'?'b':'a';
  const serialized=JSON.stringify(request.messages);
  assert.ok(!serialized.includes(subjects[foreign]),'foreign plan in provider request');
  assert.ok(!serialized.includes(canaries[foreign]),'foreign user request in provider request');
  assert.ok(serialized.includes(canaries[current.chat]),'own user request missing');
  const first=current.requests++===0;
  if(!first){assert.equal(current.requests,2);assert.ok(serialized.includes(subjects[current.chat]));}
  observations.push({chat:current.chat,action:current.action,first,foreignPlan:false,foreignUser:false});
  const delta=first?{role:'assistant',tool_calls:[{index:0,id:`${current.chat}-${current.action}`,type:'function',function:{name:'todo',arguments:JSON.stringify(current.action==='create'?{action:'create',subject:subjects[current.chat]}:{action:'list'})}}]}:{role:'assistant',content:'Verified local checkpoint.'};
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:first?'tool_calls':'stop'}]})}\n\n`);res.end('data: [DONE]\n\n');
 }catch(error){errors.push(error);res.writeHead(500);res.end('Synthetic isolation assertion failed');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 api.atomicJson(join(dir,'models.json'),{providers:{fixture:{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'test-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}});
 const workspace=await api.workspaceCommand(dir,['add',dir]);await api.workspaceCommand(dir,['access',workspace.id,'full']);
 daemon=api.createDaemonChats(dir);
 const emitted=[];const owner={id:0,documentId:'isolation-owner',isDestroyed:()=>false,onInvalidated:()=>()=>{},send:(channel,value)=>emitted.push({channel,value})};
 for(const chat of ['a','b'])await daemon.chatStore.create({id:chat,title:`Fixture ${chat}`,workspaceId:workspace.id});
 for(const [chat,action] of [['a','create'],['b','create'],['a','list'],['b','list']]){
  current={chat,action,requests:0};const stream=`${chat}-${action}`;const content=`${canaries[chat]} ${action} checkpoint`;
  const admission=daemon.llmClient.beginChatTurn(chat,stream,owner.documentId);assert.ok(admission);
  try {
   await daemon.chatStore.appendMessage(chat,{role:'user',content});admission.settleAsyncWork();
   await daemon.llmClient.start(stream,{chatId:chat,workspaceId:workspace.id,providerId:'fixture',model:'fixture',messages:[{role:'user',content}]},owner,{usageSource:'chat'});
   await daemon.llmClient.waitForChatIdle(chat);assert.deepEqual(errors,[]);assert.equal(current.requests,2);
   const manager=api.SessionManager.open(daemon.sessionPath(chat));
   const branch=manager.getBranch();const foreign=chat==='a'?'b':'a';
   assert.ok(!JSON.stringify(branch).includes(subjects[foreign]));assert.ok(!JSON.stringify(branch).includes(canaries[foreign]));
   const checkpoints=branch.filter(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolName==='todo'&&e.message.isError!==true);
   assert.equal(checkpoints.length,action==='create'?1:2);
   for(const checkpoint of checkpoints){
    assert.deepEqual(checkpoint.message.details.tasks.map(t=>({id:t.id,subject:t.subject,status:t.status})),[{id:1,subject:subjects[chat],status:'pending'}]);
    assert.equal(checkpoint.message.details.nextId,2);
   }
  }finally{admission.release();}
 }
 assert.equal(emitted.filter(e=>e.channel==='chat:error').length,0);
 assert.equal(observations.length,8);
 console.log(JSON.stringify({status:'passed',turns:4,providerRequests:8,wholePromptCanaryChecks:8,journalSnapshotChecks:6,observations,limitation:'Synthetic canaries and sequential turns; not a universal noninterference or concurrency proof.'}));
}finally{await daemon?.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
