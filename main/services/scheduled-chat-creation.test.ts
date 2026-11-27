import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { createChatStore } from "./chat-store-core.js";
import { createScheduleStore } from "./schedule-store.js";
import { createScheduledChatClaim } from "./scheduled-chat-creation.js";
import { MemoryPersistence } from "./task-persistence-test-support.js";
import { temporaryDirectory } from "../shared/temp-dir-test-support.js";

class FailingTaskPersistence<T> extends MemoryPersistence<T> {
  fail: "before" | "after" | null = null;

  override async update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    const draft = structuredClone(this.data);
    const result = await mutation(draft);
    const failure = this.fail;
    this.fail = null;
    if (failure === "before") throw new Error("task mapping pre-commit failure");
    this.data = draft;
    if (failure === "after") throw new Error("task mapping post-commit failure");
    return result;
  }
}

test("an indeterminate scheduled create preserves its exact recovered chat identity", async (t) => {
  const directory = await temporaryDirectory(t, "aiden-scheduled-chat-claim-");
  let failIndexWrites = true;
  const interrupted = createChatStore(async () => directory, undefined, {
    syncDirectory: async () => undefined,
    syncFile: async (target) => {
      if (failIndexWrites && target.endsWith(".index-write.tmp")) {
        throw new Error("persistent scheduled index failure");
      }
    },
  });
  const schedule = createScheduleStore(
    new MemoryPersistence<unknown[]>([]),
    new MemoryPersistence<unknown[]>([]),
    () => 1_800_000_000_000,
  );
  const task = await schedule.save({
    name: "Daily review",
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "Review the project.",
    workspaceId: "workspace-1",
  });

  let createCalls = 0;
  const claimedChatId = await schedule.ensureChatId(task.id, (mainMintedId) =>
    createScheduledChatClaim(mainMintedId, () => {
      createCalls += 1;
      return interrupted.create({
        id: mainMintedId,
        title: task.name,
        workspaceId: task.workspaceId,
      });
    }),
  );
  assert.equal((await schedule.get(task.id))?.chatId, claimedChatId);
  const installed = JSON.parse(
    await fs.readFile(path.join(directory, `${claimedChatId}.json`), "utf8"),
  ) as { id?: unknown };
  assert.equal(installed.id, claimedChatId);
  assert.equal(createCalls, 1);

  failIndexWrites = false;
  const restarted = createChatStore(async () => directory);
  const recovered = await restarted.list();
  assert.deepEqual(
    recovered.map((chat) => chat.id),
    [claimedChatId],
  );

  const execution = await fs.readFile(new URL("./schedule-execution.ts", import.meta.url), "utf8");
  assert.match(execution, /createScheduledChatClaim\(claimedChatId, \(\) =>/u);
  assert.match(execution, /store\.ensureChatId\(task\.id, create\)/u);
  assert.match(execution, /task\.model \?\?[\s\S]*firstVisibleModelForProvider/u);
  assert.match(execution, /settings\.hiddenModelsByProvider/u);
});

test("schedule mapping failures happen before chat creation and cannot orphan a chat", async () => {
  for (const failure of ["before", "after"] as const) {
    const tasks = new FailingTaskPersistence<unknown[]>([]);
    const schedule = createScheduleStore(
      tasks,
      new MemoryPersistence<unknown[]>([]),
      () => 1_800_000_000_000,
    );
    const task = await schedule.save({
      name: `${failure} mapping failure`,
      mode: "llm",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "Review the project.",
    });
    let creates = 0;
    tasks.fail = failure;
    await assert.rejects(
      schedule.ensureChatId(task.id, async (claimedChatId) => {
        creates += 1;
        return { id: claimedChatId };
      }),
      new RegExp(`task mapping ${failure === "before" ? "pre" : "post"}-commit failure`, "u"),
    );
    assert.equal(creates, 0);
  }
});
