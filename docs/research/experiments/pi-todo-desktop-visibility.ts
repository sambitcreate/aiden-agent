/** Offline research: Desktop managed-harness plan visibility across controlled checkpoint summaries/tails.
 * Faux provider chooses list explicitly; this does not measure model recall or summary quality.
 * Setup from repo root: npm ci
 * Run: ./node_modules/.bin/tsx docs/research/experiments/pi-todo-desktop-visibility.ts
 * Synthetic fixtures only, no network/model calls or real tool effects.
 */
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { InMemorySessionRepo } from '../../../main/services/pi-session-repository-port.js';
import { createPiSessionPort } from '../../../main/services/pi-session-port.js';
import { PiAgentRuntimeHarness } from '../../../main/services/pi-agent-runtime-harness.js';
import { convertToLlm } from '../../../main/services/pi-legacy-harness.js';
import { createTodoExtensionRuntime } from '../../../main/services/rpiv-todo/extension.js';
import { loadDurableTodoSnapshot } from '../../../main/services/rpiv-todo/snapshot.js';
import { appendPiMessages } from '../../../main/services/pi-compaction-session-store.js';

const marker = 'PLAN_SENTINEL_VERIFY_RESTART';
for (const variant of ['restart', 'compact-without-plan', 'compact-summary-plan', 'compact-tail-plan']) {
 const session = createPiSessionPort(await new InMemorySessionRepo().create({id:`probe-${variant}`}));
 const seedCore=createFauxCore({provider:`probe-seed-${variant}`});
 seedCore.setResponses([fauxAssistantMessage([fauxToolCall('todo',{action:'create',subject:marker})],{stopReason:'toolUse'}),fauxAssistantMessage('checkpoint saved')]);
 const seedModel=seedCore.getModel();
 const seedRuntime=createTodoExtensionRuntime({tasks:[],nextId:1});
 const seed=new PiAgentRuntimeHarness({convertToLlm, streamFn:seedCore.streamSimple, extensions:[seedRuntime.extension],initialState:{systemPrompt:'Probe',thinkingLevel:'off',tools:[],messages:[],model:seedModel},durability:{session,appendMessages:appendPiMessages,compaction:{models:createModels(),model:seedModel,thinkingLevel:'off'}}});
 assert.equal((await seed.runManaged({kind:'append-and-run',message:{role:'user',content:'Track checkpoint',timestamp:1}})).kind,'completed');
 const original=(await session.buildContext()).messages;
 if(variant!=='restart') await session.appendCompaction({id:`compact-${variant}`,summary:variant==='compact-summary-plan'?`Outstanding checkpoint: ${marker}`:'Work is ongoing. Prior detailed observations omitted.',retainedTail:variant==='compact-tail-plan'?original:[],tokensBefore:10000});
 const restored=await loadDurableTodoSnapshot('probe-chat',session);
 assert.equal(restored.state?.tasks[0]?.subject,marker);
 const context=(await session.buildContext()).messages;
 const core=createFauxCore({provider:`probe-resume-${variant}`});
 core.setResponses([fauxAssistantMessage([fauxToolCall('todo',{action:'list'})],{stopReason:'toolUse'}),fauxAssistantMessage('restored')]);
 const model=core.getModel(); const captures:string[]=[];
 const runtime=createTodoExtensionRuntime(restored.state!);
 const resumed=new PiAgentRuntimeHarness({convertToLlm,streamFn:(m,c,o)=>{captures.push(JSON.stringify(c));return core.streamSimple(m,c,o)},extensions:[runtime.extension],initialState:{systemPrompt:'Probe',thinkingLevel:'off',tools:[],messages:context,model},durability:{session,appendMessages:appendPiMessages,compaction:{models:createModels(),model,thinkingLevel:'off'}}});
 assert.equal((await resumed.runManaged({kind:'append-and-run',message:{role:'user',content:'Continue',timestamp:2}})).kind,'completed');
 assert.equal(captures.length,2); assert.equal(captures[1].includes(marker),true);
 assert.equal(captures[0].includes(marker),variant!=='compact-without-plan');
 console.log(JSON.stringify({variant,durableTaskCount:restored.state!.tasks.length,firstRequestHasPlan:captures[0].includes(marker),afterListHasPlan:captures[1].includes(marker),requestCount:captures.length,initialContextCharacters:JSON.stringify(context).length}));
}
