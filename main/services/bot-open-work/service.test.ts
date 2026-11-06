import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBotOpenWorkStore } from "./store.js";
import { createBotOpenWorkService } from "./service.js";
import type { BotOpenWorkResult } from "../../../renderer/shared/bot-open-work.js";
function ok(result: BotOpenWorkResult) { if (!result.ok) throw new Error(result.error); return result; }
test("a lost Stop acknowledgement survives reopen and retry does not repeat the external effect", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-work-stop-")); t.after(() => rm(root, { recursive: true, force: true }));
  let failPublication = false, executing = true, effects = 0;
  const ports = { profileDir: () => root, botExists: async () => true, beforePublish: async () => { if (failPublication) { failPublication = false; throw new Error("disk interruption"); } } };
  const store = createBotOpenWorkStore(ports);
  const added = ok(await store.mutate("bot:one", { action: "add", mutationId: randomUUID(), expectedRevision: (await store.snapshot("bot:one")).revision, title: "Explicit current task" }, "bot", { requestId: "person", source: { kind: "person", submissionId: "1", entryId: "2" } }));
  const execution = { inspect: async () => executing ? { kind: "running" as const, taskId: "3", inputSubmissionIds: ["1"] } : { kind: "terminal" as const }, stop: async () => { if (!executing) return "already_finished" as const; effects++; executing = false; failPublication = true; return "stopped" as const; } };
  const service = createBotOpenWorkService({ store, execution }); const item = added.snapshot.items[0]!;
  const command = { action: "stop_and_dismiss" as const, mutationId: randomUUID(), expectedRevision: item.revision, id: item.id };
  const uncertain = ok(await service.mutateByPerson("bot:one", command)); assert.equal(uncertain.stop?.state, "requested"); assert.equal(uncertain.snapshot.items[0]!.state, "open");
  const reopened = createBotOpenWorkService({ store: createBotOpenWorkStore(ports), execution });
  const settled = ok(await reopened.mutateByPerson("bot:one", command)); assert.equal(settled.stop?.state, "already_finished"); assert.equal(settled.snapshot.items[0]!.state, "dismissed"); assert.equal(settled.snapshot.items[0]!.completion, undefined); assert.equal(effects, 1);
  assert.equal(ok(await reopened.mutateByPerson("bot:one", command)).stop?.state, "already_finished"); assert.equal(effects, 1);
});
test("Stop refuses mixed sources and does not dismiss or claim completion", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-work-mixed-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createBotOpenWorkStore({ profileDir: () => root, botExists: async () => true });
  const added = ok(await store.mutate("bot:one", { action: "add", mutationId: randomUUID(), expectedRevision: (await store.snapshot("bot:one")).revision, title: "Task" }, "bot", { requestId: "person", source: { kind: "person", submissionId: "1", entryId: "2" } }));
  const service = createBotOpenWorkService({ store, execution: { inspect: async () => ({ kind: "running", taskId: "3", inputSubmissionIds: ["1", "4"] }), stop: async () => "mixed_inputs" } });
  assert.equal((await service.snapshot("bot:one")).items[0]!.execution.canStop, false);
  const item = added.snapshot.items[0]!; const result = ok(await service.mutateByPerson("bot:one", { action: "stop_and_dismiss", mutationId: randomUUID(), id: item.id, expectedRevision: item.revision }));
  assert.equal(result.stop?.state, "blocked"); assert.equal(result.snapshot.items[0]!.state, "open"); assert.equal(result.snapshot.items[0]!.completion, undefined); assert.equal(result.snapshot.undo.length, 0, "Stop cannot be undone as if it reversed an effect");
});
