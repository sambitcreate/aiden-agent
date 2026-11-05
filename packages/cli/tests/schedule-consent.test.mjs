// cli-native C15: a schedule mutation carrying consent is bound to what the
// person reviewed, and is rechecked at the durable write.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as api from "../dist/parity-test-api.js";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "aiden-consent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = await api.workspaceCommand(dir, ["add", dir]);
  await api.workspaceCommand(dir, ["access", workspace.id, "full"]);
  const scheduler = api.createCliScheduler(dir), input = join(dir, "input.json");
  t.after(() => scheduler.service.stopAndSettle());
  writeFileSync(input, JSON.stringify({ name: "Review", mode: "script", script: "true", cron: "0 9 * * *", timezone: "UTC", permission: "full", enabled: true, workspaceId: workspace.id }));
  const task = await scheduler.command(["save", input]);
  /** Captures consent for `action` the way a confirmation does. */
  const consent = (action, overrides = {}) => {
    const approvalFile = join(dir, `receipt-${action}.json`);
    const approval = { cwd: dir, action, input: { id: task.id }, expiresAt: Date.now() + 60_000, approvalFile };
    approval.snapshot = api.scheduleApprovalSnapshot(dir, approval);
    writeFileSync(approvalFile, JSON.stringify(approval.snapshot));
    return { ...approval, ...overrides };
  };
  const stored = async () => (await scheduler.command(["list"])).find((item) => item.id === task.id);
  return { dir, scheduler, workspace, task, consent, stored, run: (action, approval) => scheduler.command([action, task.id, JSON.stringify(approval)]) };
}

test("consent for a new schedule covers the reviewed input, once", async (t) => {
  const f = await fixture(t), file = join(f.dir, "new.json");
  const reviewed = { name: "New", mode: "script", script: "true", cron: "0 9 * * *", timezone: "UTC", permission: "full", enabled: false, workspaceId: f.workspace.id };
  const review = (name) => {
    const approval = { cwd: f.dir, action: "save", input: reviewed, expiresAt: Date.now() + 60_000, approvalFile: join(f.dir, `${name}.json`) };
    approval.snapshot = api.scheduleApprovalSnapshot(f.dir, approval);
    writeFileSync(approval.approvalFile, JSON.stringify(approval.snapshot));
    return approval;
  };
  const save = (approval) => f.scheduler.command(["save", file, JSON.stringify(approval)]);
  const count = async () => (await f.scheduler.command(["list"])).length;
  const before = await count(), swapped = review("swapped"), approved = review("approved");
  writeFileSync(file, JSON.stringify({ ...reviewed, script: "rm -rf ." }));
  await assert.rejects(save(swapped), /changed after approval/u);
  assert.equal(await count(), before, "a swapped file is not what was reviewed");
  writeFileSync(file, JSON.stringify(reviewed));
  await assert.rejects(save(swapped), /already used/u, "a rejected command spends its consent");
  await save(approved);
  assert.equal(await count(), before + 1);
  await assert.rejects(save(approved), /already used/u);
  assert.equal(await count(), before + 1, "the receipt was left in place, but consent is spent");
});

test("consent for the task as reviewed lets the mutation through", async (t) => {
  const f = await fixture(t), approval = f.consent("pause");
  await f.run("pause", approval);
  assert.equal((await f.stored()).enabled, false);
  await assert.rejects(f.run("pause", approval), /already used/u);
});

test("expired, cancelled or mismatched consent changes nothing", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("pause", f.consent("pause", { expiresAt: Date.now() - 1 })), /expired/u);
  const cancelled = f.consent("pause");
  rmSync(cancelled.approvalFile);
  await assert.rejects(f.run("pause", cancelled), /cancelled/u);
  await assert.rejects(f.run("resume", f.consent("pause")), /action changed/u);
  assert.equal((await f.stored()).enabled, true);
});

test("consent lapses when the workspace, provider or task changes after review", async (t) => {
  const f = await fixture(t);
  const access = f.consent("pause");
  await api.workspaceCommand(f.dir, ["access", f.workspace.id, "ask"]);
  await assert.rejects(f.run("pause", access), /changed after approval/u);
  await api.workspaceCommand(f.dir, ["access", f.workspace.id, "full"]);
  const provider = f.consent("pause");
  api.atomicJson(join(f.dir, "models.json"), { providers: {} });
  await assert.rejects(f.run("pause", provider), /changed after approval/u);
  const edited = f.consent("pause");
  await f.scheduler.command(["pause", f.task.id]);
  await f.scheduler.command(["resume", f.task.id]);
  await assert.rejects(f.run("pause", edited), /changed after approval/u);
  assert.equal((await f.stored()).enabled, true);
});

test("consent revoked at the durable write stops the mutation and is not reused", async (t) => {
  const f = await fixture(t), approval = f.consent("pause");
  // The entry check has passed. Revoke between it and the write the mutation publishes.
  const update = api.JsonStore.prototype.update;
  api.JsonStore.prototype.update = function (mutation, isCurrent, replace) {
    if (this.file.endsWith("schedules.json")) rmSync(approval.approvalFile, { force: true });
    return update.call(this, mutation, isCurrent, replace);
  };
  t.after(() => { api.JsonStore.prototype.update = update; });
  await assert.rejects(f.run("pause", approval), /cancelled/u);
  api.JsonStore.prototype.update = update;
  assert.equal((await f.stored()).enabled, true);
});
