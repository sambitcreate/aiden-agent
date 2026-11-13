import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import { botIngressAllowsTool, botToolVerdict, type BotToolFacts } from "../bot-runtime/bot-tool-policy.js";
import { botHistoryToolTaints } from "../bot-runtime/bot-tool-assembly.js";
import { botIntroRequestId } from "../bot-runtime/bot-intro.js";
import { updateBotCandidate, updateBotOwnerStarted } from "./tool.js";

test("only a run the person alone started counts as theirs", () => {
  assert.equal(updateBotOwnerStarted(["desk-1"], ["desk-1"]), true);
  assert.equal(updateBotOwnerStarted(["desk-1"], undefined), true);
  for (const other of ["routine:r1:1", "tg:42", "wake:w1", "peer:x", botIntroRequestId("bot:one")]) {
    assert.equal(updateBotOwnerStarted([other], [other]), false, other);
    assert.equal(updateBotOwnerStarted(["desk-1"], ["desk-1", other]), false, `a ${other} input joined the run`);
  }
  assert.equal(updateBotOwnerStarted(undefined, ["desk-1"]), false, "a run with no known inputs is not the person's");
});

test("update_bot is offered on every turn but the self-intro, and never taints the chat", async () => {
  assert.equal(botIngressAllowsTool("update_bot", ["desk-1"]), true);
  assert.equal(botIngressAllowsTool("update_bot", ["routine:r1:1"]), true, "a routine may ask; its change is held");
  assert.equal(botIngressAllowsTool("update_bot", [botIntroRequestId("bot:one")]), false);
  assert.deepEqual(await botToolVerdict("update_bot", {} as BotToolFacts, { routine: true }), { allowed: true });
  assert.equal(botHistoryToolTaints("update_bot"), false);
});

test("the tool tells the service whether the person started the run, and writes through the calling chat", async () => {
  const seen: { owner: boolean; input: unknown }[] = [];
  const appended: string[] = [];
  let owner = false;
  const candidate = updateBotCandidate("bot:one", {
    service: {
      call: async (_botId, input, context) => {
        seen.push({ owner: context.owner, input });
        await context.append?.("aiden.bot-settings-change", { changeId: "c" });
        return "ok";
      },
    },
    ownerStarted: async () => owner,
  });
  const call = { callId: "call", signal: new AbortController().signal, appendEntry: async (kind: string, _data: JsonValue) => { appended.push(kind); } } as unknown as BotToolCall;
  await candidate.bind!(call).execute("call", { name: "Planner" });
  owner = true;
  await candidate.bind!(call).execute("call", { name: "Planner" });
  assert.deepEqual(seen.map((entry) => entry.owner), [false, true]);
  assert.deepEqual(appended, ["aiden.bot-settings-change", "aiden.bot-settings-change"]);
  await assert.rejects(candidate.tool.execute("call", {}), /needs its calling Bot conversation/u);
});
