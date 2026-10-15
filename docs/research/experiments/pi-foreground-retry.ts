/** Offline research: repeated rejected calls versus valid pending polling.
 * Setup from repo root: npm ci
 * Run: ./node_modules/.bin/tsx docs/research/experiments/pi-foreground-retry.ts
 * Real managed harness with faux provider and in-memory journal; no network,
 * paid inference, real jobs, or production policy changes. The scripted model
 * repeats five times, so this does not establish an unbounded real-model loop.
 */
import assert from 'node:assert/strict';
import { createModels, Type } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { InMemorySessionRepo } from '../../../main/services/pi-session-repository-port.js';
import { createPiSessionPort } from '../../../main/services/pi-session-port.js';
import { PiAgentRuntimeHarness } from '../../../main/services/pi-agent-runtime-harness.js';
import { convertToLlm } from '../../../main/services/pi-legacy-harness.js';
import { appendPiMessages } from '../../../main/services/pi-compaction-session-store.js';
for(const variant of ['invalid-arguments','successful-polling']) {
 const core=createFauxCore({provider:`retry-probe-${variant}`});
 core.setResponses([...Array.from({length:5},()=>fauxAssistantMessage([fauxToolCall('probe_status',variant==='invalid-arguments'?{}:{job:'fixture'})],{stopReason:'toolUse'})),fauxAssistantMessage('finished fixture')]);
 const model=core.getModel();
 const session=createPiSessionPort(await new InMemorySessionRepo().create({id:`retry-${variant}`}));
 let executions=0; let requests=0;
 const harness=new PiAgentRuntimeHarness({convertToLlm,streamFn:(m,c,o)=>{requests++;return core.streamSimple(m,c,o)},initialState:{systemPrompt:'Probe',thinkingLevel:'off',messages:[],model,tools:[{name:'probe_status',label:'Probe status',description:'Read fixture status',parameters:Type.Object({job:Type.String()}),replay:'safe',execute:async()=>{executions++;return {content:[{type:'text',text:'pending'}],details:null}}}]},durability:{session,appendMessages:appendPiMessages,compaction:{models:createModels(),model,thinkingLevel:'off'}}});
 const result=await harness.runManaged({kind:'append-and-run',message:{role:'user',content:'Check fixture',timestamp:1}});
 const branch=await session.getBranch();
 const errors=branch.filter(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.isError).length;
 assert.equal(executions,variant==='invalid-arguments'?0:5);assert.equal(result.kind,'completed');assert.equal(requests,6);assert.equal(errors,variant==='invalid-arguments'?5:0);
 console.log(JSON.stringify({variant,result:result.kind,requests,executions,errors}));
}
