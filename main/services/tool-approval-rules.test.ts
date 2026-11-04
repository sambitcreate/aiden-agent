import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DataStore } from "./data-store.js";
import { botApprovalRuleKey, botAlwaysAllowLabel, describeBotApprovalRule } from "../../renderer/shared/tool-approval-scope.js";
import {
  emptyToolApprovalRulesDocument,
  MAX_CHAT_TOOL_APPROVAL_RULES,
  MAX_PERSISTED_TOOL_APPROVAL_RULES,
  normalizeToolApprovalRulesDocument,
  ToolApprovalRuleBook,
  toolApprovalRuleTarget,
  TOOL_APPROVAL_RULES_MAX_BYTES,
  type ToolApprovalRulesDocument,
} from "./tool-approval-rules.js";

async function diskBook(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-approval-rules-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const open = () =>
    new DataStore<ToolApprovalRulesDocument>(
      "tool-approval-rules.json",
      emptyToolApprovalRulesDocument(),
      () => dir,
      { normalize: normalizeToolApprovalRulesDocument, reloadBeforeWrite: true, maxBytes: TOOL_APPROVAL_RULES_MAX_BYTES, fileMode: 0o600 },
    );
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  let ids = 0;
  const book = (store = open()) =>
    new ToolApprovalRuleBook(
      store,
      () => new Date((clock += 1_000)),
      () => `rule${++ids}`,
    );
  return { dir, file: path.join(dir, "tool-approval-rules.json"), open, book };
}

test("rule targets are exact and never wider than the approved call", () => {
  assert.deepEqual(toolApprovalRuleTarget("run_command", { command: "  npm test  " }, "ws1"), {
    toolName: "run_command",
    pattern: "npm test",
    workspaceId: "ws1",
  });
  assert.equal(
    toolApprovalRuleTarget("edit_file", { path: "./src//app.ts/" }, "ws1")?.pattern,
    "src/app.ts",
  );
  for (const unsafe of [
    "/etc/hosts",
    "~/notes.md",
    "../outside.txt",
    "src/../../x",
    "C:\\x.txt",
    ".",
  ]) {
    assert.equal(toolApprovalRuleTarget("write_file", { path: unsafe }, "ws1"), undefined, unsafe);
  }
  // Only the three parent workspace tools can be remembered, and only in a workspace.
  assert.equal(toolApprovalRuleTarget("read_file", { path: "a.txt" }, "ws1"), undefined);
  assert.equal(toolApprovalRuleTarget("run_command", { command: "ls" }, undefined), undefined);
  assert.equal(toolApprovalRuleTarget("run_command", { command: "a\u0000b" }, "ws1"), undefined);
  assert.equal(toolApprovalRuleTarget("run_command", { command: "   " }, "ws1"), undefined);
});

test("a chat rule matches only the same chat, tool, workspace and exact target", async (t) => {
  const { book } = await diskBook(t);
  const rules = book();
  const target = toolApprovalRuleTarget("run_command", { command: "npm test" }, "ws1")!;
  await rules.grant("chat", "chat-a", target);

  assert.equal(await rules.match("chat-a", target), "chat");
  assert.equal(await rules.match("chat-b", target), undefined);
  assert.equal(
    await rules.match(
      "chat-a",
      toolApprovalRuleTarget("run_command", { command: "npm test -- --watch" }, "ws1")!,
    ),
    undefined,
  );
  assert.equal(
    await rules.match(
      "chat-a",
      toolApprovalRuleTarget("run_command", { command: "npm test" }, "ws2")!,
    ),
    undefined,
  );
  // Chat rules are never persisted or listed in Settings.
  assert.deepEqual(await rules.list(), []);
  rules.forgetChat("chat-a");
  assert.equal(await rules.match("chat-a", target), undefined);
});

test("chat rules keep only the newest entries once the per-chat cap is reached", async (t) => {
  const { book } = await diskBook(t);
  const rules = book();
  const target = (n: number) =>
    toolApprovalRuleTarget("run_command", { command: `echo ${n}` }, "ws1")!;
  for (let n = 0; n <= MAX_CHAT_TOOL_APPROVAL_RULES; n += 1)
    await rules.grant("chat", "c", target(n));
  assert.equal(await rules.match("c", target(0)), undefined);
  assert.equal(await rules.match("c", target(1)), "chat");
  assert.equal(await rules.match("c", target(MAX_CHAT_TOOL_APPROVAL_RULES)), "chat");
});

test("always rules persist across restarts, apply to every chat, and revoke cleanly", async (t) => {
  const { book } = await diskBook(t);
  const first = book();
  const changes: number[] = [];
  first.onChange(() => changes.push(changes.length));
  const command = toolApprovalRuleTarget("run_command", { command: "npm run lint" }, "ws1")!;
  const file = toolApprovalRuleTarget("write_file", { path: "docs/notes.md" }, "ws1")!;
  await first.grant("always", "chat-a", command, "  Aiden  ");
  await first.grant("always", "chat-a", command, "Aiden");
  await first.grant("always", "chat-a", file);
  assert.equal(changes.length, 2, "a duplicate grant is not a change");

  const restarted = book();
  assert.equal(await restarted.match("another-chat", command), "always");
  assert.equal(
    await restarted.match("another-chat", { ...file, toolName: "edit_file" }),
    undefined,
    "a write_file rule does not authorize edit_file",
  );
  const listed = await restarted.list();
  assert.deepEqual(
    listed.map((rule) => [rule.toolName, rule.pattern, rule.workspaceLabel]),
    [
      ["write_file", "docs/notes.md", undefined],
      ["run_command", "npm run lint", "Aiden"],
    ],
  );

  assert.equal(await restarted.revoke(listed[1]!.id), true);
  assert.equal(await restarted.revoke(listed[1]!.id), false);
  assert.equal(await restarted.match("chat-a", command), undefined);
  assert.equal(await restarted.revokeAll(), 1);
  assert.deepEqual(await book().list(), []);
});

test("the persisted rule count is bounded", async (t) => {
  const { book, file } = await diskBook(t);
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      rules: Array.from({ length: MAX_PERSISTED_TOOL_APPROVAL_RULES + 5 }, (_, n) => ({
        id: `r${n}`,
        toolName: "run_command",
        pattern: `echo ${n}`,
        workspaceId: "ws1",
        createdAt: "2026-09-01T00:00:00.000Z",
      })),
    }),
  );
  const rules = book();
  assert.equal((await rules.list()).length, MAX_PERSISTED_TOOL_APPROVAL_RULES);
  await assert.rejects(
    rules.grant(
      "always",
      "c",
      toolApprovalRuleTarget("run_command", { command: "echo over" }, "ws1")!,
    ),
    /at most 200/u,
  );
  assert.equal((await rules.list()).length, MAX_PERSISTED_TOOL_APPROVAL_RULES);
});

test("hand-edited rules that widen or malform a pattern are ignored", async (t) => {
  const { book, file } = await diskBook(t);
  const createdAt = "2026-09-01T00:00:00.000Z";
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      rules: [
        { id: "ok", toolName: "run_command", pattern: "npm test", workspaceId: "ws1", createdAt },
        { id: "dup", toolName: "run_command", pattern: "npm test", workspaceId: "ws1", createdAt },
        {
          id: "padded",
          toolName: "run_command",
          pattern: " npm test ",
          workspaceId: "ws1",
          createdAt,
        },
        {
          id: "absolute",
          toolName: "write_file",
          pattern: "/etc/passwd",
          workspaceId: "ws1",
          createdAt,
        },
        {
          id: "dotdot",
          toolName: "edit_file",
          pattern: "a/../../b",
          workspaceId: "ws1",
          createdAt,
        },
        {
          id: "noncanonical",
          toolName: "edit_file",
          pattern: "./src/app.ts",
          workspaceId: "ws1",
          createdAt,
        },
        { id: "tool", toolName: "read_file", pattern: "a.txt", workspaceId: "ws1", createdAt },
        { id: "bad id!", toolName: "run_command", pattern: "ls", workspaceId: "ws1", createdAt },
        {
          id: "nodate",
          toolName: "run_command",
          pattern: "ls",
          workspaceId: "ws1",
          createdAt: "soon",
        },
      ],
    }),
  );
  const rules = book();
  assert.deepEqual(
    (await rules.list()).map((rule) => rule.id),
    ["ok"],
  );
  assert.equal(
    await rules.match("c", toolApprovalRuleTarget("write_file", { path: "etc/passwd" }, "ws1")!),
    undefined,
  );
  assert.deepEqual(
    normalizeToolApprovalRulesDocument({ version: 2, rules: [] }),
    emptyToolApprovalRulesDocument(),
  );
  assert.deepEqual(normalizeToolApprovalRulesDocument("nope"), emptyToolApprovalRulesDocument());
});

test("remembered file rules preserve leading and trailing path whitespace", async (t) => {
  const { book } = await diskBook(t);
  const rules = book();
  const target = (name: string) => toolApprovalRuleTarget("write_file", { path: name }, "ws1")!;
  await rules.grant("always", "chat-a", target(" notes.md"));
  assert.equal(await rules.match("chat-a", target(" notes.md")), "always");
  assert.equal(await rules.match("chat-a", target("notes.md")), undefined);
  assert.equal(await rules.match("chat-a", target("notes.md ")), undefined);
});

test("remembered rules reject parent segments and non-whitespace command controls", () => {
  for (const path of ["src/../notes.md", "src/../../notes.md", "../notes.md", "..\\outside.txt", "src\\..\\outside.txt", "src/..\\outside.txt"]) {
    assert.equal(toolApprovalRuleTarget("write_file", { path }, "ws1"), undefined);
  }
  for (const control of ["\u0000", "\u0007", "\u0008", "\u000b", "\u000c", "\u001b", "\u007f"]) {
    assert.equal(toolApprovalRuleTarget("run_command", { command: `echo${control}hello` }, "ws1"), undefined);
    assert.equal(toolApprovalRuleTarget("run_command", { command: `${control}echo hello` }, "ws1"), undefined);
  }
  assert.ok(toolApprovalRuleTarget("run_command", { command: "echo\thello\nprintf done" }, "ws1"));
});

const CAL = { kind: "connection", serverId: "gcal", tool: "create_event" } as const;
const BOT_DATE = "2026-11-04T12:00:00.000Z";

function memoryBotBook(initial: ToolApprovalRulesDocument = emptyToolApprovalRulesDocument()) {
  let document = structuredClone(initial);
  let tail = Promise.resolve();
  let ids = 0;
  let clock = BOT_DATE;
  const known = new Set(["bot:a", "bot:b", ...Array.from({ length: 21 }, (_, i) => `bot:${i}`)]);
  const store = {
    async load() { return structuredClone(document); },
    update<R>(mutation: (draft: ToolApprovalRulesDocument) => R | Promise<R>): Promise<R> {
      const work = tail.then(async () => {
        const draft = structuredClone(document);
        const result = await mutation(draft);
        document = draft;
        return result;
      });
      tail = work.then(() => {}, () => {});
      return work;
    },
  };
  const open = () => new ToolApprovalRuleBook(store, () => new Date(clock), () => `botrule${++ids}`, {
    knownBot: async (id: string) => known.has(id),
  });
  return { book: open(), open, store, known, setClock: (value: string) => { clock = value; } };
}

test("a Bot entry covers only its own Bot and exact target with independent public values", async () => {
  const { book } = memoryBotBook();
  const grant = await book.grantBot("bot:a", CAL, "  Google Calendar · Create event  ", "decision-1");
  assert.equal(grant.status, "published");
  assert.equal((await book.matchBot("bot:a", CAL))?.label, "Google Calendar · Create event");
  assert.equal(await book.matchBot("bot:b", CAL), undefined);
  assert.equal(await book.matchBot("bot:a", { ...CAL, tool: "delete_event" }), undefined);
  assert.equal(await book.matchBot("bot:a", { ...CAL, serverId: "other" }), undefined);
  const listed = await book.listBot();
  listed[0]!.target = { kind: "site", host: "evil.example", action: "click" };
  assert.equal((await book.matchBot("bot:a", CAL))?.target.kind, "connection");
});

test("distinct operations share one target, preserve creation, and cannot change their binding", async () => {
  const { book, store, setClock } = memoryBotBook();
  const changes: string[] = [];
  book.onBotChange((id) => changes.push(id));
  const first = await book.grantBot("bot:a", CAL, "Calendar", "d1");
  setClock("2026-11-05T12:00:00.000Z");
  assert.deepEqual(await book.grantBot("bot:a", CAL, "Changed label", "d2"), first);
  assert.equal((await book.listBot())[0]!.createdAt, BOT_DATE);
  assert.equal((await store.load()).botGrantOperations?.length, 2);
  assert.deepEqual(changes, ["bot:a", "bot:a"], "each fresh consent operation changes the Bot's consent revision");
  await book.grantBot("bot:a", CAL, "Changed label", "d2");
  assert.deepEqual(changes, ["bot:a", "bot:a"], "transport replay emits no new consent change");
  await assert.rejects(book.grantBot("bot:b", CAL, "Calendar", "d1"), /operation/u);
  await assert.rejects(book.grantBot("bot:a", { ...CAL, tool: "delete_event" }, "Calendar", "d1"), /operation/u);
});

test("Remove tombstones every publication, replay is inert after reopen, fresh decisions grant anew", async (t) => {
  const disk = await diskBook(t);
  const open = () => new ToolApprovalRuleBook(disk.open(), () => new Date(BOT_DATE), undefined, { knownBot: async () => true });
  const first = open();
  const published = await first.grantBot("bot:a", CAL, "Calendar", "d1");
  assert.equal(published.status, "published");
  await first.grantBot("bot:a", CAL, "Calendar", "d2");
  const id = (await first.listBot())[0]!.id;
  assert.equal(await open().revokeBot("bot:b", id), false);
  assert.equal(await open().revokeBot("bot:a", id), true);
  const reopened = open();
  const events: string[] = [];
  reopened.onBotChange((botId) => events.push(botId));
  assert.deepEqual(await reopened.grantBot("bot:a", CAL, "Calendar", "d1"), { status: "revoked" });
  assert.deepEqual(await reopened.grantBot("bot:a", CAL, "Calendar", "d2"), { status: "revoked" });
  assert.deepEqual(await reopened.listBot(), []);
  assert.deepEqual(events, [], "replayed revoked publication cannot release sibling cards through a change event");
  assert.equal((await reopened.grantBot("bot:a", CAL, "Calendar", "d3")).status, "published");
  assert.deepEqual(await open().grantBot("bot:a", CAL, "Calendar", "d1"), { status: "revoked" });
  const raw = JSON.parse(await fs.readFile(disk.file, "utf8"));
  assert.deepEqual(raw.botGrantOperations.map((r: { status: string }) => r.status), ["revoked", "revoked", "published"]);
});

test("Bot usage and changes are isolated from workspace rules and listeners", async () => {
  const { book, setClock } = memoryBotBook();
  const bots: string[] = [];
  let workspace = 0;
  book.onChange(() => { workspace++; });
  const unsubscribe = book.onBotChange((id) => bots.push(id));
  book.onBotChange(() => { throw new Error("broken observer"); });
  await book.grantBot("bot:a", CAL, "Calendar", "d1");
  const id = (await book.listBot())[0]!.id;
  setClock("2026-11-05T12:00:00.000Z");
  await book.recordBotUse("bot:a", id);
  await book.recordBotUse("bot:a", id);
  await book.recordBotUse("bot:b", id);
  await book.recordBotUse("bot:a", "missing");
  assert.deepEqual((await book.listBot()).map((r) => [r.uses, r.lastUsedAt]), [[2, "2026-11-05T12:00:00.000Z"]]);
  await book.grantBot("bot:a", { ...CAL, tool: "update_event" }, "Update", "d2");
  await book.grantBot("bot:b", CAL, "Calendar", "d3");
  assert.deepEqual(await book.list(), []);
  await book.grant("always", "chat", { toolName: "run_command", pattern: "npm test", workspaceId: "ws" });
  assert.equal((await book.list()).length, 1);
  assert.equal(await book.revoke(id), false);
  assert.equal(await book.revokeAll(), 1);
  assert.equal((await book.listBot()).length, 3);
  assert.equal(await book.forgetBot("bot:a"), 2);
  assert.deepEqual((await book.listBot()).map((r) => r.botId), ["bot:b"]);
  assert.deepEqual(await book.grantBot("bot:a", CAL, "Calendar", "d1"), { status: "revoked" });
  assert.equal(workspace, 2);
  assert.deepEqual(bots, ["bot:a", "bot:a", "bot:a", "bot:a", "bot:b", "bot:a"]);
  unsubscribe();
  await book.revokeBot("bot:b", (await book.listBot())[0]!.id);
  assert.equal(bots.length, 6);
});

test("Bot grants fail closed for unknown, deleted, missing validator, and deletion during validation", async () => {
  const { book, store, known } = memoryBotBook();
  await assert.rejects(book.grantBot("unknown", CAL, "Calendar", "d0"), /no longer exists/u);
  await assert.rejects(new ToolApprovalRuleBook(store).grantBot("bot:a", CAL, "Calendar", "d0"), /no longer exists/u);
  await book.grantBot("bot:a", CAL, "Calendar", "d1");
  known.delete("bot:a");
  assert.equal(await book.matchBot("bot:a", CAL), undefined);
  await assert.rejects(book.grantBot("bot:a", CAL, "Calendar", "d2"), /no longer exists/u);
  assert.equal(await book.forgetBot("bot:a"), 1);
  known.add("bot:a");
  await assert.rejects(book.grantBot("bot:a", CAL, "Calendar", "d3"), /no longer exists/u);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new ToolApprovalRuleBook(store, undefined, undefined, { knownBot: async () => {
    entered(); await new Promise<void>((resolve) => { release = resolve; }); return true;
  } });
  const pending = paused.grantBot("bot:b", CAL, "Calendar", "race");
  await ready;
  const forgotten = paused.forgetBot("bot:b");
  release();
  await assert.rejects(pending, /no longer exists/u);
  assert.equal(await forgotten, 0);
});

test("concurrent final slots enforce 50 per Bot and 1000 per profile atomically", async () => {
  const { book } = memoryBotBook();
  for (let i = 0; i < 49; i++) await book.grantBot("bot:a", { ...CAL, tool: `tool${i}` }, "Calendar", `a${i}`);
  const finalBot = await Promise.allSettled([50, 51].map((i) => book.grantBot("bot:a", { ...CAL, tool: `tool${i}` }, "Calendar", `a${i}`)));
  assert.equal(finalBot.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((finalBot.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /at most 50/u);
  await book.grantBot("bot:b", CAL, "Calendar", "b1");
  // Seed independently sized valid rows, then race the final profile slot.
  const seed = Array.from({ length: 999 }, (_, i) => ({ id: `r${i}`, botId: `bot:${Math.floor(i / 50)}`, target: { ...CAL, tool: `t${i}` }, label: "C", createdAt: BOT_DATE, uses: 0 }));
  const full = memoryBotBook({ version: 1, rules: [], botRules: seed }).book;
  const finalProfile = await Promise.allSettled(["bot:19", "bot:20"].map((id, i) => full.grantBot(id, { ...CAL, tool: "last" }, "C", `last${i}`)));
  assert.equal(finalProfile.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((finalProfile.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /1,000/u);
  assert.equal((await full.listBot()).length, 1000);
});

test("normalization drops malformed or duplicate Bot entries without canonicalizing authority", () => {
  const valid = { id: "r1", botId: "bot:a", target: { kind: "site", host: "amazon.com", action: "click" }, label: "Amazon", createdAt: BOT_DATE, uses: 0 };
  const normalized = normalizeToolApprovalRulesDocument({ version: 1, rules: [], botRules: [valid,
    { ...valid, id: "dup" },
    { ...valid, id: "badhost", target: { ...valid.target, host: "WWW.Amazon.com" } },
    { ...valid, id: "shell", target: { kind: "shell", command: "ls" } },
    { ...valid, id: "uses", uses: -1 },
    { ...valid, id: "label", label: " " },
  ] });
  assert.deepEqual(normalized.botRules, [valid]);
});

test("malformed receipt evidence blocks Bot publication across normalization and workspace writes", async () => {
  const evidence = [{ operationId: "d1", status: "nonsense" }];
  const normalized = normalizeToolApprovalRulesDocument({ version: 1, rules: [], botGrantOperations: evidence });
  const { book, store, open } = memoryBotBook(normalized);
  await assert.rejects(book.grantBot("bot:a", CAL, "Calendar", "d1"), /receipt/u);
  await book.grant("always", "chat", { toolName: "run_command", pattern: "npm test", workspaceId: "ws" });
  assert.equal((await book.list()).length, 1);
  assert.ok(JSON.stringify(await store.load()).includes("nonsense"), "retain malformed receipt evidence");
  await assert.rejects(open().grantBot("bot:a", CAL, "Calendar", "new"), /receipt/u);
});

test("unreadable disk receipts cannot reset replay authority through workspace writes", async (t) => {
  const { file, open, dir } = await diskBook(t);
  const evidence = '{"version":1,"botGrantOperations":[';
  await fs.writeFile(file, evidence);
  const storeBook = new ToolApprovalRuleBook(open(), undefined, undefined, { knownBot: async () => true });
  await assert.rejects(storeBook.grantBot("bot:a", CAL, "Calendar", "d1"), /receipt|no longer exists/u);
  await storeBook.grant("always", "chat", { toolName: "run_command", pattern: "npm test", workspaceId: "ws" });
  // Reopen the original disk store after the workspace save repaired its JSON.
  const recovered = new ToolApprovalRuleBook(open(), undefined, undefined, { knownBot: async () => true });
  await assert.rejects(recovered.grantBot("bot:a", CAL, "Calendar", "d1"), /receipt/u);
  assert.equal((await recovered.list()).length, 1);
  const preserved = await Promise.all((await fs.readdir(dir)).filter((name) => name !== "tool-approval-rules.json")
    .map((name) => fs.readFile(path.join(dir, name), "utf8")));
  assert.ok(preserved.includes(evidence), "DataStore preserves the original corrupt bytes");
});

test("byte admission reserves revocation space and never prunes retained receipts", async (t) => {
  const { book, store, open } = memoryBotBook();
  let accepted = 0;
  for (; accepted < 3000; accepted++) {
    try { await book.grantBot("bot:a", CAL, "Calendar", `decision-${accepted}-${"x".repeat(180)}`); }
    catch (error) { assert.match(String(error), /storage|receipt|space/u); break; }
  }
  assert.ok(accepted > 100 && accepted < 3000);
  const before = await store.load();
  assert.ok(Buffer.byteLength(JSON.stringify(before, null, 2) + "\n") <= TOOL_APPROVAL_RULES_MAX_BYTES);
  assert.equal(before.botGrantOperations?.length, accepted);
  assert.equal(await book.revokeBot("bot:a", (await book.listBot())[0]!.id), true);
  const after = await store.load();
  assert.ok(Buffer.byteLength(JSON.stringify(after, null, 2) + "\n") <= TOOL_APPROVAL_RULES_MAX_BYTES);
  assert.equal(after.botGrantOperations?.length, accepted);
  assert.deepEqual(await open().grantBot("bot:a", CAL, "Calendar", "decision-0-" + "x".repeat(180)), { status: "revoked" });
  const disk = await diskBook(t);
  await fs.writeFile(disk.file, JSON.stringify(after, null, 2) + "\n");
  assert.equal((await disk.book().listBot()).length, 0);
});


test("Bot target keys and descriptions use exact tuples and stable user-facing copy", async () => {
  assert.equal(botApprovalRuleKey(CAL), '["connection","gcal","create_event"]');
  assert.equal(botApprovalRuleKey({ kind: "site", host: "amazon.com", action: "click" }), '["site","amazon.com","click"]');
  assert.equal(describeBotApprovalRule({ target: CAL, label: "Google Calendar · Create event" }), "Google Calendar · Create event");
  assert.equal(describeBotApprovalRule({ target: { kind: "site", host: "amazon.com", action: "click" }, label: "ignored" }), "Click on amazon.com");
  assert.equal(describeBotApprovalRule({ target: { kind: "site", host: "amazon.com", action: "type" }, label: "ignored" }), "Type on amazon.com");
  assert.equal(describeBotApprovalRule({ target: { kind: "site", host: "amazon.com", action: "press" }, label: "ignored" }), "Press keys on amazon.com");
  assert.equal(botAlwaysAllowLabel("Jester"), "Always allow for Jester");
  const { book } = memoryBotBook();
  await book.grantBot("bot:a", { kind: "site", host: "amazon.com", action: "click" }, "Amazon", "site");
  assert.equal(await book.matchBot("bot:a", { kind: "site", host: "amazon.com", action: "type" }), undefined);
  assert.equal(await book.matchBot("bot:a", { kind: "site", host: "shop.amazon.com", action: "click" }), undefined);
  assert.equal(await book.matchBot("bot:a", { kind: "site", host: "WWW.Amazon.com", action: "click" }), undefined);
  await assert.rejects(book.grantBot("bot:a", { ...CAL, tool: "x\u0000y" }, "C", "bad"), /Invalid/u);
  await assert.rejects(book.grantBot("bot:a", { ...CAL, serverId: "x".repeat(257) }, "C", "bad"), /Invalid/u);
  await assert.rejects(book.grantBot("bot:a", CAL, " ", "empty"), /Invalid/u);
  await book.grantBot("bot:b", CAL, " x".repeat(201), "long");
  assert.equal((await book.listBot("bot:b"))[0]!.label.length, 200);
});

test("damaged publication receipts retain evidence and missing visible entries never republish", async () => {
  const { book, store } = memoryBotBook();
  await book.grantBot("bot:a", CAL, "Calendar", "d1");
  const original = await store.load();
  const missing = normalizeToolApprovalRulesDocument({ ...original, botRules: [] });
  assert.deepEqual(await memoryBotBook(missing).book.grantBot("bot:a", CAL, "Calendar", "d1"), { status: "revoked" });
  for (const receipt of [null, {}, [...original.botGrantOperations!, ...original.botGrantOperations!],
    [{ ...original.botGrantOperations![0], targetKey: '["site","WWW.Amazon.com","click"]' }]]) {
    const damaged = normalizeToolApprovalRulesDocument({ ...original, botGrantOperations: receipt });
    const reopened = memoryBotBook(damaged).book;
    await assert.rejects(reopened.grantBot("bot:a", CAL, "Calendar", "d1"), /receipt/u);
    await assert.rejects(reopened.matchBot("bot:a", CAL), /receipt/u);
  }
});

test("Bot consent revision changes for publication, Remove and fresh consent but remains stable on replay and reopen", async (t) => {
  const { open } = await diskBook(t);
  const reopen = () => new ToolApprovalRuleBook(open(), () => new Date(BOT_DATE), undefined, { knownBot: async (id) => id === "bot:a" });
  const first = reopen();
  const absent = await first.botConsentRevision("bot:a", CAL);
  assert.match(absent, /^[a-f0-9]{64}$/u);
  await first.grantBot("bot:a", CAL, "Calendar", "d1");
  const published = await first.botConsentRevision("bot:a", CAL);
  assert.notEqual(published, absent);
  await first.grantBot("bot:a", CAL, "Calendar", "d1");
  assert.equal(await first.botConsentRevision("bot:a", CAL), published);
  assert.equal(await reopen().botConsentRevision("bot:a", CAL), published);
  await first.revokeBot("bot:a", (await first.listBot())[0]!.id);
  const removed = await first.botConsentRevision("bot:a", CAL);
  assert.notEqual(removed, absent, "absence after Remove retains its revocation generation");
  assert.notEqual(removed, published);
  assert.deepEqual(await first.grantBot("bot:a", CAL, "Calendar", "d1"), { status: "revoked" });
  assert.equal(await reopen().botConsentRevision("bot:a", CAL), removed);
  const next = reopen();
  await next.grantBot("bot:a", CAL, "Calendar", "d2");
  const fresh = await next.botConsentRevision("bot:a", CAL);
  assert.notEqual(fresh, published);
  assert.notEqual(fresh, removed);
  assert.equal(await reopen().botConsentRevision("bot:a", CAL), fresh);
  await next.grantBot("bot:a", CAL, "Calendar", "d2");
  assert.equal(await next.botConsentRevision("bot:a", CAL), fresh);
});

test("Bot consent revision ignores usage, unrelated targets and Bots, and receipt array order", async () => {
  const { book, store, open } = memoryBotBook();
  await book.grantBot("bot:a", CAL, "Calendar", "d1");
  const revision = await book.botConsentRevision("bot:a", CAL);
  await book.recordBotUse("bot:a", (await book.listBot())[0]!.id);
  await book.recordBotUse("bot:a", (await book.listBot())[0]!.id);
  await book.grantBot("bot:a", { ...CAL, tool: "delete_event" }, "Delete", "d2");
  await book.grantBot("bot:b", CAL, "Calendar", "d3");
  await book.revokeBot("bot:b", (await book.listBot("bot:b"))[0]!.id);
  await book.revokeBot("bot:a", (await book.listBot("bot:a")).find((r) => r.target.kind === "connection" && r.target.tool === "delete_event")!.id);
  assert.equal(await book.botConsentRevision("bot:a", CAL), revision);
  const original = await store.load();
  await store.update((draft) => { draft.botGrantOperations!.reverse(); });
  assert.equal(await open().botConsentRevision("bot:a", CAL), revision);
  assert.equal((await book.listBot("bot:a"))[0]!.uses, 2, "usage changed without changing permission generation");
  assert.equal(original.botGrantOperations?.length, 3);
  await assert.rejects(book.botConsentRevision("unknown", CAL), /no longer exists/u);
  const damaged = memoryBotBook(normalizeToolApprovalRulesDocument({ version: 1, rules: [], botGrantOperations: null })).book;
  await assert.rejects(damaged.botConsentRevision("bot:a", CAL), /receipt/u);
});

test("quarantined receipt evidence does not consume workspace capacity twice", async () => {
  const operations = Array.from({ length: 1100 }, (_, i) => ({ operationId: `d${i}`, botId: "bot:a",
    targetKey: '["connection","gcal","create_event"]', ruleId: "r1", status: "revoked",
    publishedAt: BOT_DATE, revokedAt: BOT_DATE }));
  const raw = { version: 1, rules: [], botGrantOperations: [...operations, { operationId: "damaged", status: "bad" }] };
  assert.ok(Buffer.byteLength(JSON.stringify(raw, null, 2) + "\n") < 400_000);
  const normalized = normalizeToolApprovalRulesDocument(raw);
  const { book, store } = memoryBotBook(normalized);
  await book.grant("always", "chat", { toolName: "run_command", pattern: "npm test", workspaceId: "ws" });
  assert.equal((await book.list()).length, 1);
  const saved = await store.load();
  assert.ok(Buffer.byteLength(JSON.stringify(saved, null, 2) + "\n") < 400_000);
  await assert.rejects(book.grantBot("bot:a", CAL, "Calendar", "d0"), /receipt/u);
  assert.ok(JSON.stringify(saved).includes('"operationId":"d1099"'), "the valid prefix is retained as evidence");
});

test("first publication compares original consent inside the same draft after Remove wins", async (t) => {
  const disk = await diskBook(t);
  const rules = new ToolApprovalRuleBook(disk.open(), undefined, undefined, { knownBot: async () => true });
  await rules.grantBot("bot:a", CAL, "Calendar", "d1");
  const expectedConsentRevision = await rules.botConsentRevision("bot:a", CAL);
  const original = (await rules.listBot())[0]!;
  const changes: string[] = [];
  rules.onBotChange((id) => changes.push(id));
  const removed = rules.revokeBot("bot:a", original.id);
  let guards = 0;
  const pending = rules.grantBot("bot:a", CAL, "Calendar", "d2", { expectedConsentRevision,
    validatePublication: async () => { guards++; } });
  assert.equal(await removed, true);
  await assert.rejects(pending, /consent.*changed|stale/iu);
  assert.equal(guards, 0);
  assert.deepEqual(await rules.listBot(), []);
  assert.equal(await rules.botGrantOperation("bot:a", "d2"), undefined);
  assert.deepEqual(changes, ["bot:a"]);
});

test("publication wins its serial then Remove tombstones every exact operation", async (t) => {
  const disk = await diskBook(t);
  const rules = new ToolApprovalRuleBook(disk.open(), undefined, undefined, { knownBot: async () => true });
  await rules.grantBot("bot:a", CAL, "Calendar", "d1");
  const expectedConsentRevision = await rules.botConsentRevision("bot:a", CAL);
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = rules.grantBot("bot:a", CAL, "Calendar", "d2", { expectedConsentRevision,
    validatePublication: async () => { entered(); await gate; } });
  await Promise.race([ready, first.then(() => assert.fail("First publication must await its live guard"))]);
  const removed = rules.revokeBot("bot:a", (await rules.listBot())[0]!.id);
  release();
  assert.equal((await first).status, "published");
  assert.equal(await removed, true);
  assert.deepEqual(await rules.listBot(), []);
  assert.equal((await rules.botGrantOperation("bot:a", "d1"))?.status, "revoked");
  assert.equal((await rules.botGrantOperation("bot:a", "d2"))?.status, "revoked");
});

test("pure live guards can read real DataStore revision and match inside update without deadlock", async (t) => {
  const disk = await diskBook(t);
  const rules = new ToolApprovalRuleBook(disk.open(), undefined, undefined, { knownBot: async () => true });
  await rules.grantBot("bot:a", CAL, "Calendar", "d1");
  const expectedConsentRevision = await rules.botConsentRevision("bot:a", CAL);
  const bytes = await fs.readFile(disk.file, "utf8");
  let events = 0;
  rules.onBotChange(() => { events++; });
  await assert.rejects(rules.grantBot("bot:a", CAL, "Calendar", "stale-page", { expectedConsentRevision,
    validatePublication: async () => {
      assert.equal(await rules.botConsentRevision("bot:a", CAL), expectedConsentRevision);
      assert.equal((await rules.matchBot("bot:a", CAL))?.label, "Calendar");
      throw new Error("The full approval requirements changed.");
    } }), /requirements changed/u);
  assert.equal(events, 0);
  assert.equal(await fs.readFile(disk.file, "utf8"), bytes);
  for (const options of [{}, { expectedConsentRevision }, { validatePublication: async () => {} },
    { expectedConsentRevision: "bad", validatePublication: async () => {} }]) {
    await assert.rejects(rules.grantBot("bot:a", CAL, "Calendar", "missing-proof", options), /proof|revision|consent/iu);
  }
  const result = await rules.grantBot("bot:a", CAL, "Calendar", "live", { expectedConsentRevision,
    validatePublication: async () => {
      assert.equal(await rules.botConsentRevision("bot:a", CAL), expectedConsentRevision);
      assert.ok(await rules.matchBot("bot:a", CAL));
    } });
  assert.equal(result.status, "published");
  assert.equal(events, 1);
});

test("publication proof is captured before awaits and deletion during a held guard still wins", async () => {
  const { book, store } = memoryBotBook();
  const expectedConsentRevision = await book.botConsentRevision("bot:a", CAL);
  let guards = 0;
  const proof = { expectedConsentRevision, validatePublication: async () => { guards++; } };
  const pending = book.grantBot("bot:a", CAL, "Calendar", "d1", proof);
  proof.expectedConsentRevision = "f".repeat(64);
  proof.validatePublication = async () => { throw new Error("Mutated caller object"); };
  assert.equal((await pending).status, "published");
  assert.equal(guards, 1);
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const generation = await book.botConsentRevision("bot:b", CAL);
  const deleting = book.grantBot("bot:b", CAL, "Calendar", "d2", { expectedConsentRevision: generation,
    validatePublication: async () => { entered(); await gate; } });
  await Promise.race([ready, deleting.then(() => assert.fail("First publication must await its live guard"))]);
  const forgotten = book.forgetBot("bot:b");
  release();
  await assert.rejects(deleting, /no longer exists/u);
  assert.equal(await forgotten, 0);
  assert.equal((await store.load()).botGrantOperations?.some((r) => r.operationId === "d2"), false);
});

test("unknown write outcomes reconcile exact historical receipts without regrant or stale live guards", async (t) => {
  const disk = await diskBook(t);
  const store = disk.open();
  let uncertain = true;
  const ambiguous = {
    load: () => store.load(),
    loadedFromCorruptFile: () => store.loadedFromCorruptFile(),
    async update<R>(mutation: (draft: ToolApprovalRulesDocument) => R | Promise<R>): Promise<R> {
      const result = await store.update(mutation);
      if (uncertain) { uncertain = false; throw new Error("Unknown publication outcome"); }
      return result;
    },
  };
  const rules = new ToolApprovalRuleBook(ambiguous, undefined, undefined, { knownBot: async () => true });
  const expectedConsentRevision = await rules.botConsentRevision("bot:a", CAL);
  let guards = 0;
  await assert.rejects(rules.grantBot("bot:a", CAL, "Calendar", "d1", { expectedConsentRevision,
    validatePublication: async () => { guards++; } }), /Unknown publication outcome/u);
  const restarted = new ToolApprovalRuleBook(disk.open(), undefined, undefined, { knownBot: async () => true });
  const receipt = await restarted.botGrantOperation("bot:a", "d1");
  assert.equal(receipt?.status, "published");
  const staleGuard = async () => { guards++; throw new Error("Old live context is revoked"); };
  assert.equal((await restarted.grantBot("bot:a", CAL, "Renamed", "d1", {
    expectedConsentRevision: "f".repeat(64), validatePublication: staleGuard })).status, "published");
  assert.equal(guards, 1);
  receipt!.targetKey = '["site","evil.example","click"]';
  assert.equal((await restarted.botGrantOperation("bot:a", "d1"))?.targetKey, '["connection","gcal","create_event"]');
  await assert.rejects(restarted.botGrantOperation("bot:b", "d1"), /operation|identity/iu);
  assert.equal(await restarted.botGrantOperation("bot:a", "unknown"), undefined);
  await restarted.forgetBot("bot:a");
  const historical = new ToolApprovalRuleBook(disk.open());
  assert.equal((await historical.botGrantOperation("bot:a", "d1"))?.status, "revoked");
  assert.deepEqual(await historical.grantBot("bot:a", CAL, "Calendar", "d1", {
    expectedConsentRevision, validatePublication: staleGuard }), { status: "revoked" });
  assert.equal(guards, 1);
  assert.deepEqual(await historical.listBot(), []);
});

test("Stop or expiry during the final Bot lookup cannot publish from an earlier live validation", async (t) => {
  for (const reason of ["stopped", "expired"]) await t.test(reason, async (child) => {
    const disk = await diskBook(child);
    let identityReads = 0;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rules = new ToolApprovalRuleBook(disk.open(), undefined, undefined, { knownBot: async () => {
      identityReads++;
      // One read captures consent, then first-publication admission checks the
      // Bot initially and once more around its live proof.
      if (identityReads === 3) { enter(); await held; }
      return true;
    } });
    const expectedConsentRevision = await rules.botConsentRevision("bot:a", CAL);
    let live = true;
    let guards = 0;
    let changes = 0;
    rules.onBotChange(() => { changes++; });
    const pending = rules.grantBot("bot:a", CAL, "Calendar", `owner-${reason}`, { expectedConsentRevision,
      validatePublication: async () => {
        guards++;
        if (!live) throw new Error(`The approval owner ${reason}.`);
      } });
    await Promise.race([entered, pending.then(() => assert.fail("Publication completed before the held identity read"))]);
    // The owner stops, or its deadline expires, while the authoritative Bot
    // lookup is pending. The lookup still truthfully returns an existing Bot.
    live = false;
    release();
    await assert.rejects(pending, new RegExp(`owner ${reason}`, "u"));
    assert.equal(guards, 1, "the live proof runs once for this first-publication attempt");
    assert.equal(changes, 0);
    assert.equal(await rules.botGrantOperation("bot:a", `owner-${reason}`), undefined);
    assert.deepEqual(await rules.listBot(), []);
  });
});
