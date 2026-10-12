/** Real local shell + Pi + codemode + scoped output-store composition probe.
 * Setup from root: npm ci
 * Run: node --import tsx docs/research/experiments/codemode-output-recovery.ts
 * Executes one synthetic failing Node command in a temporary workspace; no model/network.
 * Current-source reproduction; the historical pre-fix status receipt is superseded.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sourceSha256 = Object.fromEntries(['package-lock.json', 'main/services/coding-tools.ts', 'main/services/pi-codemode.ts', 'main/services/tool-output-context.ts', 'main/services/tool-output-store.ts', 'docs/research/experiments/codemode-output-recovery.ts'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { runToolCall } from '@earendil-works/pi-agent-core'; import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { buildCodingTools } from '../../../main/services/coding-tools.js'; import { createPiCodemodeTool } from '../../../main/services/pi-codemode.js';
import { withDurableToolOutputs } from '../../../main/services/tool-output-context.js';
import { ToolOutputStore,toolOutputScope } from '../../../main/services/tool-output-store.js';
const root=await mkdtemp(join(tmpdir(),'aiden-codemode-provenance-'));
try {
 await writeFile(join(root,'failing.cjs'), 'process.stdout.write("progress\\n".repeat(7000)+"FINAL_ASSERTION_FAILED\\n"); process.exitCode=7;');
 let current=true;
 const tools=withDurableToolOutputs({tools:buildCodingTools(root),store:new ToolOutputStore(()=>root),chatId:'research',scope:toolOutputScope('offline-fixture'),assertCurrent:async()=>{if(!current)throw new Error('revoked')},isCurrent:()=>current});
 const command=tools.find(t=>t.name==='run_command')!;
 const assistantMessage=fauxAssistantMessage('research');
 let dispatches=0;
 const codemode=createPiCodemodeTool({tools:()=>[command],executeTool:async(_parent,name,args)=>{
  dispatches++;
  return runToolCall({type:'toolCall',id:'nested',name,arguments:args as never},{tools,assistantMessage,context:{messages:[assistantMessage],tools}});
 }});
 const first=await codemode.execute('parent',{code:'const r=await tools.run_command({command:"node failing.cjs"}); store("commandResult",r); text("progress ".repeat(4000)); text(r);'});
 const visible=first.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
 assert.match(visible,/Codemode text output truncated/u);
 assert.ok(!visible.includes('FINAL_ASSERTION_FAILED'));
 const second=await codemode.execute('inspect',{code:'const r=load("commandResult"); text({isError:r.isError,prefix:r.content[0].text.slice(0,80),suffix:r.content[0].text.slice(-400)});'});
 const stored=JSON.parse(second.content[0].type==='text'?second.content[0].text:'null');
 assert.equal(stored.isError,true); assert.match(stored.prefix,/Command exited with error \(code 7\)/u);
 const handle=/handle=([a-f0-9-]+)/u.exec(stored.suffix)?.[1]; assert.ok(handle);
 const retainedChars=Number(/Retained ([0-9]+) of/u.exec(stored.suffix)?.[1]); assert.ok(retainedChars > 1000);
 const read=tools.find(t=>t.name==='read_tool_output')!;
 const recovered=await read.execute('recover',{handle,offset:retainedChars-1000,length:1000});
 assert.match(JSON.stringify(recovered.content),/FINAL_ASSERTION_FAILED/u);
 current=false;
 await assert.rejects(read.execute('revoked',{handle,offset:retainedChars-1000,length:1000}),/revoked/u);
 assert.equal(dispatches,1,'recovery must not re-execute the failed command');
 console.log(JSON.stringify({evidenceKind:"offline-local-effect-output-recovery",generatedAt:new Date().toISOString(),node:process.version,sourceSha256,realCommandExit:7,topLevelCodemodeIsError:first.isError,nestedIsError:stored.isError,omissionDisclosed:true,storedStatusPrefix:stored.prefix,tailRecovered:true,revokedReadDenied:true,commandDispatches:dispatches},null,2));
}finally{await rm(root,{recursive:true,force:true})}
