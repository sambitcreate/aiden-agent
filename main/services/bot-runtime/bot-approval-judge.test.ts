// The Auto judge for Bots (plan §3.2): fails closed on every failure, keeps a
// verdict per effect only within one run, reads the Bot's job and the owner's
// request with arguments redacted, and counts each call's cost against the
// Bot's spending as "approval-judge" usage.

import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";

import { approvalJudgeAction } from "../approval-judge/judge.js";
import type { StoredProvider } from "../types.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import { createBotApprovalJudge, type BotApprovalJudgeDeps } from "./bot-approval-judge.js";
import type { BotApprovalJudgeInput } from "./bot-tool-assembly.js";

const provider: StoredProvider = {
  id: "openrouter",
  kind: "openai",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  models: ["judge-1"],
  needsKey: true,
  deployment: "hosted",
};
const model = { id: "judge-1", name: "Judge 1", api: "openai-completions", provider: "openrouter", cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<Api>;

function message(text: string, costUsd = 0, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 120, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 121, cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd } },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "upstream failed" } : {}),
    timestamp: 0,
  } as AssistantMessage;
}

type Reply = AssistantMessage | Error | "hang";

/** A Bot judge on a fake model that answers `replies` in turn, recording every prompt it was sent. */
function botJudge(replies: Reply[] | ((prompt: string) => Reply), options: {
  noModel?: true;
  counts?: boolean;
  job?: string | Error;
  timeoutMs?: number;
} = {}) {
  const prompts: string[] = [];
  const usage: UsageRequestRecord[] = [];
  const spent: Array<{ botId: string; requestIds: readonly (string | undefined)[]; usd: number }> = [];
  const streams: Pick<Models, "streamSimple"> = {
    streamSimple: ((_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }, opts: { signal?: AbortSignal }) => ({
      result: async () => {
        const user = context.messages.find((entry) => entry.role === "user")!.content as Array<{ text: string }>;
        const prompt = user[0]!.text;
        prompts.push(prompt);
        const reply = typeof replies === "function" ? replies(prompt) : replies.shift() ?? new Error("no reply left");
        if (reply === "hang") {
          return new Promise<AssistantMessage>((_resolve, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        if (reply instanceof Error) throw reply;
        return reply;
      },
    })) as unknown as Models["streamSimple"],
  };
  const deps: BotApprovalJudgeDeps = {
    job: async () => {
      if (options.job instanceof Error) throw options.job;
      return options.job ?? "Ada keeps Sam's calendar and answers his email.";
    },
    runtime: async () => (options.noModel ? undefined : { judge: { model, provider, streams }, countsSpend: async () => options.counts ?? true }),
    recordUsage: (record) => void usage.push(record),
    recordSpend: async (botId, requestIds, usd) => void spent.push({ botId, requestIds, usd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  return { judge: createBotApprovalJudge(deps), prompts, usage, spent };
}

function input(run: string, overrides: Partial<BotApprovalJudgeInput> = {}): BotApprovalJudgeInput {
  return {
    run,
    requestIds: ["req-1"],
    effect: "mail__send_email:sam",
    action: approvalJudgeAction("mail__send_email", { to: "sam@example.com", subject: "Notes" }, "Send an email"),
    request: "Email Sam today's notes",
    ...overrides,
  };
}

test("fails closed for Bots: no model, an error, a failed reply, a timeout or an unsure reply all defer", async () => {
  const cases: Array<[string, Parameters<typeof botJudge>[0], Parameters<typeof botJudge>[1]]> = [
    ["no model", [message("PASS")], { noModel: true }],
    ["the call throws", [new Error("offline")], {}],
    ["the reply is an error", [message("PASS", 0, "error")], {}],
    ["too slow", ["hang"], { timeoutMs: 20 }],
    ["unsure", [message("Probably fine, but sending is permanent.")], {}],
    ["empty", [message("")], {}],
    ["ASK", [message("ASK")], {}],
  ];
  for (const [name, replies, options] of cases) {
    const { judge } = botJudge(replies, options);
    assert.equal(await judge("bot-1", input("run-1"), undefined), "defer", name);
  }
  const { judge } = botJudge([message("PASS")]);
  assert.equal(await judge("bot-1", input("run-1"), undefined), "pass", "only an exact PASS passes");
});

test("a job that can't be read still judges, on the owner's request alone", async () => {
  const { judge, prompts } = botJudge([message("PASS")], { job: new Error("unreadable") });
  assert.equal(await judge("bot-1", input("run-1"), undefined), "pass");
  assert.doesNotMatch(prompts[0]!, /<bot_job>/u);
  assert.match(prompts[0]!, /<owner_request>\nEmail Sam today's notes/u);
});

test("the model reads the Bot's job and the owner's request, never a secret in the arguments", async () => {
  const { judge, prompts } = botJudge([message("PASS")]);
  const action = approvalJudgeAction("mail__send_email", { to: "sam@example.com", api_key: "sk-live-abcdef0123456789" }, "Send an email");
  await judge("bot-1", input("run-1", { action }), undefined);
  assert.match(prompts[0]!, /<bot_job>\nAda keeps Sam's calendar and answers his email\.\n<\/bot_job>/u);
  assert.match(prompts[0]!, /<owner_request>\nEmail Sam today's notes\n<\/owner_request>/u);
  assert.match(prompts[0]!, /sam@example\.com/u);
  assert.doesNotMatch(prompts[0]!, /sk-live/u);
});

test("a verdict is kept per effect within one run, and another run or Bot asks again", async () => {
  const { judge, prompts } = botJudge(() => message("PASS"));
  await judge("bot-1", input("run-1"), undefined);
  await judge("bot-1", input("run-1"), undefined);
  assert.equal(prompts.length, 1, "the same effect in the same run is answered from the run's cache");
  await judge("bot-1", input("run-1", { effect: "mail__send_email:alex" }), undefined);
  assert.equal(prompts.length, 2, "a different effect is judged");
  await judge("bot-1", input("run-2"), undefined);
  assert.equal(prompts.length, 3, "a new run starts with nothing kept");
  await judge("bot-2", input("run-1"), undefined);
  assert.equal(prompts.length, 4, "another Bot's run is its own");
});

test("a failure is not kept: the next call in the run asks the model again", async () => {
  const { judge, prompts } = botJudge([new Error("offline"), message("PASS")]);
  assert.equal(await judge("bot-1", input("run-1"), undefined), "defer");
  assert.equal(await judge("bot-1", input("run-1"), undefined), "pass");
  assert.equal(prompts.length, 2);
});

test("each judge call shows in usage as approval-judge, and a paid one counts against the Bot's spending", async () => {
  const paid = botJudge([message("PASS", 0.0004)]);
  assert.equal(await paid.judge("bot-1", input("run-1", { requestIds: ["routine:daily:fire-1"] }), undefined), "pass");
  assert.deepEqual(paid.spent, [{ botId: "bot-1", requestIds: ["routine:daily:fire-1"], usd: 0.0004 }]);
  assert.equal(paid.usage.length, 1);
  assert.equal(paid.usage[0]!.source, "approval-judge");
  assert.equal(paid.usage[0]!.costUsd, 0.0004);

  // A sign-in or a model on this Mac costs nothing toward the limit, but still shows in usage.
  const free = botJudge([message("PASS", 0.0004)], { counts: false });
  await free.judge("bot-1", input("run-1"), undefined);
  assert.deepEqual(free.spent, []);
  assert.equal(free.usage.length, 1);

  // A failed call is listed too, and spends nothing.
  const failed = botJudge([new Error("offline")]);
  await failed.judge("bot-1", input("run-1"), undefined);
  assert.deepEqual(failed.spent, []);
  assert.equal(failed.usage[0]?.source, "approval-judge");
  assert.equal(failed.usage[0]?.status, "failed");
});

// A replay set: recorded Bot actions, the owner's request and the reply a judge
// model gave. The fake model replays the reply through the real path.
const REPLAY: ReadonlyArray<{ name: string; tool: string; args: unknown; request: string; reply: string; expected: "pass" | "defer" }> = [
  { name: "reply to the email the owner asked about", tool: "mail__send_email", args: { to: "sam@example.com", subject: "Re: Friday" }, request: "Tell Sam I can do Friday", reply: "PASS", expected: "pass" },
  { name: "email someone the owner never mentioned", tool: "mail__send_email", args: { to: "everyone@example.com", subject: "Hi" }, request: "Summarize my inbox", reply: "ASK", expected: "defer" },
  { name: "create the event asked for", tool: "calendar__create_event", args: { title: "Dentist", start: "2026-11-20T09:00" }, request: "Put my dentist appointment on Nov 20 at 9", reply: "pass.", expected: "pass" },
  { name: "delete what nobody asked to remove", tool: "drive__delete_file", args: { id: "f-17" }, request: "Find my tax documents", reply: "ASK", expected: "defer" },
  { name: "a chatty reply", tool: "github__merge_pull_request", args: { number: 12 }, request: "Review PR 12", reply: "Merging looks fine to me.", expected: "defer" },
  { name: "a reply that only mentions PASS", tool: "slack__post_message", args: { channel: "#team" }, request: "Post the notes", reply: "Do not PASS", expected: "defer" },
];

test("replay: recorded Bot actions pass or show their card as the recorded reply says", async () => {
  for (const row of REPLAY) {
    const { judge, prompts } = botJudge([message(row.reply)]);
    const verdict = await judge("bot-1", input(`run-${row.name}`, {
      effect: `${row.tool}:${JSON.stringify(row.args)}`,
      action: approvalJudgeAction(row.tool, row.args, row.tool),
      request: row.request,
    }), undefined);
    assert.equal(verdict, row.expected, row.name);
    assert.equal(prompts.length, 1, row.name);
    assert.match(prompts[0]!, new RegExp(`Tool: ${row.tool}`, "u"), row.name);
  }
});
