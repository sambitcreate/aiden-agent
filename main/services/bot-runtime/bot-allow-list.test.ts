import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { emptyToolApprovalRulesDocument, ToolApprovalRuleBook, type ToolApprovalRuleStore } from "../tool-approval-rules.js";
import { BOT_APPROVAL_TALLIES_FILE, createBotApprovalTallies } from "./bot-approval-tallies.js";
import { createBotApprovals } from "./bot-approvals.js";
import { botApprovalNudgeHint, createBotAllowList, reconcileBotAllowListHistory } from "./bot-allow-list.js";
import { botSessionDirectory } from "../bot-routine-notes.js";
import type { BotApprovalSettlementInput } from "./bot-extension.js";

const CAL = { kind: "connection", serverId: "gcal", tool: "create_event" } as const;
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiden-allow-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-11-04T12:00:00Z"), document = emptyToolApprovalRulesDocument(), nextId = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const store: ToolApprovalRuleStore = { load: async () => structuredClone(document), update: mutation => {
    const result = tail.then(async () => { const draft = structuredClone(document), value = await mutation(draft); document = draft; return value; });
    tail = result.catch(() => {}); return result;
  } };
  const rules = new ToolApprovalRuleBook(store, () => new Date(now), () => `rule${++nextId}`, { knownBot: async () => true });
  const tallies = createBotApprovalTallies({ profileDir: () => dir, now: () => now });
  const approvals = createBotApprovals({ publish() {} });
  const logs: unknown[] = [];
  let name = "Google Calendar";
  let folders = [{ kind: "folder" as const, id: "folder_root_a", botId: "bot", what: "Folder · ~/Taxes", createdAt: new Date(now + 1_000).toISOString() }];
  const deps = { rules, tallies, approvals, botName: async () => "Jester", connectionName: async () => name,
    folderEntries: async (botId?: string) => folders.filter(row => !botId || row.botId === botId),
    revokeFolder: async (botId: string, sourceId: string) => { const before = folders.length; folders = folders.filter(row => row.botId !== botId || row.id !== `folder_${sourceId}`); return before !== folders.length; },
    log: (_message: string, error: unknown) => { logs.push(error); } };
  const service = createBotAllowList(deps);
  async function input(id: string, answer: BotApprovalSettlementInput["decision"]["answer"] = "allow", offered = false): Promise<BotApprovalSettlementInput> {
    const consentRevision = await rules.botConsentRevision("bot", CAL);
    return { botId: "bot", remember: { target: CAL, title: "Create event", ...(offered ? { offer: { count: 3 } } : {}) },
      requirements: { target: CAL, requirementsFingerprint: "requirements", consentRevision, authorizationFingerprint: `fp-${id}` },
      decision: { id, authorizationFingerprint: `fp-${id}`, answer, source: "person" } };
  }
  async function seed() { for (let i = 0; i < 3; i++) { now += 1_000; await service.settle(await input(`seed-${i}`)); } }
  return { dir, deps, service, rules, tallies, approvals, logs, input, seed, rename(value: string) { name = value; }, advance(ms: number) { now += ms; }, document: () => document };
}

test("service: three approvals offer Always, once assigns one durable weekly hint, and publication resets only its history", async t => {
  const f = await fixture(t); await f.seed();
  assert.deepEqual(await f.service.offer("bot", CAL), { count: 3 });
  const once = await f.input("fourth", "allow", true), result = await f.service.settle(once);
  assert.equal(result.hint, botApprovalNudgeHint({ label: "Google Calendar · Create event", count: 4, choice: "Always allow for Jester", place: "Allowed without asking on your profile" }));
  assert.deepEqual(await createBotAllowList(f.deps).settle(once), result);
  f.advance(86_400_000);
  assert.deepEqual(await f.service.settle(await f.input("next-day", "allow", true)), {});
  const always = await f.input("always", "allow_always", true);
  let guarded = 0;
  const saved = await f.service.settle(always, { validatePublication: async () => { guarded++; } });
  assert.equal(guarded, 1); assert.ok(saved.publication);
  assert.equal((await f.rules.listBot("bot"))[0]?.label, "Google Calendar · Create event");
  assert.equal(await f.service.offer("bot", CAL), undefined);
  await f.service.used("bot", saved.publication!.ruleId);
  assert.equal((await f.rules.listBot("bot"))[0]?.uses, 1);
});

test("service: Once and Deny replay use the original offer while keeping exact decision identity", async t => {
  const f = await fixture(t);
  for (const id of ["first", "second"]) await f.service.settle(await f.input(id));
  const third = await f.input("third");
  assert.deepEqual(await f.service.settle(third), {});
  third.remember.offer = await f.service.offer("bot", CAL);
  assert.deepEqual(third.remember.offer, { count: 3 });
  assert.deepEqual(await createBotAllowList(f.deps).settle(third), {});
  assert.deepEqual(await f.tallies.nudge("bot", CAL), { count: 3 });
  const deny = await f.input("denied", "deny", true);
  assert.deepEqual(await f.service.settle(deny), {});
  delete deny.remember.offer;
  assert.equal(await f.service.offer("bot", CAL), undefined);
  const ledgerPath = path.join(botSessionDirectory(f.dir, "bot"), BOT_APPROVAL_TALLIES_FILE);
  const beforeReplay = await readFile(ledgerPath, "utf8");
  assert.deepEqual(await createBotAllowList(f.deps).settle(deny), {});
  assert.equal(await readFile(ledgerPath, "utf8"), beforeReplay, "a recomputed no-offer denial replay does not recount or rewrite its receipt");
  for (const changed of [
    { ...deny, decision: { ...deny.decision, answer: "allow" as const } },
    { ...deny, decision: { ...deny.decision, source: "expiry" as const } },
    { ...deny, decision: { ...deny.decision, authorizationFingerprint: "other" } },
    { ...deny, remember: { ...deny.remember, target: { ...CAL, tool: "delete_event" } } },
  ]) await assert.rejects(f.service.settle(changed), /immutable identity/u);
});

test("service: a replay returns the original hint after app and title changes", async t => {
  const f = await fixture(t); await f.seed();
  const input = await f.input("hint-replay", "allow", true);
  const first = await f.service.settle(input);
  assert.match(first.hint!, /Google Calendar · Create event/u);
  f.rename("Changed app"); input.remember.title = "Changed title"; delete input.remember.offer;
  f.deps.connectionName = async () => { throw new Error("Replay must not read today's display metadata"); };
  f.advance(8 * 86_400_000);
  assert.deepEqual(await createBotAllowList(f.deps).settle(input), first);
});

for (const title of ["x".repeat(199) + " remainder", "https:// foo", "file:// /secret", "x".repeat(199) + "😀 tail", "bad\ud800 title\u202e\u0000"]) {
  test(`service: Always publishes a canonical sanitized title ${JSON.stringify(title.slice(-24))}`, async t => {
    const f = await fixture(t), input = await f.input("display", "allow_always", true);
    input.remember.title = title;
    const result = await f.service.settle(input, { validatePublication: async () => {} });
    assert.ok(result.publication);
    const saved = (await f.tallies.publication("bot", "display", "fp-display"))!;
    assert.ok(saved);
    for (const value of [saved.context.title, saved.context.label]) {
      assert.ok(value.length <= 200); assert.equal(value, value.trim());
      assert.doesNotMatch(value, /[\p{Cc}\p{Cf}]|(?:https?|file):\/\//iu);
      assert.ok([...value].every(character => { const cp = character.codePointAt(0)!; return cp < 0xd800 || cp > 0xdfff; }));
    }
    assert.equal((await f.rules.listBot("bot"))[0]?.label, saved.context.label);
  });
}

test("service: a failed publication keeps its immutable original context across rename and live retry", async t => {
  const f = await fixture(t); await f.seed();
  const input = await f.input("save", "allow_always", true);
  const grant = f.rules.grantBot.bind(f.rules); let fail = true;
  f.rules.grantBot = async (...args) => { if (fail) throw new Error("disk unavailable"); return grant(...args); };
  assert.deepEqual(await f.service.settle(input, { validatePublication: async () => {} }), {});
  assert.equal(f.logs.length, 1); assert.equal((await f.rules.listBot("bot")).length, 0);
  f.rename("Renamed Calendar"); input.remember.title = "Changed title";
  fail = false;
  const result = await createBotAllowList(f.deps).settle(input, { validatePublication: async () => {} });
  assert.ok(result.publication);
  assert.equal((await f.rules.listBot("bot"))[0]?.label, "Google Calendar · Create event");
  assert.equal((await f.tallies.publication("bot", "save", "fp-save"))?.context.title, "Create event");
});

test("service: publication guard refusal propagates and never writes consent", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.settle(await f.input("stale", "allow_always", true), { validatePublication: async () => { throw new Error("page changed"); } }), /page changed/u);
  assert.equal((await f.rules.listBot("bot")).length, 0);
  assert.equal(f.logs.length, 0);
});

test("service: no fresh grant without a live guard; startup acknowledges only known receipts and never regrants after Remove", async t => {
  const f = await fixture(t); const input = await f.input("pending", "allow_always", true);
  await f.service.settle(input); assert.equal((await f.rules.listBot("bot")).length, 0);
  await createBotAllowList(f.deps).reconcile("bot"); assert.equal((await f.rules.listBot("bot")).length, 0);
  await f.rules.grantBot("bot", CAL, "Google Calendar · Create event", input.decision.id);
  const entry = (await f.rules.listBot("bot"))[0]!; await f.rules.revokeBot("bot", entry.id);
  f.rename("Renamed"); await createBotAllowList(f.deps).reconcile("bot");
  assert.equal((await f.tallies.publication("bot", "pending", "fp-pending"))?.status, "revoked");
  assert.deepEqual(await f.service.settle(input), {});
  assert.equal((await f.rules.listBot("bot")).length, 0);
});

test("service: list/remove joins owned folders and rules newest first; folder rows do not become rule uses", async t => {
  const f = await fixture(t);
  await f.service.settle(await f.input("save", "allow_always", true), { validatePublication: async () => {} });
  const rows = await f.service.list("bot"); assert.deepEqual(rows.map(row => row.kind), ["folder", "rule"]);
  f.advance(2_000);
  const newer = await f.rules.grantBot("bot", { ...CAL, tool: "update_event" }, "Update event", "newer-rule");
  assert.equal(newer.status, "published");
  if (newer.status !== "published") throw new Error("Newer rule did not publish");
  assert.deepEqual((await f.service.list("bot")).map(row => row.id), [newer.rule.id, "folder_root_a", rows[1]!.id], "the combined list interleaves newer rules, folders and older rules");
  assert.equal(await f.service.remove("bot", newer.rule.id), true);
  assert.equal(await f.service.remove("other", "folder_root_a"), false);
  assert.equal(await f.service.remove("bot", "folder_root_a"), true);
  assert.deepEqual((await f.service.list("bot")).map(row => row.kind), ["rule"]);
  assert.equal(await f.service.remove("bot", rows[1]!.id), true);
});

test("service: folder Once/Not now history, hint and committed Always recovery retain exact decisions", async t => {
  const f = await fixture(t);
  const base = { botId: "bot", path: "/Users/p/Taxes", source: "person" as const, offered: false };
  for (let i = 0; i < 3; i++) await f.service.settleFolder({ ...base, decisionId: `folder-${i}`, authorizationFingerprint: `folder-fp-${i}`, answer: "once" });
  assert.deepEqual(await f.service.folderOffer("bot", base.path), { count: 3 });
  const fourth = { ...base, decisionId: "folder-4", authorizationFingerprint: "folder-fp-4", answer: "once" as const, offered: true };
  const result = await f.service.settleFolder(fourth);
  assert.match(result.hint!, /“Always for this folder”/u); assert.doesNotMatch(result.hint!, /Allowed without asking/u);
  assert.deepEqual(await f.service.settleFolder(fourth), result);
  await f.service.settleFolder({ ...base, decisionId: "folder-deny", authorizationFingerprint: "folder-fp-deny", answer: "not_now" });
  assert.equal(await f.service.folderOffer("bot", base.path), undefined);
  await f.service.settleFolder({ ...base, decisionId: "folder-save", authorizationFingerprint: "folder-fp-save", answer: "always" });
  assert.equal(await f.service.folderOffer("bot", base.path), undefined);
  await f.service.forgetBot("bot");
  assert.equal(await f.service.decision("bot", "folder-4", "folder-fp-4").catch(() => undefined), undefined);
});

test("service: committed publication with lost acknowledgement reconciles history, preserves later denial and never releases on replay", async t => {
  const f = await fixture(t); await f.seed();
  const input = await f.input("ambiguous", "allow_always", true);
  const grant = f.rules.grantBot.bind(f.rules);
  f.rules.grantBot = async (...args) => { await grant(...args); throw new Error("acknowledgement lost"); };
  assert.deepEqual(await f.service.settle(input, { validatePublication: async () => {} }), {});
  assert.equal((await f.rules.listBot("bot")).length, 1);
  assert.equal((await f.tallies.pendingPublications("bot")).length, 1);
  f.advance(1_000); await f.service.settle(await f.input("later-denial", "deny"));
  await createBotAllowList(f.deps).reconcile("bot");
  assert.equal((await f.tallies.pendingPublications("bot")).length, 0);
  assert.equal((await f.tallies.publication("bot", "ambiguous", "fp-ambiguous"))?.status, "published");
  await f.rules.revokeBot("bot", (await f.rules.listBot("bot"))[0]!.id);
  assert.deepEqual(await f.service.settle(input), {});
  assert.equal(await f.service.offer("bot", CAL), undefined);
  assert.equal((await f.rules.listBot("bot")).length, 0);
});

test("service: tally completion failure after publication preserves the human fallback and startup repair", async t => {
  const f = await fixture(t); const input = await f.input("completion-failed", "allow_always", true);
  const complete = f.tallies.completePublication.bind(f.tallies);
  f.tallies.completePublication = async () => { throw new Error("completion disk busy"); };
  assert.deepEqual(await f.service.settle(input, { validatePublication: async () => {} }), {});
  assert.equal(f.logs.length, 1); assert.equal((await f.rules.listBot("bot")).length, 1);
  f.tallies.completePublication = complete;
  await createBotAllowList(f.deps).reconcile("bot");
  assert.equal((await f.tallies.pendingPublications("bot")).length, 0);
});

test("service: startup isolates a corrupt Bot and completes other Bots' known history without publication", async t => {
  const f = await fixture(t), input = await f.input("startup", "allow_always", true);
  await f.service.settle(input); // Pending consent has no live guard and grants nothing.
  await f.rules.grantBot("bot", CAL, "Original action", input.decision.id);
  const corrupt = botSessionDirectory(f.dir, "corrupt");
  await mkdir(corrupt, { recursive: true });
  await writeFile(path.join(corrupt, BOT_APPROVAL_TALLIES_FILE), "not json");
  const failures: string[] = [];
  f.rules.grantBot = async () => { throw new Error("Startup must not grant access"); };
  await reconcileBotAllowListHistory(createBotAllowList(f.deps), ["corrupt", "bot", "folder-bot"], [{
    botId: "folder-bot", decisionId: "original-folder", path: "/Taxes", authorizationFingerprint: "folder-proof",
    offered: false, decidedAt: 1_000, answer: "always", source: "person",
  }], botId => { failures.push(botId); });
  assert.deepEqual(failures, ["corrupt"]);
  assert.equal((await f.tallies.publication("bot", "startup", "fp-startup"))?.status, "published");
  assert.equal((await f.tallies.decision("folder-bot", "original-folder", "folder-proof"))?.answer, "allow_always");
  assert.equal((await f.rules.listBot()).length, 1);
});

test("service: a legacy Always decision without its original publication context cannot create consent", async t => {
  const f = await fixture(t), input = await f.input("legacy", "allow_always", true);
  await f.tallies.record("bot", CAL, { ...input.decision, offered: true });
  let guards = 0;
  assert.deepEqual(await f.service.settle(input, { validatePublication: async () => { guards++; } }), {});
  assert.equal(guards, 0); assert.equal((await f.rules.listBot()).length, 0);
  assert.equal(f.logs.length, 1);
});

test("service: every eligible older sibling carries its target without an offer; unrelated and rejected probes stay waiting", async t => {
  const f = await fixture(t); const automatic: string[] = [];
  const waiting: Promise<unknown>[] = [];
  for (const id of ["older", "stale", "unrelated", "rule-ask"]) {
    const target = id === "unrelated" ? { ...CAL, tool: "delete_event" } : CAL;
    waiting.push(f.approvals.request({ botId: "bot", waitId: id, authorizationFingerprint: `old-${id}`, toolCallId: "provider-shared", toolName: "calendar", summary: id, signal: undefined,
      ...(id === "rule-ask" ? {} : { allowList: { target, requirementsFingerprint: `requirements-${id}`, consentRevision: "old" },
        prepareAllowListRelease: async release => {
          if (id === "stale") return undefined;
          assert.equal((await f.rules.matchBot("bot", CAL))?.id, release.ruleId);
          automatic.push(id);
          return { id: `new-${id}`, authorizationFingerprint: `new-fp-${id}`, answer: "allow" as const, source: "allow_list" as const };
        } }),
    }));
  }
  const result = await f.service.settle(await f.input("owner", "allow_always", true), { validatePublication: async () => {} });
  assert.ok(result.publication); assert.deepEqual(automatic, ["older"]);
  assert.deepEqual((await waiting[0]) as object, { id: "new-older", authorizationFingerprint: "new-fp-older", answer: "allow", source: "allow_list" });
  assert.deepEqual(f.approvals.pending().map(row => row.waitId), ["stale", "unrelated", "rule-ask"]);
  for (const prompt of f.approvals.pending()) f.approvals.decide(prompt.waitId, "deny");
  await Promise.all(waiting);
});

test("service: names and original titles are canonical bounded receipt text", async t => {
  const f = await fixture(t); f.rename("Calendar\u202e https://private.example/token " + "n".repeat(250));
  const input = await f.input("sanitized", "allow_always", true);
  input.remember.title = "Create\u0000 event file:///private/path " + "x".repeat(250);
  const result = await f.service.settle(input, { validatePublication: async () => {} });
  assert.ok(result.publication);
  const saved = await f.tallies.publication("bot", "sanitized", "fp-sanitized");
  assert.ok(saved); assert.ok(saved.context.label.length <= 200 && saved.context.title.length <= 200);
  assert.doesNotMatch(saved.context.label + saved.context.title, /[\p{Cc}\p{Cf}]|https?:\/\/|file:\/\//u);
});

test("service: rule limits suppress offers and concurrent final-slot publications admit just one", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 49; i++) await f.rules.grantBot("bot", { ...CAL, tool: `old_${i}` }, "Old action", `old-operation-${i}`);
  const inputs = await Promise.all(["a", "b"].map(async id => {
    const input = await f.input(id, "allow_always", true); const target = { ...CAL, tool: `last_${id}` };
    input.remember.target = target; input.requirements!.target = target;
    input.requirements!.consentRevision = await f.rules.botConsentRevision("bot", target); return input;
  }));
  const results = await Promise.all(inputs.map(input => f.service.settle(input, { validatePublication: async () => {} })));
  assert.equal(results.filter(result => result.publication).length, 1);
  assert.equal((await f.rules.listBot("bot")).length, 50);
  await f.seed(); assert.equal(await f.service.offer("bot", CAL), undefined);
  assert.equal(f.logs.length, 1);
  assert.equal((await f.service.list("bot")).filter(row => row.kind === "folder").length, 1);
});

test("service: expiry and automatic approvals never count as person consent or hint", async t => {
  const f = await fixture(t);
  for (const source of ["expiry", "allow_list"] as const) {
    for (let i = 0; i < 4; i++) {
      const input = await f.input(`${source}-${i}`, source === "expiry" ? "deny" : "allow", true); input.decision.source = source;
      assert.deepEqual(await f.service.settle(input), {});
    }
  }
  assert.equal(await f.service.offer("bot", CAL), undefined);
  assert.equal((await f.rules.listBot("bot")).length, 0);
});

test("service: the profile rule cap suppresses offers while folder rows stay visible", async t => {
  const f = await fixture(t); await f.seed();
  f.document().botRules = Array.from({ length: 1_000 }, (_, index) => ({ id: `r_${index}`, botId: `other_${index}`, target: CAL,
    label: "Action", uses: 0, createdAt: "2026-11-04T12:00:00.000Z" }));
  assert.equal(await f.service.offer("bot", CAL), undefined);
  assert.equal((await f.service.list()).length, 1_001);
});

async function liveService(t: import("node:test").TestContext, count = 1) {
  const f = await fixture(t);
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { Harness, MemoryStorage, ToolResultEntry } = await import("@earendil-works/pi-durable");
  const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { assemblyDeps, assemblyState, testAuthority, FULL_GRANTS } = await import("./test-support/assembly-fixtures.js");
  const { countingTool } = await import("./test-support/fixtures.js");
  const { createFauxModels, FAUX_MODEL_REF, waitFor } = await import("./test-support/faux.js");
  const { createBotRegistry } = await import("./bot-extension.js");
  const target = { kind: "site", host: "docs.example", action: "click" } as const;
  for (let index = 0; index < 3; index++) await f.tallies.record("bot", target, { id: `site-seed-${index}`, authorizationFingerprint: `site-fp-${index}`, source: "person", answer: "allow", offered: false });
  const state = assemblyState(testAuthority({ mode: "full", home: f.dir, ...FULL_GRANTS, other: [...FULL_GRANTS.other, "browser"] }));
  const tool = countingTool("browser_click");
  const mutable = { page: "page-1", rule: false };
  const deps = assemblyDeps(state, { candidates: () => [{ tool, replay: "unsafe" }], allowList: f.service,
    rules: () => mutable.rule ? [{ id: "custom.save", text: "save", behavior: "ask", locked: false }] : [],
    approvalFor: async () => ({ approval: { summary: "Save" }, action: { surface: "browser", tool: "browser_click", url: "https://docs.example/edit", field: { accessibleName: "Save" } },
      browserTarget: { workspaceId: "b", tabId: "t", url: "https://docs.example/edit", documentRevision: mutable.page, controlRevision: 0 } }),
  });
  const settled: BotApprovalSettlementInput[] = [];
  deps.requestApproval = async request => {
    deps.approvals.push(request);
    // Exercise an older eligible sibling that never offered Always.
    return f.approvals.request(deps.approvals.length === 2 ? { ...request, always: undefined } : request);
  };
  deps.settleApproval = async (input, context) => { settled.push(structuredClone(input)); return f.service.settle(input, context); };
  const faux = createFauxModels([fauxAssistantMessage(Array.from({ length: count }, (_, index) => fauxToolCall(tool.name, { text: `save-${index}` }, { id: `provider-${index}` })), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const registry = createBotRegistry("bot", deps); await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: faux.models, registry }, ctx); registry.attachHarness(harness);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  const submission = await root.submit({ type: "input", content: "Save", requestId: "person" }, ctx);
  const results = async () => (await root.context(ctx)).entries.filter(entry => entry.kind === ToolResultEntry.kind);
  return { ...f, ctx, target, deps, settled, tool, mutable, submission, results, waitFor };
}

test("service integration: own Always and an older no-offer sibling execute through real policy with one human publication", async t => {
  const f = await liveService(t, 2);
  await f.waitFor(() => f.approvals.pending().length === 2);
  const owner = f.approvals.pending().find(prompt => prompt.always)!;
  const older = f.approvals.pending().find(prompt => !prompt.always)!;
  assert.ok(older.allowList);
  f.approvals.decide(owner.waitId, "allow", "always");
  await f.submission.wait(f.ctx);
  assert.equal(f.tool.executions.length, 2);
  assert.equal(f.settled.filter(input => input.decision.source === "person").length, 1);
  assert.equal(f.settled.filter(input => input.decision.source === "allow_list").length, 1);
  assert.equal((await f.rules.listBot("bot"))[0]?.uses, 1, "only the sibling matched the new rule; its actual binding records one use");
  assert.equal(f.approvals.pending().length, 0);
});

test("service integration: a lost publication acknowledgement keeps execution fresh and leaves history repairable", async t => {
  const f = await liveService(t);
  await f.waitFor(() => f.approvals.pending().length === 1);
  const original = f.approvals.pending()[0]!, grant = f.rules.grantBot.bind(f.rules);
  f.rules.grantBot = async (...args) => { await grant(...args); throw new Error("publication acknowledgement lost"); };
  f.approvals.decide(original.waitId, "allow", "always");
  await f.submission.wait(f.ctx);
  assert.equal(f.tool.executions.length, 1);
  assert.equal(f.approvals.pending().length, 0);
  assert.equal((await f.tallies.pendingPublications("bot")).length, 1);
  await f.service.reconcile("bot");
  assert.equal((await f.tallies.pendingPublications("bot")).length, 0);
  assert.equal((await f.rules.listBot("bot")).length, 1);
});

for (const drift of ["page", "rules"] as const) {
  test(`service integration: late ${drift} drift at atomic first publication propagates the guard refusal and re-asks`, async t => {
    const f = await liveService(t);
    await f.waitFor(() => f.approvals.pending().length === 1);
    const original = f.approvals.pending()[0]!;
    const grant = f.rules.grantBot.bind(f.rules);
    f.rules.grantBot = async (...args) => { if (drift === "page") f.mutable.page = "page-2"; else f.mutable.rule = true; return grant(...args); };
    f.approvals.decide(original.waitId, "allow", "always");
    await f.waitFor(() => f.approvals.pending().length === 1);
    const current = f.approvals.pending()[0]!;
    assert.notEqual(current.waitId, original.waitId);
    f.approvals.decide(current.waitId, "deny"); await f.submission.wait(f.ctx);
    assert.equal((await f.rules.listBot("bot")).length, 0); assert.equal(f.tool.executions.length, 0);
    assert.equal(f.logs.length, 0, "a validation refusal is not swallowed as ordinary persistence I/O");
  });
}

test("service integration: Remove during own publication creates no entry, usage or sibling release", async t => {
  const f = await liveService(t);
  await f.waitFor(() => f.approvals.pending().length === 1);
  const original = f.approvals.pending()[0]!;
  const grant = f.rules.grantBot.bind(f.rules);
  f.rules.grantBot = async (...args) => { const saved = await grant(...args); if (saved.status === "published") await f.rules.revokeBot(args[0], saved.rule.id); return saved; };
  f.approvals.decide(original.waitId, "allow", "always");
  await f.waitFor(() => f.approvals.pending().length === 1);
  const current = f.approvals.pending()[0]!; assert.notEqual(current.waitId, original.waitId);
  f.approvals.decide(current.waitId, "deny"); await f.submission.wait(f.ctx);
  assert.equal((await f.rules.listBot("bot")).length, 0); assert.equal(f.tool.executions.length, 0);
  assert.equal((await f.tallies.publication("bot", original.waitId, original.authorizationFingerprint!))?.status, "revoked");
});

test("service: an invalid recovery receipt does not prevent a later valid receipt from settling", async t => {
  const f = await fixture(t);
  const base = { botId: "bot", offered: false, decidedAt: Date.parse("2026-11-04T12:00:00Z"), answer: "always" as const, source: "person" as const };
  await assert.rejects(f.service.reconcile("bot", [
    { ...base, decisionId: "invalid-path", authorizationFingerprint: "invalid-fp", path: "/bad\0folder" },
    { ...base, decisionId: "valid-path", authorizationFingerprint: "valid-fp", path: "/valid/folder" },
  ]), /tally class/u);
  assert.equal((await f.tallies.decision("bot", "valid-path", "valid-fp"))?.answer, "allow_always");
  assert.deepEqual((await f.rules.listBot("bot")), [], "historical recovery never creates authority");
});

for (const action of ["click", "type", "press"] as const) {
  test(`service: a long valid site ${action} settles offered Once and Always`, async t => {
    const f = await fixture(t);
    const host = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(20)}`;
    const target = { kind: "site" as const, host, action };
    const input = async (id: string, answer: BotApprovalSettlementInput["decision"]["answer"], offered = false): Promise<BotApprovalSettlementInput> => ({
      botId: "bot", remember: { target, title: host, ...(offered ? { offer: { count: 3 } } : {}) },
      requirements: { target, requirementsFingerprint: "site-req", consentRevision: await f.rules.botConsentRevision("bot", target), authorizationFingerprint: `fp-${id}` },
      decision: { id, authorizationFingerprint: `fp-${id}`, answer, source: "person" },
    });
    for (let i = 0; i < 3; i++) await f.service.settle(await input(`seed-${i}`, "allow"));
    assert.deepEqual(await f.service.offer("bot", target), { count: 3 });
    const once = await input("offered-once", "allow", true);
    assert.match((await f.service.settle(once)).hint!, /4 times/u);
    const result = await f.service.settle(await input("always", "allow_always", true), { validatePublication: async () => {} });
    assert.ok(result.publication);
    const [rule] = await f.rules.listBot("bot");
    assert.deepEqual(rule!.target, target, "display bounding never changes the enforced host or action");
    assert.ok(rule!.label.length <= 200);
  });
}


test("service: a Bot-message decision counts but leaves the weekly person hint available", async t => {
  const f = await fixture(t); await f.seed();
  const botTurn = { ...await f.input("bot-turn-fourth", "allow", true), hintEligible: false };
  assert.deepEqual(await f.service.settle(botTurn), {});
  assert.deepEqual(await f.service.offer("bot", CAL), { count: 4 });
  assert.deepEqual(await createBotAllowList(f.deps).settle(botTurn), {});
  const personTurn = { ...await f.input("person-fifth", "allow", true), hintEligible: true };
  const result = await f.service.settle(personTurn);
  assert.match(result.hint!, /5 times in the last 14 days/u);
  assert.deepEqual(await createBotAllowList(f.deps).settle(personTurn), result);
});
