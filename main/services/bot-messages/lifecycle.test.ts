import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createBotMessageLifecycle } from "./lifecycle.js";
import { createBotMessageCourier, type BotMessageCourier } from "./courier.js";
import { createBotMessageLedger } from "./ledger.js";
import { createBotApprovals } from "../bot-runtime/bot-approvals.js";
import { temporaryDirectory } from "../../shared/temp-dir-test-support.js";

test("late tools cannot recreate messaging during quit; only explicit start reopens it", async () => {
  let factories = 0,
    posts = 0,
    disposed = 0;
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createBotMessageLifecycle({
    report: () => assert.fail("unexpected startup failure"),
    create: (): BotMessageCourier => {
      factories++;
      return {
        start: async () => {},
        post: async () => {
          posts++;
          return { status: "sent", deliveryId: "id", to: { id: "B", name: "B" } };
        },
        dispose: async () => {
          disposed++;
          await closing;
        },
        forgetBot: async () => {},
        announceWaiting: async () => undefined,
      };
    },
  });
  await service.start();
  const quit = service.dispose();
  const input = { fromBotId: "A", target: "B", message: "hello", deliveryId: "id", runRequestIds: [undefined] };
  assert.deepEqual(await service.post(input), {
    status: "refused",
    code: "unavailable",
    message: "Bot messaging is shut down.",
  });
  assert.equal(factories, 1);
  assert.equal(posts, 0);
  assert.equal(await service.announceWaiting("B", [undefined], "Person's action", "person"), undefined);
  await assert.rejects(service.announceWaiting("B", ["bot:malformed"], "Bot action", "bot"), /shut down/u);
  release();
  await quit;
  assert.equal((await service.post(input)).status, "refused");
  await service.start();
  assert.equal((await service.post(input)).status, "sent");
  assert.equal(factories, 2);
  assert.equal(disposed, 1);
  await service.dispose();
});

test("corrupt messaging storage is reported without rejecting Bot startup or altering evidence", async (t) => {
  const dir = await temporaryDirectory(t, "bot-message-lifecycle-");
  const file = path.join(dir, "bot-messages.json");
  await writeFile(file, "broken");
  const reports: unknown[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("startup must not call a session");
  };
  const service = createBotMessageLifecycle({
    report: (error) => reports.push(error),
    create: () =>
      createBotMessageCourier({
        ledger: createBotMessageLedger({ file: () => file, now: Date.now }),
        sessions: {
          send: unexpected,
          awaitReply: unexpected,
          markSilent: unexpected,
          appendEntry: unexpected,
          state: unexpected,
          submissionForRequest: unexpected,
        },
        approvals: createBotApprovals({ publish: () => {} }),
        roster: async () => [],
        enabled: async () => true,
        onStateChange: () => () => {},
        now: Date.now,
        setTimer: () => {
          assert.fail("corrupt ledger has no work to schedule");
        },
      }),
  });
  await service.start();
  assert.equal(reports.length, 1);
  const result = await service.post({
    fromBotId: "A",
    target: "B",
    message: "hello",
    deliveryId: randomUUID(),
    runRequestIds: [undefined],
  });
  assert.equal(result.status, "refused");
  if (result.status === "refused") {
    assert.equal(result.code, "unavailable");
    assert.match(result.message, /bot-messages\.json/u);
  }
  assert.equal(await readFile(file, "utf8"), "broken");
  await service.dispose();
});

test("disposing before start fences post and forgetBot without instantiating the courier until start()", async () => {
  let factories = 0;
  let forgotten: string[] = [];
  const service = createBotMessageLifecycle({
    report: () => assert.fail("unexpected startup failure"),
    create: (): BotMessageCourier => {
      factories += 1;
      return {
        start: async () => {},
        post: async () => ({ status: "sent", deliveryId: "d1", to: { id: "B", name: "B" } }),
        dispose: async () => {},
        forgetBot: async (id) => {
          forgotten.push(id);
        },
        announceWaiting: async () => undefined,
      };
    },
  });

  await service.dispose();
  assert.equal(factories, 0);
  const refused = await service.post({
    fromBotId: "A",
    target: "B",
    message: "hello",
    deliveryId: "d1",
    runRequestIds: [undefined],
  });
  assert.equal(refused.status, "refused");
  assert.throws(() => service.forgetBot("A"), /shut down/u);
  assert.equal(factories, 0, "closed lifecycle must never construct the courier lazily");

  await service.start();
  await service.forgetBot("A");
  assert.equal(factories, 1);
  assert.deepEqual(forgotten, ["A"]);
  await service.dispose();
});
