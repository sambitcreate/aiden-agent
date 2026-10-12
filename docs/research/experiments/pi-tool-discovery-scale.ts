/** Offline research: Synthetic discovery inventory, Unicode budget and oversized-schema probe.
 * Timing is diagnostic under uncontrolled local load, not a product latency benchmark.
 * Setup from repo root: npm ci
 * Run: ./node_modules/.bin/tsx docs/research/experiments/pi-tool-discovery-scale.ts
 * Synthetic fixtures only, no network/model calls or real tool effects.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Type } from '@earendil-works/pi-ai';
import { createPiCodemodeTool } from '../../../main/services/pi-codemode.js';
import { createPiToolDiscovery, type PiDiscoverableTool } from '../../../main/services/pi-tool-discovery.js';
import { partitionPiCodemodeTools, isPiCodemodeCallable } from '../../../main/services/pi-runtime-tool.js';
import { estimateStaticContextTokens } from '../../../main/services/generation-context.js';
const size=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');
function fixture(n:number,wide=false): PiDiscoverableTool[] {
 const namespaces=Array.from({length:16},(_,i)=>Object.freeze({namespace:`mcp:service${i}`,label:wide?'文書検索 📚':'Document service',description:wide?'文書とファイルを検索します':'Search documents and project files',instructions:'Read-only reference guidance.'}));
 return Array.from({length:n},(_,i)=>({name:`service_${i%16}_search_${String(i).padStart(3,'0')}`,label:wide?'文書検索 📚':'Search documents',description:(wide?'文書とファイルの検索 📚 ': 'Search documents with project filters. ').repeat(12),parameters:Type.Object({query:Type.String({description:'Text to find'}),workspace:Type.Optional(Type.String()),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),kind:Type.Optional(Type.Union([Type.Literal('file'),Type.Literal('document')]))}),codemode:true,discovery:namespaces[i%16],execute:async()=>{throw Error('Probe must not dispatch')}}));
}
for(const wide of [false,true]) {
 let inventory=fixture(511,wide);
 const codemode=createPiCodemodeTool({tools:()=>[...inventory,codemode],executeTool:async()=>{throw Error('No effects')}});
 const discovery=createPiToolDiscovery({tools:()=>[...inventory,codemode],isCallable:isPiCodemodeCallable});
 const all=[...inventory,codemode];const parts=partitionPiCodemodeTools(all);
 const before=estimateStaticContextTokens({contextWindow:128000,systemPrompt:'',tools:all});const after=estimateStaticContextTokens({contextWindow:128000,systemPrompt:'',tools:parts.declared});
 const times:number[]=[];let result:any;
 for(let i=0;i<120;i++){const t=performance.now();result=discovery.searchTools('',{limit:20});times.push(performance.now()-t);assert.ok(size(result)<=32768)}
 times.sort((a,b)=>a-b);
 const namespace=discovery.describeNamespace('mcp:service0');assert.ok(size(namespace)<=32768);
 const count=(result.tools as unknown[]).length;inventory=inventory.slice(1);assert.equal((discovery.searchTools('search_000').tools as unknown[]).length,0);
 console.log(JSON.stringify({wide,inventoryCount:all.length,deferred:parts.deferred.length,declared:parts.declared.length,estimatedStaticTokensBefore:before,estimatedStaticTokensAfter:after,resultTools:count,resultBytes:size(result),namespaceBytes:size(namespace),medianMs:times[60],p95Ms:times[114],revocationObserved:true}));
}
let inventory=fixture(512);const codemode=createPiCodemodeTool({tools:()=>[...inventory,codemode],executeTool:async()=>{throw Error('No effects')}});
const basic=await codemode.execute('max',{code:'text(ALL_TOOLS.length);'});
const search=await codemode.execute('search',{code:'text(await searchTools("search_000"));'});
assert.equal(search.isError,false);assert.ok(JSON.stringify(search.content).includes('service_0_search_000'));
console.log(JSON.stringify({boundary512Callable:basic.content,searchIsError:search.isError,searchContentBytes:size(search.content)}));
let oversized=fixture(511);for(let i=0;i<510;i++)oversized[i].parameters=Type.Object({example:Type.Literal('雪'.repeat(6000))});
const many=createPiToolDiscovery({tools:()=>oversized,isCallable:()=>true});const start=performance.now();const result=many.searchTools('',{limit:20});assert.equal((result.tools as unknown[]).length,1);assert.ok(size(result)<=32768);
console.log(JSON.stringify({oversizedSchemas:510,validTools:(result.tools as unknown[]).length,resultBytes:size(result),truncated:result.truncated,elapsedMs:performance.now()-start}));
