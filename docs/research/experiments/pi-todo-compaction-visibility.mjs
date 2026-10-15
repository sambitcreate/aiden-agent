/**
 * Offline research probe: real Pi SDK compaction and branch-local todo state.
 * Setup from repository root (dependency setup needs ordinary registry access):
 *   npm ci
 *   npm --prefix packages/cli ci
 *   npm --prefix packages/cli run build
 * Run:
 *   node docs/research/experiments/pi-todo-compaction-visibility.mjs
 *
 * Execution uses only a temporary agent directory and localhost synthetic model.
 * No paid inference, real credentials, model-catalog refresh, or external writes.
 * The summarizer deliberately omits task subjects and the continuation deliberately
 * creates a duplicate. This proves transport/state behavior, not real-model error
 * rates or a causal benefit from a planning reminder. All temporary data is removed.
 * Results and interpretation: ../2609.20804-pi-harness-deep-dive.md
 */
import assert from 'node:assert/strict';
import console from 'node:console';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, createCliModelRuntime, createTodoInlineExtension } from '../../../packages/cli/dist/parity-test-api.js';
const dir=await mkdtemp(join(tmpdir(),'aiden-compaction-plan-'));
const subjects=['CHECKPOINT_ALPHA_SOURCE','CHECKPOINT_BETA_IMPLEMENT','CHECKPOINT_GAMMA_VERIFY'];
let phase='seed';let phaseRequest=0;const requests=[];
const server=createServer(async(req,res)=>{
 let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push({phase,body});
 let content='Fixture finished';let calls;const n=phaseRequest++;
 if(phase==='seed'&&n===0) calls=subjects.map((subject,i)=>({index:i,id:`create-${i}`,type:'function',function:{name:'todo',arguments:JSON.stringify({action:'create',subject})}}));
 if(phase==='filler')content='Routine observation. '.repeat(3000);
 if(phase==='compact')content='## Goal\nContinue the coding task.\n## Progress\nWork has begun.\n## Next steps\nContinue implementation and verification.';
 if(phase==='resume'&&n===0)calls=[{index:0,id:'duplicate',type:'function',function:{name:'todo',arguments:JSON.stringify({action:'create',subject:subjects[0]})}}];
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:calls?{role:'assistant',tool_calls:calls}:{role:'assistant',content},finish_reason:null}]})}\n\n`);
 res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let session;
try{
 const port=server.address().port;
 await writeFile(join(dir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'test-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 const runtime=await createCliModelRuntime(dir);
 const todo=createTodoInlineExtension({latestContext:()=>undefined});
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[todo]});await loader.reload();
 const manager=SessionManager.inMemory(dir);
 ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('fixture','fixture'),resourceLoader:loader,sessionManager:manager,settingsManager:SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:0,reserveTokens:4096}}),tools:['todo']}));
 await session.bindExtensions({mode:'rpc'});
 await session.prompt('Track these substantive checkpoints.',{expandPromptTemplates:false});assert.equal(todo.snapshot().tasks.length,3);
 const planLeaf=manager.getLeafId();
 phase='filler';phaseRequest=0;await session.prompt('Read a lengthy unrelated intermediate observation.',{expandPromptTemplates:false});
 phase='compact';phaseRequest=0;await session.compact('Provide a concise checkpoint.');
 const afterCompact=todo.snapshot().tasks.length;
 phase='resume';phaseRequest=0;await session.prompt('Continue the work.',{expandPromptTemplates:false});
 const firstResume=requests.find(r=>r.phase==='resume').body;
 const visible=subjects.map(subject=>JSON.stringify(firstResume.messages).includes(subject));
 const taskCount=todo.snapshot().tasks.length;
 await session.navigateTree(planLeaf,{summarize:false});
 const afterBranch=todo.snapshot().tasks.length;
 console.log(JSON.stringify({requests:requests.map(r=>({phase:r.phase,chars:JSON.stringify(r.body.messages).length})),summaryRequests:requests.filter(r=>r.phase==='compact').length,afterCompactTasks:afterCompact,firstResumedRequestPlanSubjectsVisible:visible,afterScriptedDuplicateCreateTasks:taskCount,afterBranchTasks:afterBranch}));
 assert.equal(afterCompact,3);assert.deepEqual(visible,[false,false,false]);assert.equal(taskCount,4);assert.equal(afterBranch,3);
}finally{session?.dispose();server.closeAllConnections();await new Promise(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
