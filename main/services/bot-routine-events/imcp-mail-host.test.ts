import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {createModelFreeMailFixture} from "./imcp-mail-test-support.js";
import {readImcpWatch} from "./connector-watch-imcp.js";

test("real protected source admission discovers and reads the exact Mail account without an available default provider",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"aiden-model-free-mail-"));t.after(()=>rm(root,{recursive:true,force:true}));const f=await createModelFreeMailFixture(root),signal=new AbortController().signal;
  const [binding]=await f.host.discover(f.botId,f.serverId,signal,async()=>{});assert.ok(binding);assert.equal(binding.account,"account-one");assert.equal(binding.mailbox,"mailbox-one");
  const read=()=>f.host.withPort(f.botId,binding!,signal,port=>readImcpWatch({kind:"email",account:binding!.account,mailbox:binding!.mailbox,unreadOnly:false},port,Date.parse("2026-11-03T15:00:00Z"),signal));
  assert.deepEqual((await read()).map(row=>row.title),["Project initial"]);const held=await f.host.authorize(f.botId,binding!,signal);held.release();
  f.mutateSchema();await assert.rejects(read(),/verified read-only|tools or access|source grant|account or access changed/u);const before=f.counts().reads;f.close();await assert.rejects(read());assert.equal(f.counts().reads,before);
});
