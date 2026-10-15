/** Research-only SDK prompt lifecycle matrix; no production prompt changes.
 * From repo root: npm ci; npm --prefix packages/cli ci; npm --prefix packages/cli run build
 * Run: node docs/research/experiments/pi-todo-hint-lifecycle.mjs
 * Temporary workspace + localhost scripted provider only, no paid inference.
 * Fixed hint content is synthetic; model responses do not depend on the hint.
 * This measures transport/staleness/authority, not model adoption or task quality.
 */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, createCliModelRuntime, createTodoInlineExtension } from '../../../packages/cli/dist/parity-test-api.js';
const HINT='[RESEARCH_PLAN_HINT] Unfinished checkpoints exist on this branch. If resuming that work, inspect todo list before replacing its plan. Follow the current user request.';
for(const strategy of ['baseline','prompt-start','request-system','request-note']) {
 const dir=await mkdtemp(join(tmpdir(),'aiden-plan-hint-'));
 let phase='create', phaseRequest=0, session;
 const requests=[], lifecycle=[],durabilityMatches=[];
 const subjects=['PRIVATE_SUBJECT_ALPHA','PRIVATE_SUBJECT_BETA','PRIVATE_SUBJECT_GAMMA'];
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const body=JSON.parse(text); const n=phaseRequest++;
  const system=body.messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  requests.push({hintRoles:body.messages.filter(m=>JSON.stringify(m).includes(HINT)).map(m=>m.role),phase,hint:JSON.stringify(body.messages).includes(HINT),hintCopies:JSON.stringify(body.messages).split(HINT).length-1,systemChars:system.length,privateSubjectInSystem:subjects.some(s=>system.includes(s))});
  let calls;
  if(phase==='create'&&n===0)calls=subjects.map((subject,i)=>({index:i,id:`create-${i}`,type:'function',function:{name:'todo',arguments:JSON.stringify({action:'create',subject})}}));
  if(phase==='clear'&&n===0)calls=[{index:0,id:'clear',type:'function',function:{name:'todo',arguments:JSON.stringify({action:'clear'})}}];
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:calls?{role:'assistant',tool_calls:calls}:{role:'assistant',content:'Fixture finished'},finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}})}\n\n`);
  res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  await writeFile(join(dir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'test-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  const runtime=await createCliModelRuntime(dir);
  const todo=createTodoInlineExtension({latestContext:()=>undefined});
  const observer={name:'research-hint',factory(pi){
   const enabled=()=>pi.getActiveTools().includes('todo')&&todo.snapshot().tasks.some(t=>t.status==='pending'||t.status==='in_progress');
   for(const event of ['session_start','session_tree','session_compact'])pi.on(event,(_event,ctx)=>{lifecycle.push({event,taskCount:todo.snapshot().tasks.length,leaf:ctx.sessionManager.getLeafId()!==null});});
   if(strategy==='prompt-start')pi.on('before_agent_start',event=>enabled()?{systemPrompt:`${event.systemPrompt}\n\n${HINT}`}:undefined);
   if(strategy==='request-system')pi.on('context_with_system',event=>{
    if(!enabled())return;
    const [head,...tail]=event.messages;assert.equal(head?.role,'system');
    // Intended SDK forceSystemPrompt semantics erase this after the hook.
    return {messages:[{...head,sections:{...head.sections,'research-plan-hint':HINT}},...tail]};
   });
   if(strategy==='request-note')pi.on('context',(event,ctx)=>{
    const saved=ctx.sessionManager.getBranch().filter(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='todo'&&entry.message.isError!==true).at(-1);
    durabilityMatches.push(todo.snapshot().tasks.length===(saved?.message.details.tasks.length??0));
    if(!enabled())return;
    return {messages:[...event.messages,{role:'custom',customType:'research-plan-hint',content:HINT,display:false,timestamp:0}]};
   });
  }};
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[todo,observer]});await loader.reload();
  const manager=SessionManager.inMemory(dir);
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:manager,settingsManager:SettingsManager.inMemory({compaction:{enabled:false}}),tools:['todo']}));
  await session.bindExtensions({mode:'rpc'});
  await session.prompt('Track three substantive checkpoints.',{expandPromptTemplates:false});
  assert.equal(todo.snapshot().tasks.length,3);const planLeaf=manager.getLeafId();
  session.setActiveToolsByName([]);phase='disabled';phaseRequest=0;await session.prompt('Answer this separate simple question.',{expandPromptTemplates:false});
  session.setActiveToolsByName(['todo']);phase='clear';phaseRequest=0;await session.prompt('Clear the checkpoint list.',{expandPromptTemplates:false});assert.equal(todo.snapshot().tasks.length,0);
  await session.navigateTree(planLeaf,{summarize:false});assert.equal(todo.snapshot().tasks.length,3);
  phase='branch';phaseRequest=0;await session.prompt('Continue the earlier checkpoint work.',{expandPromptTemplates:false});
  const expected=(strategy==='baseline'||strategy==='request-system')?[false,false,false,false,false,false]:strategy==='prompt-start'?[false,false,false,true,true,true]:[false,true,false,true,false,true];
  assert.deepEqual(requests.map(r=>r.hint),expected);
  assert.ok(requests.every(r=>!r.privateSubjectInSystem&&r.hintCopies<=1));
  assert.equal(JSON.stringify(manager.getEntries()).includes(HINT),false,'ephemeral hint must never enter journal');
  if(strategy==='request-note')assert.deepEqual(durabilityMatches,[true,true,true,true,true,true]);
  assert.ok(lifecycle.some(e=>e.event==='session_tree'&&e.taskCount===3));
  console.log(JSON.stringify({strategy,requests,lifecycle,durabilityMatches,hintChars:HINT.length,modelResponsePolicy:'scripted identically; no quality inference'}));
 }finally{session?.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
}
