import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { platform, release, arch } from 'node:os';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const output = process.argv[3];
const { AidenRemoteStreamService } = await import(pathToFileURL(`${root}/main/services/aiden-remote-streams.ts`).href);
const rows = [];
for (const chunks of [0,32]) {
  const timings=[]; let counters;
  for(let trial=0;trial<6;trial++) {
    const service = new AidenRemoteStreamService({now:()=>1000,cancel:()=>true,approve:()=>true});
    if(chunks) {
      const retained = service.create('device','retained','old-chat','old-turn');
      for(let i=0;i<chunks;i++) retained.owner.send('chat:delta',{delta:'x'.repeat(131072)});
      retained.owner.send('chat:done',{chat:{messages:[{id:'assistant',role:'assistant'}]}});
    }
    const current=service.create('device','active','chat','turn');
    const beforeBytes=Buffer.byteLength(JSON.stringify(service.snapshot()));
    const original=service.snapshot.bind(service);let calls=0;
    service.snapshot=()=>{calls++;return original();};
    const start=performance.now();
    for(let i=0;i<64;i++) current.owner.send('chat:delta',{delta:'small synthetic delta'});
    const ms=performance.now()-start;
    const count=calls;
    service.snapshot=original;
    const afterBytes=Buffer.byteLength(JSON.stringify(service.snapshot()));
    if(trial>0)timings.push(ms);
    counters={appends:64,snapshotCallsDuringAppends:count,beforeSnapshotBytes:beforeBytes,afterSnapshotBytes:afterBytes};
  }
  rows.push({retainedChunks:chunks,warmups:1,samplesMs:timings,...counters});
}
const result={scenario:'No persistence/subscribers; 64 synthetic appends with 0 or 32 retained 128-KiB chunks',runtime:process.version,platform:platform(),release:release(),arch:arch(),note:'Local microbenchmark during concurrent builds; wall time exploratory only. Snapshot-call counts are deterministic. No GPU/energy claim.',rows};
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
