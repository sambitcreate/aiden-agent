import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { ToolTask } from "@earendil-works/pi-durable";
import {
  createBotSessionService,
  type BotSendInput,
  type BotSessionServiceDeps,
} from "../bot-runtime/bot-session-service.js";
import {
  BOT_MESSAGE_STATUS_ENTRY_KIND,
  type BotMessageStatusEntryData,
} from "../../../renderer/shared/bot-messages.js";
import { createBotApprovals } from "../bot-runtime/bot-approvals.js";
import { recordingDeps, countingTool, blockingUntilAborted } from "../bot-runtime/test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor } from "../bot-runtime/test-support/faux.js";
import { createBotMessageCourier, type BotMessageCourierDeps } from "./courier.js";
import { createBotMessageLedger } from "./ledger.js";
import { createMessageBotTool } from "./tool.js";

function gate(text: string) {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    response: async () => {
      await ready;
      return fauxAssistantMessage(text);
    },
  };
}
async function setup(
  t: TestContext,
  responses: Record<string, FauxResponseStep[]>,
  windowMs?: number,
  resolveModel?: BotSessionServiceDeps["resolveModel"],
  spendingRefusal?: BotSessionServiceDeps["spendingRefusal"],
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "real-bot-courier-"));
  const models = new Map(Object.entries(responses).map(([id, steps]) => [id, createFauxModels(steps)]));
  const errors: unknown[] = [];
  const stateChanges = new Set<(botId: string) => void>();
  const approvals = createBotApprovals({ publish: () => undefined });
  const extension = recordingDeps();
  const runtime = await createBotSessionService({
    profileDir: dir,
    models: (id) => models.get(id)!.models,
    extension,
    resolveModel: resolveModel ?? (async () => FAUX_MODEL_REF),
    spendingRefusal,
    knownBotIds: async () => new Set(models.keys()),
    onStateChange: (id) => {
      for (const listener of stateChanges) listener(id);
    },
    onReport: (_id, error) => errors.push(error),
  });
  const file = path.join(dir, "bots", "bot-messages.json");
  const durable = createBotMessageLedger({ file: () => file, now: Date.now });
  const ledger =
    windowMs === undefined
      ? durable
      : {
          ...durable,
          reserve: (row: Parameters<typeof durable.reserve>[0]) =>
            durable.reserve({ ...row, deadline: Date.now() + windowMs }),
        };
  let calls = 0;
  const countedLedger = {
    ...ledger,
    get: async (id: string) => {
      calls++;
      return ledger.get(id);
    },
    update: async (...args: Parameters<typeof ledger.update>) => {
      calls++;
      return ledger.update(...args);
    },
  };
  const sends: Array<{
    botId: string;
    input: BotSendInput;
    submissionId: string;
  }> = [];
  const activeWaits = new Set<string>();
  let waitCount = 0;
  const sessions: BotMessageCourierDeps["sessions"] = {
    ...runtime,
    send: async (botId, input) => {
      const result = await runtime.send(botId, input);
      sends.push({ botId, input, submissionId: result.submissionId });
      return result;
    },
    awaitReply: async (botId, submissionId, signal) => {
      const key = `${botId}:${submissionId}`;
      assert.equal(activeWaits.has(key), false, "courier has one wait per actual submission across deliveries");
      activeWaits.add(key);
      waitCount++;
      try {
        return await runtime.awaitReply(botId, submissionId, signal);
      } finally {
        activeWaits.delete(key);
      }
    },
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let timerCalls = 0;
  const deliveries: unknown[] = [];
  const courier = createBotMessageCourier({
    ledger: countedLedger,
    sessions,
    approvals,
    roster: async () =>
      [...models.keys()].map((id) => ({
        id,
        name: id,
        purpose: "",
        acceptsMessages: true,
        sendsMessages: true,
      })),
    enabled: async () => true,
    onStateChange: (listener) => {
      stateChanges.add(listener);
      return () => {
        stateChanges.delete(listener);
      };
    },
    now: Date.now,
    setTimer: (fn, ms) => {
      const handle = setTimeout(() => {
        timers.delete(handle);
        timerCalls++;
        fn();
      }, ms);
      timers.add(handle);
      return {
        cancel: () => {
          clearTimeout(handle);
          timers.delete(handle);
        },
      };
    },
    report: (error) => errors.push(error),
    deliver: async (input) => {
      deliveries.push(input);
    },
  });
  await courier.start();
  t.after(async () => {
    await courier.dispose();
    await runtime.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
  const post = async (fromBotId = "A", target = "B") => {
    const result = await courier.post({
      fromBotId,
      target,
      message: "hello",
      deliveryId: randomUUID(),
      runRequestIds: [undefined],
    });
    assert.equal(result.status, "sent");
    if (result.status !== "sent") throw new Error("not accepted");
    return result;
  };
  return {
    runtime,
    courier,
    ledger,
    file,
    post,
    sends,
    activeWaits,
    errors,
    models,
    sessions,
    extension,
    timers,
    deliveries,
    counts: () => ({ ledger: calls, timer: timerCalls, waits: waitCount }),
  };
}

test("a real busy target settles naturally and admits its saved request without a state-change wake", async (t) => {
  const busy = gate("Person's result");
  t.after(busy.release);
  const f = await setup(t, {
    A: [fauxAssistantMessage("For person")],
    B: [busy.response, fauxAssistantMessage("Answer")],
  });
  await f.runtime.send("B", { text: "person", requestId: "person" });
  await waitFor(() => f.models.get("B")!.calls() === 1);
  await f.post();
  await waitFor(() => f.activeWaits.size === 1);
  assert.equal(f.sends.length, 0);
  busy.release();
  await waitFor(() => f.deliveries.length === 1);
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.errors, []);
});

test("a real busy reply recipient settles naturally and gets its saved reply", async (t) => {
  const busy = gate("Initial person turn");
  t.after(busy.release);
  const f = await setup(t, {
    A: [busy.response, fauxAssistantMessage("Final for person")],
    B: [fauxAssistantMessage("B answer")],
  });
  await f.runtime.send("A", { text: "person", requestId: "person" });
  await waitFor(() => f.models.get("A")!.calls() === 1);
  await f.post();
  await waitFor(() => f.sends.length === 1 && f.activeWaits.size === 1);
  assert.equal(f.models.get("A")!.calls(), 1);
  busy.release();
  await waitFor(() => f.deliveries.length === 1);
  assert.equal(f.sends[1]?.botId, "A");
  assert.deepEqual(f.errors, []);
});

test("two senders share one busy-submission wait and drain through a real target naturally", async (t) => {
  const busy = gate("Person result"),
    first = gate("First Bot result");
  t.after(() => {
    busy.release();
    first.release();
  });
  const f = await setup(t, {
    A: [fauxAssistantMessage("A final")],
    C: [fauxAssistantMessage("C final")],
    B: [busy.response, first.response, fauxAssistantMessage("Second Bot result")],
  });
  await f.runtime.send("B", { text: "person", requestId: "person" });
  await waitFor(() => f.models.get("B")!.calls() === 1);
  await Promise.all([f.post("A"), f.post("C")]);
  await waitFor(async () => f.counts().waits >= 1 && (await f.ledger.open()).length === 2);
  // Both workers are observing the one real running submission.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.activeWaits.size, 1);
  busy.release();
  await waitFor(() => f.models.get("B")!.calls() === 2);
  first.release();
  await waitFor(() => f.deliveries.length === 2);
  assert.equal(f.sends.filter((s) => s.botId === "B").length, 2);
  assert.deepEqual(f.errors, []);
});

for (const outcome of ["expired", "silent"] as const) {
  test(`real timers and ledger operations become quiescent after ${outcome}`, async (t) => {
    const busy = gate("Person result");
    t.after(busy.release);
    const f = await setup(
      t,
      {
        A: [],
        B: [outcome === "expired" ? busy.response : fauxAssistantMessage("[SILENT]")],
      },
      outcome === "expired" ? 80 : undefined,
    );
    if (outcome === "expired") {
      await f.runtime.send("B", { text: "person", requestId: "person" });
      await waitFor(() => f.models.get("B")!.calls() === 1);
    }
    const sent = await f.post();
    await waitFor(
      async () =>
        (await f.ledger.get(sent.deliveryId))?.outcome === outcome &&
        !(await f.ledger.open()).length &&
        f.timers.size === 0,
    );
    const before = f.counts(),
      inode = (await stat(f.file)).ino;
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.deepEqual(f.counts(), before);
    assert.equal((await stat(f.file)).ino, inode);
    assert.equal(f.activeWaits.size, 0);
    if (outcome === "expired") assert.equal((await f.runtime.state("B")).kind, "running");
    assert.deepEqual(f.errors, []);
  });
}

test("real durable tool settlement collects its receipt before display pruning", async (t) => {
  const f = await setup(t, {
    A: [
      fauxAssistantMessage(
        [
          fauxToolCall("message_bot", {
            bot: "B",
            message: "private tool message",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Initial ended"),
    ],
    B: [fauxAssistantMessage("[SILENT]")],
  });
  let taskId = "",
    deliveryId = "",
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  f.extension.currentTools = async (bot) => {
    const botId = bot.id;
    return [
      {
        tool: createMessageBotTool(botId, {
          post: f.courier.post,
          roster: async () => [],
        }),
        replay: "safe",
        bind: (call) => ({
          ...createMessageBotTool(botId, { post: f.courier.post, roster: async () => [] }, { ...call, taskId }),
          execute: async (...args) => {
            assert.ok(call.taskId, "the adapter supplies the real durable tool task identity");
            taskId = call.taskId;
            const conversation = await f.runtime.conversation(botId);
            const tasks = await conversation.commit(
              (tx) =>
                tx.scanTasks(
                  {
                    conversationId: conversation.id,
                    kind: ToolTask.definition.name,
                  },
                  100,
                ),
              BACKGROUND_CONTEXT,
            );
            assert.ok(tasks.items.some((task) => String(task.id) === taskId && task.state.status === "running"));
            const tool = createMessageBotTool(
              botId,
              { post: f.courier.post, roster: async () => [] },
              { ...call, taskId },
            );
            const result = await tool.execute(...args);
            deliveryId = (result.details as { deliveryId: string }).deliveryId;
            await held;
            return result;
          },
        }),
      },
    ];
  };
  await f.runtime.send("A", { text: "Ask B", requestId: "person" });
  await waitFor(() => !!deliveryId);
  assert.equal((await f.ledger.receipt(deliveryId))?.taskId, taskId);
  const saved = JSON.parse(await readFile(f.file, "utf8")) as {
    receipts: unknown[];
  };
  assert.equal(JSON.stringify(saved.receipts).includes("private tool message"), false);
  await waitFor(async () => (await f.ledger.get(deliveryId))?.status === "answered");
  assert.ok(await f.ledger.receipt(deliveryId), "unsettled tool remains replayable after the delivery settles");
  release();
  await waitFor(async () => !(await f.ledger.receipt(deliveryId)));
  assert.ok(await f.ledger.get(deliveryId), "display retention is independent");
  assert.deepEqual(f.errors, []);
});

test("a real ConversationBusy admission race remains pending and wakes on the competing submission", async (t) => {
  const busy = gate("Competing person's result");
  const personTool = countingTool("person_action");
  t.after(busy.release);
  const f = await setup(t, {
    A: [fauxAssistantMessage("For person")],
    B: [async () => {
      await busy.response();
      return fauxAssistantMessage([fauxToolCall("person_action", { text: "winning person's action" })], { stopReason: "toolUse" });
    }, fauxAssistantMessage("Person complete"), fauxAssistantMessage("B answer")],
  });
  const conversation = await f.runtime.conversation("B");
  const admissionErrors: string[] = [];
  const send = f.sessions.send;
  f.sessions.send = async (...args) => {
    try {
      return await send(...args);
    } catch (error) {
      admissionErrors.push((error as Error).name);
      throw error;
    }
  };
  let raced = false;
  const tools = f.extension.currentTools;
  f.extension.currentTools = async (bot, turn) => {
    if (bot.id === "B" && !raced) {
      raced = true;
      // Pi admission races after the service's idle snapshot but before submit.
      // This is the actual whenBusy: reject path, not a fabricated busy error.
      await conversation.submit(
        {
          type: "input",
          content: "person racing admission",
          requestId: "competing-person",
        },
        BACKGROUND_CONTEXT,
      );
    }
    const ordinary = await tools(bot, turn);
    return turn.requestId?.startsWith("bot:") || turn.requestId?.startsWith("botreply:")
      ? ordinary : [...ordinary, { tool: personTool, replay: "unsafe" as const }];
  };
  const sent = await f.post();
  await waitFor(() => f.models.get("B")!.calls() === 1 && f.activeWaits.size === 1);
  assert.equal((await f.ledger.get(sent.deliveryId))?.status, "delivered");
  assert.equal(f.sends.length, 0);
  busy.release();
  await waitFor(() => f.deliveries.length === 1);
  assert.equal(f.sends.length, 2);
  assert.deepEqual(admissionErrors, ["ConversationBusy"]);
  assert.deepEqual(personTool.executions, [{ text: "winning person's action" }], "the person who wins admission keeps the attended inventory");
  assert.deepEqual(f.errors, []);
});

for (const unavailable of ["needs_model", "model_error"] as const) {
  test(`a real ${unavailable} sender keeps the saved reply and the courier becomes quiescent`, async (t) => {
    const f = await setup(t, { A: [], B: [fauxAssistantMessage("Saved answer")] }, undefined, async (id) => {
      if (id === "A") {
        if (unavailable === "model_error") throw new Error("Sign-in expired");
        return null;
      }
      return FAUX_MODEL_REF;
    });
    const accepted = await f.post();
    await waitFor(async () => (await f.ledger.open()).length === 0);
    const view = await (await f.runtime.conversation("A")).context(BACKGROUND_CONTEXT);
    const saved = view.entries
      .filter((e) => e.kind === BOT_MESSAGE_STATUS_ENTRY_KIND)
      .map((e) => e.data as unknown as BotMessageStatusEntryData);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.outcome, "replied_while_paused");
    assert.equal(saved[0]!.text, "Saved answer");
    assert.equal(f.models.get("A")!.calls(), 0);
    assert.equal(f.sends.length, 1);
    assert.ok((await f.ledger.get(accepted.deliveryId))!.effects.find((e) => e.kind === "reply")!.acknowledgedAt);
    await waitFor(() => f.timers.size === 0);
    const counts = f.counts();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(f.counts(), counts);
    assert.deepEqual(f.errors, []);
  });
}

for (const outcome of ["failed", "stopped"] as const) {
  test(`a real ${outcome} reply turn preserves the received answer without a replacement turn`, async (t) => {
    const reply =
      outcome === "failed"
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: invalid API key" })
        : fauxAssistantMessage([fauxToolCall("hold", { text: "wait" })], { stopReason: "toolUse" });
    const f = await setup(t, { A: [reply], B: [fauxAssistantMessage("Saved target result")] });
    const hold = countingTool("hold", (_params, signal) => blockingUntilAborted(signal));
    f.extension.currentTools = async () => [{ tool: hold, replay: "unsafe" }];
    await f.post();
    if (outcome === "stopped") {
      await waitFor(() => hold.executions.length === 1);
      await f.runtime.stop("A");
    }
    await waitFor(async () => (await f.ledger.open()).length === 0);
    const view = await (await f.runtime.conversation("A")).context(BACKGROUND_CONTEXT);
    const saved = view.entries
      .filter((e) => e.kind === BOT_MESSAGE_STATUS_ENTRY_KIND)
      .map((e) => e.data as unknown as BotMessageStatusEntryData);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.outcome, "replied_while_paused");
    assert.equal(saved[0]!.text, "Saved target result");
    assert.equal(f.models.get("A")!.calls(), 1);
    assert.equal(f.sends.length, 2);
    assert.equal(
      f.deliveries.some((d) => (d as { dedupeKey: string }).dedupeKey.endsWith(":final")),
      false,
    );
    assert.deepEqual(f.errors, []);
  });
}

test("a real spending refusal preserves the reply immediately without running the sender", async (t) => {
  const f = await setup(
    t,
    { A: [], B: [fauxAssistantMessage("Saved budget result")] },
    undefined,
    undefined,
    async (id) => (id === "A" ? "Monthly limit reached" : undefined),
  );
  const accepted = await f.post();
  await waitFor(async () => (await f.ledger.open()).length === 0);
  const view = await (await f.runtime.conversation("A")).context(BACKGROUND_CONTEXT);
  const rows = view.entries
    .filter((e) => e.kind === BOT_MESSAGE_STATUS_ENTRY_KIND)
    .map((e) => e.data as unknown as BotMessageStatusEntryData);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcome, "replied_while_paused");
  assert.equal(rows[0]!.text, "Saved budget result");
  assert.equal(f.models.get("A")!.calls(), 0);
  assert.equal(f.sends.length, 1);
  assert.ok((await f.ledger.get(accepted.deliveryId))!.effects.find((e) => e.kind === "reply")!.acknowledgedAt);
  assert.deepEqual(f.errors, []);
});
