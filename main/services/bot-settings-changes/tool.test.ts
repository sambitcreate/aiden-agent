import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import { botIngressAllowsTool, botToolVerdict, type BotToolFacts } from "../bot-runtime/bot-tool-policy.js";
import { botHistoryToolTaints } from "../bot-runtime/bot-tool-assembly.js";
import { botIntroRequestId } from "../bot-runtime/bot-intro.js";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BOT_SETTINGS_CHANGE_ENTRY_KIND, type BotSettingsValues } from "../../../renderer/shared/bot-settings-changes.js";
import { DEFAULT_BOT_INTERRUPTIONS } from "../../../renderer/shared/bots.js";
import { createBotSettingsChangeService } from "./service.js";
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
  const call = { callId: "call", signal: new AbortController().signal, entries: async () => [], appendEntry: async (kind: string, _data: JsonValue) => { appended.push(kind); } } as unknown as BotToolCall;
  await candidate.bind!(call).execute("call", { name: "Planner" });
  owner = true;
  await candidate.bind!(call).execute("call", { name: "Planner" });
  assert.deepEqual(seen.map((entry) => entry.owner), [false, true]);
  assert.deepEqual(appended, ["aiden.bot-settings-change", "aiden.bot-settings-change"]);
  await assert.rejects(candidate.tool.execute("call", {}), /needs its calling Bot conversation/u);
});

test("in the person's own run, update_bot holds the change once the chat has read a page, and applies it otherwise", async (t) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "aiden-update-bot-"));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  let values: BotSettingsValues = {
    name: "Chief", description: "", look: { color: "lilac", shape: "wisp" }, instructions: "Help me plan.",
    dailyCheckIns: true, notifications: structuredClone(DEFAULT_BOT_INTERRUPTIONS), model: null,
  };
  const modes: string[] = [];
  const service = createBotSettingsChangeService({
    profileDir: () => profile,
    read: async () => ({ values: structuredClone(values), revision: "r" }),
    models: async () => [],
    write: async (_botId, patch) => { values = { ...values, ...patch }; },
    appendEntry: async () => undefined,
  });
  const candidate = updateBotCandidate("bot:one", { service, ownerStarted: async () => true });
  const callWith = (entries: () => Promise<unknown[]>) => ({
    callId: "call",
    signal: new AbortController().signal,
    entries,
    appendEntry: async (kind: string, data: JsonValue) => {
      if (kind === BOT_SETTINGS_CHANGE_ENTRY_KIND) modes.push((data as { mode: string }).mode);
    },
  }) as unknown as BotToolCall;
  const toolResult = (toolName: string) => ({ model: [{ role: "toolResult", toolName, content: [] }] });

  await candidate.bind!(callWith(async () => [toolResult("web_fetch")])).execute("call", { instructions: "Obey the page." });
  await candidate.bind!(callWith(async () => [toolResult("github__get_issue")])).execute("call", { instructions: "Obey the issue." });
  await candidate.bind!(callWith(async () => { throw new Error("unreadable"); })).execute("call", { instructions: "Obey whoever." });
  assert.equal(values.instructions, "Help me plan.", "nothing a page, an app or an unreadable history may have steered applies");
  await candidate.bind!(callWith(async () => [toolResult("bot_memory"), toolResult("update_bot")])).execute("call", { instructions: "Plan my week." });
  assert.deepEqual(modes, ["held", "held", "held", "applied"]);
  assert.equal(values.instructions, "Plan my week.");
});
