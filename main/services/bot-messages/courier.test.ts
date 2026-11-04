import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { BotReplyOutcome, BotSendInput, BotSessionState } from "../bot-runtime/bot-session-service.js";
import { createBotApprovals } from "../bot-runtime/bot-approvals.js";
import { createBotMessageLedger } from "./ledger.js";
import { createBotMessageCourier, type BotRosterEntry } from "./courier.js";
import { waitFor } from "../bot-runtime/test-support/faux.js";
async function setup(t: TestContext, options: {
  botExists?(botId: string): Promise<boolean>;
  beforeRoster?(): void;
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bot-courier-"));
  let now = 1000,
    enabled = true;
  const ledger = createBotMessageLedger({
    file: () => path.join(dir, "bot-messages.json"),
    now: () => now,
  });
  let roster: BotRosterEntry[] = ["A", "B", "C"].map((id) => ({
    id,
    name: id,
    purpose: "help",
    acceptsMessages: true,
    sendsMessages: true,
  }));
  const states = new Map<string, BotSessionState>();
  const submissions = new Map<string, string>(),
    answers = new Map<string, BotReplyOutcome>();
  const sends: Array<{
      botId: string;
      input: BotSendInput;
      submissionId: string;
    }> = [],
    notices: unknown[] = [],
    deliveries: unknown[] = [],
    errors: unknown[] = [];
  const activeWaits = new Set<string>();
  const listeners = new Set<(botId: string) => void>(),
    waiting = new Map<string, () => void>();
  const timers = new Set<{
    at: number;
    fn: () => void;
    handle?: ReturnType<typeof setTimeout>;
  }>();
  const approvals = createBotApprovals({ publish: () => undefined });
  const sessions = {
    send: async (botId: string, input: BotSendInput) => {
      const key = `${botId}:${input.requestId}`,
        old = submissions.get(key);
      if (old) return { submissionId: old, deduped: true };
      const state = states.get(botId);
      if (state && state.kind !== "idle")
        throw Object.assign(new Error("busy"), {
          reason: state.kind === "interrupted" ? "bot_paused" : "bot_busy",
        });
      const submissionId = randomUUID();
      submissions.set(key, submissionId);
      sends.push({ botId, input, submissionId });
      return { submissionId, deduped: false };
    },
    state: async (id: string) => states.get(id) ?? { kind: "idle" as const },
    submissionForRequest: async (botId: string, id: string) => submissions.get(`${botId}:${id}`),
    awaitReply: async (_botId: string, id: string, signal: AbortSignal): Promise<BotReplyOutcome> => {
      assert.equal(activeWaits.has(id), false, "only one active wait owns a submission");
      activeWaits.add(id);
      if (!answers.has(id) && !signal.aborted)
        await new Promise<void>((resolve) => {
          waiting.set(id, resolve);
          signal.addEventListener(
            "abort",
            () => {
              waiting.delete(id);
              resolve();
            },
            { once: true },
          );
        });
      waiting.delete(id);
      activeWaits.delete(id);
      return answers.get(id) ?? { kind: "interrupted" };
    },
    markSilent: async () => undefined,
    appendEntry: async (_id: string, _kind: string, data: unknown) => {
      if (
        !notices.some(
          (n) =>
            (
              n as {
                effectId: string;
              }
            ).effectId ===
            (
              data as {
                effectId: string;
              }
            ).effectId,
        )
      )
        notices.push(data);
    },
  };
  let deliveryFault: (() => void) | undefined;
  const create = () =>
    createBotMessageCourier({
      ledger,
      sessions,
      roster: async () => { options.beforeRoster?.(); return roster; },
      ...(options.botExists ? { botExists: options.botExists } : {}),
      enabled: async () => enabled,
      approvals,
      onStateChange: (fn) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
      now: () => now,
      deliver: async (input) => {
        deliveryFault?.();
        if (
          !deliveries.some(
            (d) =>
              (
                d as {
                  dedupeKey: string;
                }
              ).dedupeKey === input.dedupeKey,
          )
        )
          deliveries.push(input);
      },
      report: (e) => errors.push(e),
      setTimer: (fn, ms) => {
        const timer = {
          at: now + ms,
          fn,
          handle: undefined as ReturnType<typeof setTimeout> | undefined,
        };
        timers.add(timer);
        if (ms === 0)
          timer.handle = setTimeout(() => {
            timers.delete(timer);
            fn();
          }, 0);
        return {
          cancel: () => {
            if (timer.handle) clearTimeout(timer.handle);
            timers.delete(timer);
          },
        };
      },
    });
  let courier = create();
  t.after(async () => {
    await courier.dispose();
    assert.equal(timers.size, 0, "all courier timers are cancelled before removing storage");
    await rm(dir, { recursive: true, force: true });
  });
  await courier.start();
  const post = (
    from = "A",
    target = "B",
    ids: readonly (string | undefined)[] = [undefined],
    deliveryId = randomUUID(),
  ) =>
    courier.post({
      fromBotId: from,
      target,
      message: "hello",
      deliveryId,
      runRequestIds: ids,
    });
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    await waitFor(predicate, { what: "courier transition" });
    assert.deepEqual(errors, []);
  };
  const finish = (index: number, text = "answer") => {
    const id = sends[index]!.submissionId;
    answers.set(id, { kind: "completed", text });
    waiting.get(id)?.();
  };
  return {
    setRoster: (next: BotRosterEntry[]) => {
      roster = next;
    },
    finishOutcome: (index: number, outcome: BotReplyOutcome) => {
      const id = sends[index]!.submissionId;
      answers.set(id, outcome);
      waiting.get(id)?.();
    },
    setDeliveryFault: (fault: (() => void) | undefined) => {
      deliveryFault = fault;
    },
    ledger,
    sessions,
    sends,
    notices,
    deliveries,
    errors,
    timers,
    approvals,
    post,
    until,
    finish,
    states,
    pendingTimers: () => timers.size,
    create,
    get courier() {
      return courier;
    },
    restart: async () => {
      await courier.dispose();
      courier = create();
      await courier.start();
      await courier.start();
    },
    toggle: () => {
      enabled = false;
    },
    remove: (id: string) => {
      roster = roster.filter((r) => r.id !== id);
    },
    wake: (id: string) => {
      for (const l of listeners) l(id);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer);
          if (timer.handle) clearTimeout(timer.handle);
          timer.fn();
        }
      await new Promise((r) => setTimeout(r, 15));
    },
  };
}
test("post accepts durably without any session call and later carries one final reply", async (t) => {
  const f = await setup(t);
  const result = await f.post();
  assert.equal(result.status, "sent");
  assert.equal(f.sends.length, 0);
  await f.until(() => f.sends.length === 1);
  f.finish(0, "B answer");
  await f.until(() => f.sends.length === 2);
  assert.equal(f.sends[1]!.botId, "A");
  assert.ok(f.sends[1]!.input.requestId.startsWith("botreply:"));
  f.finish(1, "For the person");
  await f.until(() => f.deliveries.length === 1);
  assert.equal((f.deliveries[0] as { title: string }).title, "B replied");
  await f.restart();
  assert.equal(f.sends.length, 2);
  assert.equal(f.deliveries.length, 1);
});
test("accepted deliveries use identity reads without repeating full roster availability discovery", async t => {
  let accepted = false, rosterReads = 0;
  const f = await setup(t, {
    botExists: async id => ["A", "B", "C"].includes(id),
    beforeRoster: () => {
      rosterReads++;
      if (accepted) throw new Error("unrelated Bot availability cannot be read");
    },
  });
  assert.equal((await f.post()).status, "sent");
  accepted = true;
  await waitFor(() => f.sends.length > 0 || f.errors.length > 0, { what: "identity-only target dispatch" });
  assert.deepEqual(f.errors, [], "unrelated availability cannot strand an accepted message");
  assert.equal(f.sends[0]!.botId, "B");
  f.finish(0, "Pong");
  await f.until(() => f.sends.length === 2);
  assert.equal(f.sends[1]!.botId, "A");
  f.finish(1, "Beta says Pong");
  await f.until(() => f.deliveries.length === 1);
  assert.equal(rosterReads, 1, "posting still performs the full availability checks");
});

for (const unavailable of ["missing", "read error"] as const) {
  test(`identity-only dispatch refuses ${unavailable} without invoking a session`, async t => {
    const failure = new Error("Bot identity store unavailable");
    const f = await setup(t, { botExists: async id => {
      if (id !== "B") return true;
      if (unavailable === "read error") throw failure;
      return false;
    } });
    const result = await f.post();
    assert.equal(result.status, "sent");
    await waitFor(() => f.notices.length > 0 || f.errors.length > 0 || f.sends.length > 0, { what: "missing identity dispatch" });
    assert.deepEqual(f.sends, [], "existence never authorizes sending to an absent or unreadable Bot");
    if (unavailable === "read error") {
      assert.deepEqual(f.errors, [failure]);
      assert.equal((await f.ledger.get((result as { deliveryId: string }).deliveryId))!.status, "delivered");
    } else {
      assert.deepEqual(f.errors, []);
      assert.equal((await f.ledger.get((result as { deliveryId: string }).deliveryId))!.status, "failed");
    }
  });
}
test("deletion during an identity read fences a late positive result", async t => {
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, { botExists: async id => {
    if (id === "B") { entered(); await held; }
    return true;
  } });
  await f.post();
  await checking;
  try { await f.courier.forgetBot("B"); } finally { release(); }
  await f.until(() => f.notices.length === 1);
  assert.deepEqual(f.sends, [], "a completed identity read cannot resurrect deleted work");
});

test("a positive identity read still submits through the fresh session refusal", async t => {
  const f = await setup(t, { botExists: async () => true });
  let checked = 0;
  f.sessions.send = async () => {
    checked++;
    throw Object.assign(new Error("paused after posting"), { reason: "paused_by_person" });
  };
  const result = await f.post();
  await f.until(() => f.notices.length === 1);
  assert.equal(checked, 1);
  assert.deepEqual(f.sends, []);
  assert.equal((await f.ledger.get((result as { deliveryId: string }).deliveryId))!.status, "failed");
});
test("busy targets expire with one notice and no queued session input", async (t) => {
  const f = await setup(t);
  f.states.set("B", { kind: "running", submissionId: "human" });
  await f.post();
  await f.advance(10);
  assert.equal(f.sends.length, 0);
  await f.advance(1800001);
  await f.until(() => f.notices.length === 1);
  assert.equal(
    (
      f.notices[0] as {
        outcome: string;
      }
    ).outcome,
    "expired",
  );
  assert.equal(f.sends.length, 0);
  assert.deepEqual(f.states.get("B"), {
    kind: "running",
    submissionId: "human",
  });
  await f.restart();
  assert.equal(f.notices.length, 1);
});
test("a paused sender gets the saved answer as display text and no model turn", async (t) => {
  const f = await setup(t);
  await f.post();
  await f.until(() => f.sends.length === 1);
  f.states.set("A", { kind: "interrupted", submissionId: "person" });
  f.finish(0, "Saved answer");
  await f.until(() => f.notices.length === 1);
  assert.equal(f.sends.length, 1);
  assert.equal(
    (
      f.notices[0] as {
        text: string;
      }
    ).text,
    "Saved answer",
  );
});
test("accepted intent is recovered without a submission, switches do not cancel it", async (t) => {
  const f = await setup(t);
  const result = await f.post();
  assert.equal(result.status, "sent");
  f.toggle();
  await f.restart();
  await f.until(() => f.sends.length === 1);
  f.finish(0, "[SILENT]");
  await f.until(() => f.notices.length === 1);
  assert.equal(
    (
      f.notices[0] as {
        outcome: string;
      }
    ).outcome,
    "silent",
  );
  assert.equal(f.sends.length, 1);
});
for (const childFirst of [false, true])
  test(`nested exchange sends exactly one origin reply, childFirst=${childFirst}`, async (t) => {
    const f = await setup(t);
    const first = await f.post();
    assert.equal(first.status, "sent");
    if (first.status !== "sent") return;
    await f.until(() => f.sends.length === 1);
    const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
    assert.equal(child.status, "sent");
    await f.until(() => f.sends.length === 2);
    if (childFirst) {
      f.finish(1, "Child answer");
      await f.advance(15);
      assert.equal(f.sends.length, 2);
      f.finish(0, "Initial answer");
    } else {
      f.finish(0, "Initial answer");
      await f.advance(15);
      assert.equal(f.sends.length, 2);
      f.finish(1, "Child answer");
    }
    await f.until(() => f.sends.length === 3);
    assert.equal(f.sends[2]!.botId, "B");
    f.finish(2, "Combined answer");
    await f.until(() => f.sends.length === 4);
    assert.equal(f.sends[3]!.botId, "A");
    assert.equal(f.sends[3]!.input.requestId, `botreply:${first.deliveryId}`);
    f.finish(3, "Person answer");
    await f.until(() => f.deliveries.length === 1);
    await f.restart();
    assert.equal(f.sends.filter((s) => s.botId === "A").length, 1);
  });
test("all owned approvals are denied by expiry, and waiting notices publish while target waits", async (t) => {
  const f = await setup(t);
  const result = await f.post();
  if (result.status !== "sent") throw new Error("not accepted");
  await f.until(() => f.sends.length === 1);
  const requestId = f.sends[0]!.input.requestId;
  const owner = {
    runId: "real",
    inputs: [
      { submissionId: "person", requestId: "human" },
      {
        submissionId: f.sends[0]!.submissionId,
        requestId,
        botMessage: f.sends[0]!.input.botMessage,
      },
    ],
  };
  const outcomes = ["one", "two"].map((waitId) =>
    f.approvals.request({
      botId: "B",
      waitId,
      toolCallId: waitId,
      authorizationFingerprint: "courier-approval-fingerprint",
      toolName: "change",
      summary: waitId,
      signal: undefined,
      owner,
    }),
  );
  await f.until(() => f.notices.length === 2);
  await f.advance(1800001);
  assert.deepEqual((await Promise.all(outcomes)).map(outcome => ({ answer: outcome.answer, source: outcome.source })), [{ answer: "deny", source: "expiry" }, { answer: "deny", source: "expiry" }]);
  await f.until(() => f.notices.length === 3);
  assert.equal(
    (
      f.notices[2] as {
        outcome: string;
      }
    ).outcome,
    "gave_up",
  );
  f.finish(0, "late");
  await f.advance(5);
  assert.equal(f.sends.length, 1);
});
test("deletion removes envelopes and fences late worker writes", async (t) => {
  const f = await setup(t);
  const result = await f.post();
  if (result.status !== "sent") return;
  await f.until(() => f.sends.length === 1);
  f.remove("A");
  await f.courier.forgetBot("A");
  f.finish(0, "late");
  await f.advance(10);
  assert.equal(await f.ledger.get(result.deliveryId), undefined);
  assert.equal(f.sends.length, 1);
  assert.equal(f.notices.length, 0);
});
for (const phase of ["target", "reply", "notice"] as const)
  test(`recovery after ${phase} destination write before acknowledgement`, async (t) => {
    const f = await setup(t);
    let crashed = false;
    const originalSend = f.sessions.send,
      originalAppend = f.sessions.appendEntry;
    f.sessions.send = async (botId, input) => {
      const result = await originalSend(botId, input);
      if (
        !crashed &&
        ((phase === "target" && !input.requestId.startsWith("botreply:")) ||
          (phase === "reply" && input.requestId.startsWith("botreply:")))
      ) {
        crashed = true;
        void f.courier.dispose();
        throw new Error("simulated process loss");
      }
      return result;
    };
    f.sessions.appendEntry = async (...args) => {
      await originalAppend(...args);
      if (!crashed && phase === "notice") {
        crashed = true;
        void f.courier.dispose();
        throw new Error("simulated process loss");
      }
    };
    await f.post();
    await f.until(() => f.sends.length === 1);
    if (phase !== "target") f.finish(0, phase === "notice" ? "[SILENT]" : "answer");
    await waitFor(() => crashed);
    f.errors.length = 0;
    await f.restart();
    if (phase === "target") f.finish(0, "answer");
    if (phase !== "notice") {
      await f.until(() => f.sends.length === 2);
      f.finish(1, "person answer");
      await f.until(() => f.deliveries.length === 1);
      assert.equal(f.sends.filter((s) => !s.input.requestId.startsWith("botreply:")).length, 1);
      assert.equal(f.sends.filter((s) => s.input.requestId.startsWith("botreply:")).length, 1);
    } else await f.until(() => f.notices.length === 1);
    await f.restart();
    assert.equal(f.notices.length, phase === "notice" ? 1 : 0);
  });
test("a claimed delivery is never an unlimited approval wait after terminal expiry", async (t) => {
  const f = await setup(t);
  const result = await f.post();
  if (result.status !== "sent") throw new Error("not accepted");
  await f.until(() => f.sends.length === 1);
  await f.advance(1800001);
  const window = await f.courier.announceWaiting("B", [f.sends[0]!.input.requestId], "late", "late-card");
  assert.equal(window?.expired, true);
  await assert.rejects(f.courier.announceWaiting("B", ["bot:broken"], "bad", "bad-card"), /unavailable/);
  await assert.rejects(
    f.courier.announceWaiting("B", ["bot:J:1:11111111-2222-4333-8444-555555555555"], "missing", "missing-card"),
    /unavailable/,
  );
  assert.equal(await f.courier.announceWaiting("B", ["person"], "ordinary", "person-card"), undefined);
});
test("deleting the target retains one surviving peer failure notice", async (t) => {
  const f = await setup(t);
  const result = await f.post();
  if (result.status !== "sent") return;
  await f.until(() => f.sends.length === 1);
  f.remove("B");
  await f.courier.forgetBot("B");
  await f.until(() => f.notices.length === 1);
  assert.equal(
    (
      f.notices[0] as {
        outcome: string;
      }
    ).outcome,
    "failed",
  );
  assert.equal(await f.ledger.get(result.deliveryId), undefined);
  await f.restart();
  assert.equal(f.notices.length, 1);
});
for (const phase of ["target", "reply", "notice"] as const)
  test(`recovery before ${phase} destination write`, async (t) => {
    const f = await setup(t);
    let crashed = false;
    const crash = () => {
      crashed = true;
      void f.courier.dispose();
      throw new Error("simulated process loss");
    };
    const send = f.sessions.send,
      append = f.sessions.appendEntry;
    f.sessions.send = async (botId, input) => {
      if (
        !crashed &&
        ((phase === "target" && !input.requestId.startsWith("botreply:")) ||
          (phase === "reply" && input.requestId.startsWith("botreply:")))
      )
        crash();
      return send(botId, input);
    };
    f.sessions.appendEntry = async (...args) => {
      if (!crashed && phase === "notice") crash();
      await append(...args);
    };
    await f.post();
    if (phase !== "target") {
      await f.until(() => f.sends.length === 1);
      f.finish(0, phase === "notice" ? "[SILENT]" : "answer");
    }
    await waitFor(() => crashed);
    await f.restart();
    f.errors.length = 0;
    if (phase === "target") {
      await f.until(() => f.sends.length === 1);
      f.finish(0, "answer");
    }
    if (phase !== "notice") {
      await f.until(() => f.sends.length === 2);
      f.finish(1, "person answer");
      await f.until(() => f.deliveries.length === 1);
    } else await f.until(() => f.notices.length === 1);
    await f.restart();
    assert.equal(f.sends.length, phase === "notice" ? 1 : 2);
    assert.equal(f.notices.length, phase === "notice" ? 1 : 0);
  });
for (const after of [false, true])
  test(`recovery ${after ? "after" : "before"} terminal transition`, async (t) => {
    const f = await setup(t);
    let crashed = false;
    const update = f.ledger.update;
    f.ledger.update = async (id, change) => {
      if (!crashed) {
        const current = await f.ledger.get(id);
        if (current?.status === "delivered" && change(structuredClone(current)).status === "answered") {
          crashed = true;
          if (after) await update(id, change);
          void f.courier.dispose();
          throw new Error("simulated process loss");
        }
      }
      return update(id, change);
    };
    await f.post();
    await f.until(() => f.sends.length === 1);
    f.finish(0, "answer");
    await waitFor(() => crashed);
    await f.restart();
    f.errors.length = 0;
    await f.until(() => f.sends.length === 2);
    f.finish(1, "person answer");
    await f.until(() => f.deliveries.length === 1);
    await f.restart();
    assert.equal(f.sends.length, 2);
    assert.equal(f.deliveries.length, 1);
  });
test("funnel failure before acknowledgement replays the stable notification id", async (t) => {
  const f = await setup(t);
  let crashed = false;
  f.setDeliveryFault(() => {
    if (!crashed) {
      crashed = true;
      void f.courier.dispose();
      throw new Error("simulated process loss");
    }
  });
  await f.post();
  await f.until(() => f.sends.length === 1);
  f.finish(0, "answer");
  await f.until(() => f.sends.length === 2);
  f.finish(1, "person answer");
  await waitFor(() => crashed);
  await f.restart();
  f.errors.length = 0;
  await f.until(() => f.deliveries.length === 1);
  await f.restart();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.sends.length, 2);
});
test("a crash after funnel delivery before ledger acknowledgement keeps one effective notification", async (t) => {
  const f = await setup(t);
  let crashed = false;
  const update = f.ledger.update;
  f.ledger.update = async (id, change) => {
    const current = await f.ledger.get(id);
    if (
      !crashed &&
      f.deliveries.length === 1 &&
      current &&
      current.effects.some((e) => e.kind === "notification" && e.acknowledgedAt === undefined)
    ) {
      crashed = true;
      void f.courier.dispose();
      throw new Error("simulated process loss");
    }
    return update(id, change);
  };
  await f.post();
  await f.until(() => f.sends.length === 1);
  f.finish(0, "answer");
  await f.until(() => f.sends.length === 2);
  f.finish(1, "person answer");
  await waitFor(() => crashed);
  await f.restart();
  f.errors.length = 0;
  await f.until(async () => !(await f.ledger.open()).length);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.sends.length, 2);
});
for (const outcome of ["silent", "failed", "expired"] as const)
  test(`nested ${outcome} produces no origin model turn`, async (t) => {
    const f = await setup(t);
    const root = await f.post();
    if (root.status !== "sent") throw new Error("root not admitted");
    await f.until(() => f.sends.length === 1);
    const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
    if (child.status !== "sent") throw new Error("child not admitted");
    await f.until(() => f.sends.length === 2);
    f.finish(0, "Initial answer");
    await f.until(async () => !!(await f.ledger.get(root.deliveryId))?.initialAnswer);
    if (outcome === "expired") await f.advance(1800001);
    else if (outcome === "failed") f.finishOutcome(1, { kind: "failed", error: "provider failed" });
    else f.finish(1, "[SILENT]");
    await f.until(async () => (await f.ledger.get(root.deliveryId))?.outcome === outcome);
    await f.restart();
    assert.equal(f.sends.filter((s) => s.botId === "A").length, 0);
    assert.equal(f.sends.length, 2);
  });
test("caller cancellation cannot erase a durably accepted delivery", async (t) => {
  const f = await setup(t),
    controller = new AbortController();
  const result = await f.courier.post({
    fromBotId: "A",
    target: "B",
    message: "hello",
    deliveryId: randomUUID(),
    runRequestIds: [undefined],
    signal: controller.signal,
  });
  assert.equal(result.status, "sent");
  controller.abort();
  await f.until(() => f.sends.length === 1);
  f.finish(0, "[SILENT]");
  await f.until(() => f.notices.length === 1);
  const aborted = new AbortController();
  aborted.abort();
  const refusal = await f.courier.post({
    fromBotId: "A",
    target: "B",
    message: "new",
    deliveryId: randomUUID(),
    runRequestIds: [undefined],
    signal: aborted.signal,
  });
  assert.equal(refusal.status, "refused");
  assert.equal(f.sends.length, 1);
});
test("current roster resolution and cached availability give precise refusals", async (t) => {
  const f = await setup(t);
  f.setRoster([
    {
      id: "A",
      name: "Ada",
      purpose: "help",
      acceptsMessages: true,
      sendsMessages: true,
    },
    {
      id: "B",
      name: "Bee",
      purpose: "help",
      acceptsMessages: true,
      sendsMessages: true,
    },
    {
      id: "C",
      name: "Bee",
      purpose: "help",
      acceptsMessages: false,
      sendsMessages: true,
    },
  ]);
  const code = (r: Awaited<ReturnType<typeof f.post>>) => (r.status === "refused" ? r.code : "sent");
  assert.equal(code(await f.post("A", "Bee")), "ambiguous_bot");
  assert.equal(code(await f.post("A", "missing")), "unknown_bot");
  assert.equal(code(await f.post("A", "A")), "self");
  assert.equal(code(await f.post("A", "B", ["bot:J:2:00112233-4455-4677-8899-aabbccddeeff"])), "chain_too_deep");
  f.setRoster([
    {
      id: "A",
      name: "Ada",
      purpose: "help",
      acceptsMessages: true,
      sendsMessages: true,
    },
    {
      id: "B",
      name: "New Bee",
      purpose: "help",
      acceptsMessages: true,
      sendsMessages: true,
      unavailable: "needs_model",
    },
  ]);
  assert.equal(code(await f.post("A", "Bee")), "unknown_bot");
  assert.equal(code(await f.post("A", "B")), "needs_model");
  f.toggle();
  assert.equal(code(await f.post("A", "B")), "switched_off");
  assert.equal(f.sends.length, 0);
  assert.deepEqual(await f.ledger.open(), []);
});

for (const outcome of ["silent", "failed"] as const) {
  test(`early child ${outcome} waits for the parent's initial turn, including restart`, async (t) => {
    const f = await setup(t);
    const root = await f.post();
    assert.equal(root.status, "sent");
    if (root.status !== "sent") return;
    await f.until(() => f.sends.length === 1);
    await f.post("B", "C", [f.sends[0]!.input.requestId]);
    await f.until(() => f.sends.length === 2);
    f.finishOutcome(
      1,
      outcome === "silent" ? { kind: "completed", text: "[SILENT]" } : { kind: "failed", error: "failed" },
    );
    await f.until(async () => (await f.ledger.get(root.deliveryId))?.childOutcome === outcome);
    assert.equal((await f.ledger.get(root.deliveryId))?.status, "delivered");
    await f.restart();
    assert.equal((await f.ledger.get(root.deliveryId))?.status, "delivered");
    f.finish(0, "Initial finished");
    await f.until(async () => (await f.ledger.get(root.deliveryId))?.outcome === outcome);
    assert.equal(f.sends.length, 2);
  });
}
test("early child failure still respects the ancestor's deadline when its initial turn never ends", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not sent");
  await f.until(() => f.sends.length === 1);
  await f.post("B", "C", [f.sends[0]!.input.requestId]);
  await f.until(() => f.sends.length === 2);
  f.finishOutcome(1, { kind: "failed", error: "failure" });
  await f.until(async () => (await f.ledger.get(root.deliveryId))?.childOutcome === "failed");
  await f.advance(1800001);
  await f.until(async () => (await f.ledger.get(root.deliveryId))?.outcome === "expired");
  f.finish(0, "Late initial");
  await f.restart();
  assert.equal(f.sends.length, 2);
});
test("an interrupted submitted reply expires to saved text and releases its in-flight slot", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not sent");
  await f.until(() => f.sends.length === 1);
  f.finish(0, "Saved B answer");
  await f.until(() => f.sends.length === 2);
  f.states.set("A", {
    kind: "interrupted",
    submissionId: f.sends[1]!.submissionId,
  });
  f.finishOutcome(1, { kind: "interrupted" });
  await f.advance(1800001);
  await f.until(async () => !(await f.ledger.open()).length);
  assert.equal(f.sends.length, 2);
  assert.ok(f.notices.some((n) => (n as { text?: string }).text === "Saved B answer"));
  assert.equal(f.timers.size, 0);
});
test("case-insensitive original target replays after restart and a rename cannot redirect it", async (t) => {
  const f = await setup(t);
  f.setRoster(
    ["A", "B"].map((id) => ({
      id,
      name: id === "B" ? "Bee" : "Ada",
      purpose: "",
      acceptsMessages: true,
      sendsMessages: true,
    })),
  );
  const id = randomUUID();
  const accepted = await f.post("A", "bEe", [undefined], id);
  await f.until(() => f.sends.length === 1);
  await f.restart();
  f.setRoster(
    ["A", "B", "C"].map((id) => ({
      id,
      name: id === "C" ? "Bee" : id,
      purpose: "",
      acceptsMessages: true,
      sendsMessages: true,
    })),
  );
  assert.deepEqual(await f.post("A", "bEe", [undefined], id), accepted);
  assert.deepEqual(await f.post("A", "BEE", [undefined], id), accepted);
  assert.equal((await f.post("A", "C", [undefined], id)).status, "refused");
  assert.equal(f.sends.length, 1);
});
test("answered approval history cannot turn an unrelated timeout into gave_up", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not sent");
  await f.until(() => f.sends.length === 1);
  const sent = f.sends[0]!;
  const request = f.approvals.request({
    botId: "B",
    waitId: "answered",
    toolCallId: "call",
    authorizationFingerprint: "courier-approval-fingerprint",
    toolName: "change",
    summary: "Change it",
    signal: undefined,
    owner: {
      runId: "run",
      inputs: [
        {
          submissionId: sent.submissionId,
          requestId: sent.input.requestId,
          botMessage: sent.input.botMessage,
        },
      ],
    },
  });
  await f.until(() => f.notices.length === 1);
  f.approvals.decide("answered", "allow");
  assert.equal((await request).answer, "allow");
  await f.until(async () => !(await f.ledger.get(root.deliveryId))?.waiting.length);
  await f.advance(1800001);
  await f.until(async () => (await f.ledger.get(root.deliveryId))?.outcome === "expired");
});
test("reply approval notice names its actual owner and deletion denies it by expiry", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not sent");
  await f.until(() => f.sends.length === 1);
  f.finish(0, "Answer");
  await f.until(() => f.sends.length === 2);
  const sent = f.sends[1]!;
  const sources: string[] = [];
  const decide = f.approvals.decide;
  f.approvals.decide = (id, choice, scope, source) => {
    sources.push(source ?? "person");
    return decide(id, choice, scope, source);
  };
  const request = f.approvals.request({
    botId: "A",
    waitId: "reply-card",
    toolCallId: "call",
    authorizationFingerprint: "courier-approval-fingerprint",
    toolName: "change",
    summary: "Change",
    signal: undefined,
    owner: {
      runId: "run",
      inputs: [
        {
          submissionId: sent.submissionId,
          requestId: sent.input.requestId,
          botMessage: sent.input.botMessage,
        },
      ],
    },
  });
  await f.until(() => f.notices.length === 1);
  assert.equal((f.notices[0] as { botName: string }).botName, "A");
  f.remove("B");
  await f.courier.forgetBot("B");
  assert.equal((await request).answer, "deny");
  assert.ok(sources.includes("expiry"));
  await f.until(() => f.notices.length === 2);
  assert.equal((f.notices[1] as { outcome: string }).outcome, "failed");
});
test("deleting an early child repairs the parent and waits for its initial turn", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not sent");
  await f.until(() => f.sends.length === 1);
  await f.post("B", "C", [f.sends[0]!.input.requestId]);
  await f.until(() => f.sends.length === 2);
  f.remove("C");
  await f.courier.forgetBot("C");
  assert.equal((await f.ledger.get(root.deliveryId))?.childOutcome, "failed");
  assert.equal((await f.ledger.get(root.deliveryId))?.status, "delivered");
  f.finish(0, "Initial settled");
  await f.until(async () => (await f.ledger.get(root.deliveryId))?.outcome === "failed");
  assert.equal(f.sends.length, 2);
});

test("a person's turn may send several requested messages while an incoming turn has one child", async (t) => {
  const f = await setup(t);
  assert.equal((await f.post("A", "B")).status, "sent");
  assert.equal((await f.post("A", "C")).status, "sent");
  await f.until(() => f.sends.length === 2);
  const parent = f.sends.find((s) => s.botId === "B")!;
  assert.equal((await f.post("B", "C", [parent.input.requestId])).status, "sent");
  assert.equal((await f.post("B", "C", [parent.input.requestId])).status, "refused");
  assert.equal((await f.post("A", "C", [])).status, "refused");
});

for (const outcome of [
  { kind: "failed", error: "provider failed" },
  { kind: "interrupted", settled: true },
] as const) {
  test(`a ${outcome.kind} settled reply turn preserves the target answer once`, async (t) => {
    const f = await setup(t);
    const accepted = await f.post();
    assert.equal(accepted.status, "sent");
    await f.until(() => f.sends.length === 1);
    f.finish(0, "Saved target answer");
    await f.until(() => f.sends.length === 2);
    f.finishOutcome(1, outcome);
    await f.until(() => f.notices.length === 1);
    assert.equal((f.notices[0] as { outcome: string }).outcome, "replied_while_paused");
    assert.equal((f.notices[0] as { text: string }).text, "Saved target answer");
    await f.until(async () => (await f.ledger.open()).length === 0);
    await f.restart();
    assert.equal(f.notices.length, 1);
    assert.equal(f.sends.length, 2, "fallback never starts another model turn");
    assert.equal(
      f.deliveries.some((d) => (d as { dedupeKey: string }).dedupeKey.endsWith(":final")),
      false,
    );
  });
}

for (const turn of ["request", "reply"] as const) {
  test(`a withdrawn ${turn} approval can reappear under its durable wait id`, async (t) => {
    const f = await setup(t);
    const accepted = await f.post();
    if (accepted.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 1);
    if (turn === "reply") {
      f.finish(0, "Answer");
      await f.until(() => f.sends.length === 2);
    }
    const sent = f.sends[turn === "reply" ? 1 : 0]!;
    const request = {
      botId: sent.botId,
      waitId: "same",
      toolCallId: "call",
      authorizationFingerprint: "courier-approval-fingerprint",
      toolName: "change",
      summary: "Change event",
      owner: {
        runId: "run",
        inputs: [
          { submissionId: sent.submissionId, requestId: sent.input.requestId, botMessage: sent.input.botMessage },
        ],
      },
    };
    const controller = new AbortController();
    const first = f.approvals.requestOutcome({ ...request, signal: controller.signal });
    await f.until(async () => (await f.ledger.get(accepted.deliveryId))!.waiting.length === 1);
    const withdrawn = assert.rejects(first, /withdrawn|abort/iu);
    controller.abort();
    await withdrawn;
    await f.until(async () => (await f.ledger.get(accepted.deliveryId))!.waiting.length === 0);
    const window = await f.courier.announceWaiting(sent.botId, [sent.input.requestId], request.summary, request.waitId);
    assert.equal(window?.expired, false);
    const second = f.approvals.requestOutcome({ ...request, signal: undefined });
    await f.until(
      async () =>
        f.approvals.pending(sent.botId).length === 1 && (await f.ledger.get(accepted.deliveryId))!.waiting.length === 1,
    );
    const row = (await f.ledger.get(accepted.deliveryId))!;
    assert.equal(row.effects.filter((e) => e.kind === "notice" && e.data?.waitId === "same").length, 1);
    await f.advance(1800001);
    assert.deepEqual(await second, { id: "same", authorizationFingerprint: "courier-approval-fingerprint", answer: "deny", source: "expiry" });
    if (turn === "request")
      await f.until(() => f.notices.some((n) => (n as { outcome: string }).outcome === "gave_up"));
  });
}

test("parallel approval publication preserves a preannounced second card without duplicate effects", async (t) => {
  const f = await setup(t);
  const accepted = await f.post();
  if (accepted.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 1);
  const sent = f.sends[0]!;
  const request = {
    botId: "B",
    toolCallId: "call",
    authorizationFingerprint: "courier-approval-fingerprint",
    toolName: "change",
    summary: "Change event",
    signal: undefined,
    owner: {
      runId: "run",
      inputs: [{ submissionId: sent.submissionId, requestId: sent.input.requestId, botMessage: sent.input.botMessage }],
    },
  };
  await f.courier.announceWaiting("B", [sent.input.requestId], request.summary, "two");
  const one = f.approvals.requestOutcome({ ...request, waitId: "one" });
  await f.until(async () => {
    const row = (await f.ledger.get(accepted.deliveryId))!;
    return row.waiting.some((w) => w.waitId === "one") && !row.waiting.some((w) => w.waitId === "two");
  });
  const two = f.approvals.requestOutcome({ ...request, waitId: "two" });
  await f.until(
    async () => f.approvals.pending().length === 2 && (await f.ledger.get(accepted.deliveryId))!.waiting.length === 2,
  );
  assert.equal(
    f.approvals.pending().some((p) => p.decisionSource === "expiry"),
    false,
  );
  await f.advance(1800001);
  assert.deepEqual(await Promise.all([one, two]), [
    { id: "one", authorizationFingerprint: "courier-approval-fingerprint", answer: "deny", source: "expiry" },
    { id: "two", authorizationFingerprint: "courier-approval-fingerprint", answer: "deny", source: "expiry" },
  ]);
  await f.until(() => f.notices.some((n) => (n as { outcome: string }).outcome === "gave_up"));
});

test("disposal joins a worker held before its first deadline arm and leaves no late work", async (t) => {
  const f = await setup(t);
  const get = f.ledger.get;
  let held = false,
    first = true,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.ledger.get = async (id) => {
    const row = await get(id);
    if (first) {
      first = false;
      held = true;
      await barrier;
    }
    return row;
  };
  const accepted = await f.post();
  if (accepted.status !== "sent") throw new Error("not admitted");
  let closing!: Promise<void>;
  try {
    await waitFor(() => held);
    closing = f.courier.dispose();
  } finally {
    release();
  }
  await closing;
  const before = await f.ledger.get(accepted.deliveryId);
  assert.equal(f.pendingTimers(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.pendingTimers(), 0);
  await f.advance(1800001);
  assert.deepEqual(await f.ledger.get(accepted.deliveryId), before);
  assert.equal(f.sends.length, 0);
  assert.equal(f.notices.length, 0);
});

for (const kind of ["failed", "interrupted"] as const) {
  test(`a parked answered child settles when its parent's initial turn is ${kind}`, async (t) => {
    const f = await setup(t);
    const root = await f.post();
    if (root.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 1);
    const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
    if (child.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 2);
    f.finish(1, "C answered already");
    await f.until(async () => (await f.ledger.get(child.deliveryId))?.initialAnswer === "C answered already");
    f.finishOutcome(0, kind === "failed" ? { kind, error: "parent failed" } : { kind, settled: true });
    await f.until(async () => (await f.ledger.get(child.deliveryId))?.status === "answered");
    await f.until(async () => (await f.ledger.open()).length === 0);
    assert.equal(
      f.notices.some((n) => (n as { outcome: string }).outcome === "expired"),
      false,
    );
    assert.equal(f.sends.length, 2);
    for (let i = 0; i < 3; i++) assert.equal((await f.post("B", "A")).status, "sent", "child no longer holds capacity");
  });
}

test("deadline recovery preserves an already answered child when its parent ended", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 1);
  const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
  if (child.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 2);
  f.finish(1, "C answered already");
  await f.until(async () => !!(await f.ledger.get(child.deliveryId))?.initialAnswer);
  // Persisted crash boundary: the parent ended before it could wake its child.
  await f.ledger.update(root.deliveryId, (row) => ({
    ...row,
    status: "failed",
    outcome: "failed",
    effects: row.effects.map((e) => ({ ...e, acknowledgedAt: 1000 })),
  }));
  await f.advance(1800001);
  await f.until(async () => (await f.ledger.get(child.deliveryId))?.status === "answered");
  assert.equal(
    f.notices.some((n) => (n as { outcome: string }).outcome === "expired"),
    false,
  );
});

test("restart derives the child's committed quiet outcome if the parent hint was not written", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 1);
  const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
  if (child.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 2);
  f.finish(0, "Initial answer ended");
  await f.until(async () => !!(await f.ledger.get(root.deliveryId))?.initialAnswer);
  await f.courier.dispose();
  // Only the child's first write survived the crash; its parent hint did not.
  await f.ledger.update(child.deliveryId, (row) => ({
    ...row,
    status: "failed",
    outcome: "failed",
    effects: row.effects.map((e) => ({ ...e, acknowledgedAt: 1000 })),
  }));
  assert.equal((await f.ledger.get(root.deliveryId))!.childOutcome, undefined);
  await f.restart();
  await f.until(async () => (await f.ledger.get(root.deliveryId))?.outcome === "failed");
  assert.equal(f.sends.length, 2);
});

for (const parentOutcome of ["expired", "gave_up", "live", "live_card"] as const) {
  test(`a saved child answer is displayed once when its ancestor ends via ${parentOutcome}`, async (t) => {
    const f = await setup(t);
    const root = await f.post();
    if (root.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 1);
    const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
    if (child.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 2);
    f.finish(1, "C answered before the deadline");
    await f.until(async () => !!(await f.ledger.get(child.deliveryId))?.initialAnswer);
    let card: Promise<unknown> | undefined;
    if (parentOutcome === "live_card") {
      const sent = f.sends[0]!;
      card = f.approvals.requestOutcome({
        botId: "B",
        waitId: "parent",
        toolCallId: "call",
        authorizationFingerprint: "courier-approval-fingerprint",
        toolName: "change",
        summary: "Parent action",
        signal: undefined,
        owner: {
          runId: "parent",
          inputs: [
            { submissionId: sent.submissionId, requestId: sent.input.requestId, botMessage: sent.input.botMessage },
          ],
        },
      });
      await f.until(async () => (await f.ledger.get(root.deliveryId))!.waiting.length === 1);
    } else if (parentOutcome !== "live") {
      await f.ledger.update(root.deliveryId, (row) => ({
        ...row,
        status: "expired",
        outcome: parentOutcome,
        effects: row.effects.map((e) => ({ ...e, acknowledgedAt: 1000 })),
      }));
    }
    await f.advance(1800001);
    if (card) assert.deepEqual(await card, { id: "parent", authorizationFingerprint: "courier-approval-fingerprint", answer: "deny", source: "expiry" });
    await f.until(async () => (await f.ledger.open()).length === 0);
    assert.equal(
      (await f.ledger.get(root.deliveryId))!.outcome,
      parentOutcome === "live_card" ? "gave_up" : parentOutcome === "live" ? "expired" : parentOutcome,
    );
    const rows = f.notices.filter((n) => (n as { botName: string }).botName === "C") as Array<{
      outcome: string;
      text?: string;
    }>;
    assert.deepEqual(
      rows.map((n) => [n.outcome, n.text]),
      [["replied_while_paused", "C answered before the deadline"]],
    );
    assert.equal((await f.ledger.get(child.deliveryId))!.status, "answered");
    assert.equal(f.sends.length, 2);
    await f.restart();
    assert.equal(f.notices.filter((n) => (n as { botName: string }).botName === "C").length, 1);
  });
}

for (const ownCard of [false, true]) {
  test(`a child inherits no approval claim from its parent, own child card=${ownCard}`, async (t) => {
    const f = await setup(t);
    const root = await f.post();
    if (root.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 1);
    const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
    if (child.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 2);
    let card: Promise<unknown> | undefined;
    if (ownCard) {
      const sent = f.sends[1]!;
      card = f.approvals.requestOutcome({
        botId: "C",
        waitId: "child",
        toolCallId: "call",
        authorizationFingerprint: "courier-approval-fingerprint",
        toolName: "change",
        summary: "Child action",
        signal: undefined,
        owner: {
          runId: "child",
          inputs: [
            { submissionId: sent.submissionId, requestId: sent.input.requestId, botMessage: sent.input.botMessage },
          ],
        },
      });
      await f.until(async () => (await f.ledger.get(child.deliveryId))!.waiting.length === 1);
    }
    await f.ledger.update(root.deliveryId, (row) => ({
      ...row,
      status: "expired",
      outcome: "gave_up",
      effects: row.effects.map((e) => ({ ...e, acknowledgedAt: 1000 })),
    }));
    await f.advance(1800001);
    if (card) assert.deepEqual(await card, { id: "child", authorizationFingerprint: "courier-approval-fingerprint", answer: "deny", source: "expiry" });
    await f.until(async () => (await f.ledger.open()).length === 0);
    assert.equal((await f.ledger.get(child.deliveryId))!.outcome, ownCard ? "gave_up" : "expired");
    assert.equal(f.approvals.pending().length, 0);
  });
}

test("nested saved-text fallback has one truthful child row and one parent failure", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 1);
  const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
  if (child.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 2);
  f.finish(1, "C's saved answer");
  await f.until(async () => !!(await f.ledger.get(child.deliveryId))?.initialAnswer);
  f.states.set("B", { kind: "interrupted", submissionId: "paused" });
  f.finish(0, "Initial B turn ended");
  await f.until(async () => (await f.ledger.open()).length === 0);
  const rows = f.notices as Array<{ botName: string; outcome: string; text?: string }>;
  assert.deepEqual(
    rows.filter((n) => n.botName === "C").map((n) => [n.outcome, n.text]),
    [["replied_while_paused", "C's saved answer"]],
  );
  assert.deepEqual(
    rows.filter((n) => n.botName === "B").map((n) => n.outcome),
    ["failed"],
  );
  assert.equal(f.sends.length, 2);
  assert.deepEqual(
    f.deliveries.map((d) => (d as { botId: string }).botId),
    ["A"],
    "only the ancestor status reaches the funnel",
  );
  for (let i = 0; i < 3; i++) assert.equal((await f.post("B", "A")).status, "sent");
});

for (const checkpoint of ["acknowledged_reply", "terminal_fallback"] as const) {
  test(`restart completes nested fallback checkpoint ${checkpoint} and becomes quiescent`, async (t) => {
    const f = await setup(t);
    const root = await f.post();
    if (root.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 1);
    const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
    if (child.status !== "sent") throw new Error("not admitted");
    await f.until(() => f.sends.length === 2);
    f.finish(1, "C's persisted answer");
    f.finish(0, "B initial ended");
    await f.until(() => f.sends.length === 3);
    await f.courier.dispose();
    // The child's fallback write survived, but the parent's failure write did not.
    await f.ledger.update(child.deliveryId, (row) => {
      const data = {
        deliveryId: child.deliveryId,
        botId: "C",
        botName: "C",
        outcome: "replied_while_paused" as const,
        text: "C's persisted answer",
      };
      const key = `${child.deliveryId}:replied_while_paused:final`;
      return {
        ...row,
        ...(checkpoint === "terminal_fallback"
          ? ({ status: "answered", outcome: "replied_while_paused", parentFallbackOutcome: "failed" } as const)
          : {}),
        effects: [
          ...row.effects.map((e) => (e.kind === "reply" ? { ...e, acknowledgedAt: 1000 } : e)),
          { id: `${key}:notice`, kind: "notice", botId: "B", data },
          { id: `${key}:notification`, kind: "notification", botId: "B", data },
        ],
      };
    });
    let reads = 0;
    const get = f.ledger.get;
    f.ledger.get = async (id) => {
      reads++;
      return get(id);
    };
    await f.restart();
    await f.until(async () => (await f.ledger.open()).length === 0 && f.pendingTimers() === 0);
    assert.equal((await f.ledger.get(root.deliveryId))!.outcome, "failed");
    assert.equal((await f.ledger.get(child.deliveryId))!.status, "answered");
    const rows = f.notices as Array<{ botName: string; outcome: string; text?: string }>;
    assert.deepEqual(
      rows.filter((n) => n.botName === "C").map((n) => [n.outcome, n.text]),
      [["replied_while_paused", "C's persisted answer"]],
    );
    const settledReads = reads;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reads, settledReads);
    assert.equal(f.pendingTimers(), 0);
    assert.equal(f.sends.length, 3);
    assert.equal(
      f.deliveries.some((d) => (d as { botId: string }).botId === "B"),
      false,
      "even a saved legacy notification cannot forward the child answer",
    );
  });
}

test("restart preserves a completed silent child relay instead of displaying its saved input", async (t) => {
  const f = await setup(t);
  const root = await f.post();
  if (root.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 1);
  const child = await f.post("B", "C", [f.sends[0]!.input.requestId]);
  if (child.status !== "sent") throw new Error("not admitted");
  await f.until(() => f.sends.length === 2);
  f.finish(1, "C's answer considered by B");
  f.finish(0, "B's initial answer");
  await f.until(() => f.sends.length === 3);
  await f.courier.dispose();
  // B's relay chose silence and the parent's first write survived the crash.
  await f.ledger.update(root.deliveryId, (row) => ({
    ...row,
    status: "answered",
    outcome: "silent",
    effects: row.effects.map((e) => ({ ...e, acknowledgedAt: 1000 })),
  }));
  await f.restart();
  await f.until(async () => (await f.ledger.open()).length === 0);
  assert.equal((await f.ledger.get(child.deliveryId))!.outcome, "replied");
  assert.equal(f.notices.filter((n) => (n as { botName: string }).botName === "C").length, 0);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.sends.length, 3);
});
