/** Offline actual-harness composition acceptance; no external/provider traffic.
 * Run: node --import tsx docs/research/experiments/harness-queued-disclosure.ts
 * Covers pressured tool batches, queued steering, dynamic browser schemas and Stop.
 */
import assert from "node:assert/strict";
import { getCurrentTools, Type, createModels } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { InMemorySessionRepo } from "../../../main/services/pi-session-repository-port.js";
import { appendPiMessages } from "../../../main/services/pi-compaction-session-store.js";
import { PiAgentRuntimeHarness, type PiAgentRuntimeHarnessOptions, type PiRuntimeSessionBinding } from "../../../main/services/pi-agent-runtime-harness.js";
import { declarePiRuntimeReplay } from "../../../main/services/pi-runtime-tool.js";
import { convertToLlm } from "../../../main/services/pi-legacy-harness.js";
import { createGenerationContextTransform } from "../../../main/services/generation-context.js";
import { createPiSessionPort, type PiSessionPort } from "../../../main/services/pi-session-port.js";

async function managedTestHarness(
  responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0],
  options: {
    tools?: AgentTool[];
    deferredTools?: readonly AgentTool[];
    extensions?: PiAgentRuntimeHarnessOptions["extensions"];
    identity?: PiAgentRuntimeHarnessOptions["identity"];
    appendMessages?: (session: PiSessionPort, messages: readonly AgentMessage[]) => Promise<void>;
    appendInput?: (session: PiSessionPort, message: AgentMessage) => Promise<void>;
    beforeQueuedUser?: PiRuntimeSessionBinding["beforeQueuedUser"];
    beforeToolCall?: PiAgentRuntimeHarnessOptions["beforeToolCall"];
    prepareNextTurnWithContext?: PiAgentRuntimeHarnessOptions["prepareNextTurnWithContext"];
    initialSystemPrompt?: string;
    initialMessages?: AgentMessage[];
    contextWindow?: number;
    retryDelayMs?: number;
    consumeHostFailure?: () => "inference" | "policy" | undefined;
    effects?: PiRuntimeSessionBinding["effects"];
    signal?: AbortSignal;
    streamFn?: PiAgentRuntimeHarnessOptions["streamFn"];
    summaryResponses?: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
    generationContextTransform?: boolean;
    onContextProjection?: PiAgentRuntimeHarnessOptions["onContextProjection"];
  } = {},
) {
  const core = createFauxCore({
    provider: `aiden-managed-harness-${Math.random().toString(36).slice(2)}`,
    ...(options.contextWindow
      ? {
          models: [
            {
              id: "managed-model",
              contextWindow: options.contextWindow,
              maxTokens: Math.max(256, Math.floor(options.contextWindow / 4)),
            },
          ],
        }
      : {}),
  });
  core.setResponses(responses);
  const model = core.getModel();
  const compactionModels = createModels();
  if (options.summaryResponses) {
    const summaryProvider = fauxProvider({
      api: model.api,
      provider: model.provider,
      models: [
        {
          id: model.id,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
      ],
    });
    summaryProvider.setResponses(options.summaryResponses);
    compactionModels.setProvider(summaryProvider.provider);
  }
  const session = createPiSessionPort(
    await new InMemorySessionRepo().create({
      id: `managed-${Math.random().toString(36).slice(2)}`,
    }),
  );
  const harness = new PiAgentRuntimeHarness({
    deferredTools: options.deferredTools,
    extensions: options.extensions,
    identity: options.identity,
    convertToLlm,
    streamFn: options.streamFn ?? core.streamSimple,
    ...(options.generationContextTransform
      ? {
          transformContext: createGenerationContextTransform({
            contextWindow: model.contextWindow,
            systemPrompt: options.initialSystemPrompt ?? "Managed prompt",
            tools: options.tools ?? [],
            supportsImages: model.input.includes("image"),
            providerId: model.provider,
            modelId: model.id,
          }),
        }
      : {}),
    initialState: {
      systemPrompt: options.initialSystemPrompt ?? "Managed prompt",
      thinkingLevel: "off",
      tools: options.tools ?? [],
      messages: options.initialMessages ?? [],
      model,
    },
    beforeToolCall: options.beforeToolCall,
    prepareNextTurnWithContext: options.prepareNextTurnWithContext,
    ...(options.onContextProjection ? { onContextProjection: options.onContextProjection } : {}),
    durability: {
      session,
      appendMessages: options.appendMessages ?? appendPiMessages,
      appendInput: options.appendInput,
      beforeQueuedUser: options.beforeQueuedUser,
      compaction: {
        models: compactionModels,
        model,
        thinkingLevel: "off",
        retryDelayMs: options.retryDelayMs,
        consumeHostFailure: options.consumeHostFailure,
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.effects ? { effects: options.effects } : {}),
    },
  });
  return { core, harness, session };
}

const { createBrowserDiscovery } = await import('../../../main/services/browser-discovery.ts');
for (const stop of [false,true]) {
 let entered!:()=>void, release!:()=>void;
 const atPrepare=new Promise<void>(r=>entered=r), held=new Promise<void>(r=>release=r);
 let calls=0;
 const exposed=declarePiRuntimeReplay({name:'browser_status',label:'Browser',description:'Read browser state '+ 'schema '.repeat(300),parameters:Type.Object({}),execute:async()=>{calls++;return{content:[{type:'text' as const,text:'BROWSER-STATUS-OK'}],details:null}}},'safe');
 const discovery=createBrowserDiscovery([exposed],async()=>{});
 const bulky:AgentTool={name:'bulky',label:'Bulky',description:'Offline evidence',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'evidence '.repeat(500)}],details:null})};
 const seen: Array<{ messages: AgentMessage[]; tools: string[] }> = [];
 let coreRef: ReturnType<typeof createFauxCore>;
 const {core,harness,session}=await managedTestHarness([
  fauxAssistantMessage([...Array.from({length:30},()=>fauxToolCall('bulky',{})),fauxToolCall('browser',{})],{stopReason:'toolUse'}),
  fauxAssistantMessage([fauxToolCall('browser_status',{})],{stopReason:'toolUse'}),
  fauxAssistantMessage('Done with queued constraint'),
 ],{tools:[bulky,discovery.tool],contextWindow:16000,generationContextTransform:true,
  summaryResponses:Array.from({length:8},()=>fauxAssistantMessage('## Goal\nComplete queued constraint.\n## Progress\nBrowser was disclosed; use browser_status.')),
  streamFn:(model,context,options)=>{seen.push({messages:structuredClone(context.messages),tools:getCurrentTools(context.messages).map(t=>t.name)});return coreRef.streamSimple(model,context,options)},
  prepareNextTurnWithContext:async({context,toolResults},signal)=>{if(toolResults.some(r=>r.toolName==='browser')){entered();await held;signal?.throwIfAborted();}return{context:await discovery.prepare(context)}}
 });coreRef=core;
 const running=harness.runManaged({kind:'append-and-run',message:{role:'user',content:'Collect evidence then inspect browser',timestamp:1}});
 await atPrepare;
 assert.deepEqual(harness.queueSteer({role:'user',content:'QUEUED-CONSTRAINT-719: preserve this requested condition',timestamp:2}),{accepted:true,queue:'steer'});
 if(stop)harness.abort();release();
 const outcome=await running;
 const branch=await session.getBranch();const context=await session.buildContext();
 if(stop){assert.equal(outcome.kind,'app_cancelled');assert.equal(seen.length,1);assert.equal(calls,0);assert.equal(harness.state.tools.some(t=>t.name==='browser_status'),false);}
 else {assert.equal(outcome.kind,'completed',JSON.stringify(outcome));assert.equal(calls,1);assert.ok(seen.slice(1).some(r=>JSON.stringify(r.messages).includes('QUEUED-CONSTRAINT-719')));assert.ok(seen.slice(1).some(r=>r.tools.includes('browser_status')));assert.equal(branch.filter(e=>e.type==='message'&&e.message.role==='user'&&JSON.stringify(e.message).includes('QUEUED-CONSTRAINT-719')).length,1);}
 console.log(JSON.stringify({stop,outcome:outcome.kind,providerRequests:seen.length,disclosedCalls:calls,queueJournalEntries:branch.filter(e=>e.type==='message'&&e.message.role==='user'&&JSON.stringify(e.message).includes('QUEUED-CONSTRAINT-719')).length,checkpoints:branch.filter(e=>e.type==='compaction').length,contextMessages:context.messages.length}));
}
