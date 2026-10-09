import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { BOT_MEMORY_REVIEW_ENTRY_KIND } from "../../../renderer/shared/bot-memory.js";
import { createBotRegistry } from "../bot-runtime/bot-extension.js";
import { BOT_NOTICE_ENTRY_KIND } from "../bot-runtime/bot-session-service.js";
import { fakeMemoryAuthority, holdNextRead, recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL, FAUX_MODEL_REF, FAUX_PROVIDER, waitFor, type FauxModels } from "../bot-runtime/test-support/faux.js";
import { createBotMemoryReview, type BotMemoryReviewDeps } from "./review.js";
import { createBotMemoryService } from "./service.js";
import { createBotMemoryStore } from "./store.js";
import { botMemoryToolEntry } from "./tool.js";

const ctx = BACKGROUND_CONTEXT;
const BOT = "bot-1";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function isReviewRequest(messages: Message[]): boolean {
  return (getCurrentSystemPrompt(messages) ?? "").includes("long-term memory up to date");
}

function userText(messages: Message[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")))
    .join("\n");
}

/** Turn answers are plain; review requests are answered by `review` in order. */
function scripted(review: Array<(messages: Message[]) => ReturnType<typeof fauxAssistantMessage>>) {
  const reviewRequests: Message[][] = [];
  const step: FauxResponseStep = (context) => {
    if (!isReviewRequest(context.messages)) return fauxAssistantMessage("ok");
    reviewRequests.push(context.messages);
    const next = review.shift();
    if (next === undefined) throw new Error("unexpected review request");
    return next(context.messages);
  };
  return { steps: Array.from({ length: 60 }, () => step), reviewRequests };
}

async function setup(steps: FauxResponseStep[], overrides: Partial<BotMemoryReviewDeps> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-review-"));
  roots.push(root);
  const memoryDir = path.join(root, "bots", BOT, "memory");
  mkdirSync(path.join(root, "bots", BOT), { recursive: true });
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir: root }) });
  const fauxModels: FauxModels = createFauxModels(steps);
  const registry = createBotRegistry(BOT, { ...recordingDeps(), currentTools: async () => [botMemoryToolEntry(BOT, memory)] });
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const conversation = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  const errors: unknown[] = [];
  const authority = fakeMemoryAuthority();
  const review = createBotMemoryReview({
    memory,
    conversation: async () => conversation,
    isIdle: async () => true,
    admit: async () => ({
      ok: true,
      model: { models: fauxModels.models, model: fauxModels.models.getModel(FAUX_PROVIDER, FAUX_MODEL)! },
      lease: authority.lease,
    }),
    onError: (_botId, error) => errors.push(error),
    ...overrides,
  });
  let sequence = 0;
  const personTurns = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      await (await conversation.submit({ type: "input", content: `Person message ${sequence}` }, ctx)).wait(ctx);
    }
  };
  const routineTurn = async (label: string) => {
    sequence += 1;
    const requestId = `routine:task:${sequence}`;
    await conversation.submit({ type: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "routine", label, requestId } } }, ctx);
    await (await conversation.submit({ type: "input", content: `Routine prompt ${sequence}`, requestId }, ctx)).wait(ctx);
  };
  const introTurn = async () => {
    await conversation.submit({ type: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: { notice: "hidden_input", requestId: "intro:bot-1" } } }, ctx);
    await (await conversation.submit({ type: "input", content: "Introduce yourself.", requestId: "intro:bot-1" }, ctx)).wait(ctx);
  };
  return { harness, conversation, memory, review, fauxModels, errors, authority, personTurns, routineTurn, introTurn, userFile: path.join(memoryDir, "USER.md") };
}

async function markers(conversation: Conversation): Promise<unknown[]> {
  const page = await conversation.entries({}, 500, undefined, ctx);
  return [...page.items].reverse().filter((entry: EntryRecord) => entry.kind === BOT_MEMORY_REVIEW_ENTRY_KIND).map((entry) => entry.data);
}

const addFact = (content: string) => () =>
  fauxAssistantMessage([fauxToolCall("bot_memory", { target: "user", operations: [{ action: "add", content }] })], { stopReason: "toolUse" });
const nothing = () => fauxAssistantMessage("NOTHING");

test("nine person turns do not trigger a review; the tenth does", async () => {
  const script = scripted([addFact("Has two kids."), nothing]);
  const { harness, conversation, review, personTurns, userFile } = await setup(script.steps);
  try {
    await personTurns(9);
    assert.deepEqual(await review.runNow(BOT), { kind: "skipped", reason: "too_soon" });
    assert.equal(script.reviewRequests.length, 0);
    await personTurns(1);
    assert.deepEqual(await review.runNow(BOT), { kind: "reviewed", added: 1, targets: ["user"] });
    assert.match(userText(script.reviewRequests[0]!), /Person message 10/u);
    assert.equal(readFileSync(userFile, "utf8"), "Has two kids.");
    assert.deepEqual(await markers(conversation), [{ source: "review", added: 1, targets: ["user"] }]);
    assert.deepEqual(await review.runNow(BOT), { kind: "skipped", reason: "too_soon" }, "the marker resets the count");
  } finally {
    await harness.close(ctx);
  }
});

test("routine and self-intro inputs are not counted or reviewed", async () => {
  const script = scripted([nothing]);
  const { harness, review, personTurns, routineTurn, introTurn } = await setup(script.steps);
  try {
    await introTurn();
    await personTurns(8);
    await routineTurn("Morning brief");
    await routineTurn("Morning brief");
    await routineTurn("Evening wrap-up");
    assert.deepEqual(await review.runNow(BOT), { kind: "skipped", reason: "too_soon" });
    await personTurns(2);
    assert.equal((await review.runNow(BOT)).kind, "reviewed");
    const text = userText(script.reviewRequests[0]!);
    assert.doesNotMatch(text, /Routine prompt|Introduce yourself/u, "unattended inputs never reach the review");
  } finally {
    await harness.close(ctx);
  }
});

test("a save the Bot made in a turn resets the count", async () => {
  const turnSave = fauxAssistantMessage(
    [fauxToolCall("bot_memory", { target: "user", operations: [{ action: "add", content: "Lives in Pune." }] })],
    { stopReason: "toolUse" },
  );
  const steps: FauxResponseStep[] = [
    ...Array.from({ length: 9 }, () => fauxAssistantMessage("ok")),
    turnSave,
    fauxAssistantMessage("Saved."),
    fauxAssistantMessage("ok"),
  ];
  const { harness, review, personTurns } = await setup(steps);
  try {
    await personTurns(11);
    assert.deepEqual(await review.runNow(BOT), { kind: "skipped", reason: "too_soon" });
  } finally {
    await harness.close(ctx);
  }
});

test("the review can only add", async () => {
  const script = scripted([
    () =>
      fauxAssistantMessage(
        [fauxToolCall("bot_memory", { target: "user", operations: [{ action: "replace", match: "short answers", content: "Prefers long answers." }] })],
        { stopReason: "toolUse" },
      ),
    nothing,
  ]);
  const { harness, review, personTurns, userFile } = await setup(script.steps);
  mkdirSync(path.dirname(userFile), { recursive: true });
  writeFileSync(userFile, "Prefers short answers.");
  try {
    await personTurns(10);
    assert.deepEqual(await review.runNow(BOT), { kind: "reviewed", added: 0, targets: [] });
    const secondRound = JSON.stringify(script.reviewRequests[1]);
    assert.match(secondRound, /Only adding is allowed here/u, "the refusal is shown to the model");
    assert.equal(readFileSync(userFile, "utf8"), "Prefers short answers.", "nothing was rewritten");
  } finally {
    await harness.close(ctx);
  }
});

test("a failed review still writes a marker, so the next try waits another ten inputs", async () => {
  const script = scripted([
    () => {
      throw new Error("provider down");
    },
  ]);
  const { harness, conversation, review, personTurns, errors } = await setup(script.steps);
  try {
    await personTurns(10);
    assert.deepEqual(await review.runNow(BOT), { kind: "failed" });
    assert.equal(errors.length, 1, "logged once");
    assert.deepEqual(await markers(conversation), [{ source: "review", added: 0, targets: [], failed: true }]);
    assert.deepEqual(await review.runNow(BOT), { kind: "skipped", reason: "too_soon" });
    assert.equal(script.reviewRequests.length, 1);
  } finally {
    await harness.close(ctx);
  }
});

test("replies schedule one debounced review; a busy or modelless Bot is skipped", async () => {
  const script = scripted([nothing]);
  let idle = false;
  const { harness, conversation, review, personTurns } = await setup(script.steps, {
    delayMs: 20,
    isIdle: async () => idle,
  });
  try {
    await personTurns(10);
    assert.deepEqual(await review.runNow(BOT), { kind: "skipped", reason: "not_idle" });
    idle = true;
    review.afterReply(BOT);
    review.afterReply(BOT);
    review.afterReply(BOT);
    await waitFor(async () => (await markers(conversation)).length > 0, { what: "the review marker" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(script.reviewRequests.length, 1);
  } finally {
    await harness.close(ctx);
  }
});

test("access revoked while a review answer is pending stops its save and any further request", async () => {
  let revoke = () => {};
  const script = scripted([
    () => {
      // The grant changes while this answer is on its way.
      revoke();
      return addFact("Has two kids.")();
    },
    nothing,
  ]);
  const { harness, conversation, review, personTurns, userFile, authority } = await setup(script.steps);
  revoke = () => authority.revoke();
  try {
    await personTurns(10);
    assert.deepEqual(await review.runNow(BOT), { kind: "revoked", added: 0, targets: [] });
    assert.equal(script.reviewRequests.length, 1, "no request after the revocation");
    assert.equal(existsSync(userFile), false, "the pending answer is not saved");
    assert.deepEqual(await markers(conversation), [], "nothing was saved, so the next reply tries again");
    assert.equal(authority.counts.releases, 1, "the admission is released");
  } finally {
    await harness.close(ctx);
  }
});

test("access revoked while a save is inside the store never publishes it", async () => {
  let hold: ReturnType<typeof holdNextRead> | undefined;
  const script = scripted([
    () => {
      // The next memory read is the store's own, inside the queued apply.
      hold!.arm();
      return addFact("Has two kids.")();
    },
    nothing,
  ]);
  const { harness, conversation, review, personTurns, userFile, authority } = await setup(script.steps);
  hold = holdNextRead(path.dirname(userFile));
  try {
    await personTurns(10);
    const running = review.runNow(BOT);
    await hold.reached;
    authority.revoke();
    hold.resume();
    assert.deepEqual(await running, { kind: "revoked", added: 0, targets: [] });
    assert.equal(existsSync(userFile), false, "the save that was mid-read is not published");
    assert.deepEqual(await markers(conversation), [], "nothing was saved, so the next reply tries again");
    assert.equal(script.reviewRequests.length, 1, "no request after the revocation");
  } finally {
    hold.restore();
    await harness.close(ctx);
  }
});

test("access lost after a save stops the next review request", async () => {
  const script = scripted([addFact("Has two kids."), addFact("Lives in Pune.")]);
  let revoke = () => {};
  const { harness, conversation, review, personTurns, userFile, authority, memory } = await setup(script.steps, {
    memory: {
      view: (botId) => memory.view(botId),
      apply: async (...args) => {
        const result = await memory.apply(...args);
        revoke();
        return result;
      },
    },
  });
  revoke = () => authority.revoke();
  try {
    await personTurns(10);
    assert.deepEqual(await review.runNow(BOT), { kind: "revoked", added: 1, targets: ["user"] });
    assert.equal(script.reviewRequests.length, 1, "the second round is never requested");
    assert.equal(readFileSync(userFile, "utf8"), "Has two kids.");
    assert.deepEqual(await markers(conversation), [{ source: "review", added: 1, targets: ["user"] }], "what was saved is still shown");
  } finally {
    await harness.close(ctx);
  }
});

test("cancel stops a running review without a marker", async () => {
  let release: (() => void) | undefined;
  const steps: FauxResponseStep[] = [
    ...Array.from({ length: 10 }, () => fauxAssistantMessage("ok")),
    async (_context, options) =>
      new Promise((resolve) => {
        release = () => resolve(fauxAssistantMessage("NOTHING"));
        options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
      }),
  ];
  const { harness, conversation, review, personTurns } = await setup(steps);
  try {
    await personTurns(10);
    const running = review.runNow(BOT);
    await waitFor(() => release !== undefined, { what: "the review request" });
    review.cancel(BOT);
    assert.deepEqual(await running, { kind: "aborted" });
    assert.deepEqual(await markers(conversation), []);
  } finally {
    await harness.close(ctx);
  }
});
