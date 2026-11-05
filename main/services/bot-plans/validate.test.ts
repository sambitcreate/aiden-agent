import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { defaultBotRules } from "../../../renderer/shared/bot-rules.js";
import type { BotAccessAuthorization } from "../../../renderer/shared/bot-access-requests.js";
import { testAuthority, SEND_EMAIL_TOOL, READ_INBOX_TOOL, MAIL_SERVER } from "../bot-runtime/test-support/assembly-fixtures.js";
import type { BotPlanAccessPort } from "./ports.js";
import { validateBotPlanProposal, botPlanRuleFingerprint, botPlanProposalFingerprint, type BotPlanValidationContext } from "./validate.js";

const authorization: BotAccessAuthorization = { policyRevision: "p1", requestIds: ["req-1"], target: "folder", root: "/outside", identity: { device: "1", inode: "2" }, choices: ["not_now", "once"] };
function context(options: { browser?: boolean; shell?: boolean; access?: BotPlanAccessPort } = {}): BotPlanValidationContext {
  const authority = testAuthority({ mode: "custom", home: tmpdir(), connections: true, shell: options.shell, other: options.browser ? ["browser"] : [] });
  return { botId: "b", policyRevision: "p1", bindingRevision: "b1", rules: defaultBotRules(), access: options.access, facts: {
    authority, supportsImages: false, fileLocations: 0, hasComputer: false,
    mcpTools: async () => new Map([[SEND_EMAIL_TOOL, authority.connections[0]!.tools[0]!], [READ_INBOX_TOOL, authority.connections[0]!.tools[1]!]]),
    mcpToolDescriptor: async (name) => name === SEND_EMAIL_TOOL ? { name: "send_email", inputSchema: { type: "object" }, annotations: { title: "Send email", readOnlyHint: false } } : undefined,
    skillToolNames: async () => new Set(),
  } };
}
const input = (covers: unknown[]) => ({ title: "Prepare the week", why: "Keep things organized", steps: [{ text: "Arrange things" }], covers });
const connector = { connector: "Mail", action: "send updates", tools: [SEND_EMAIL_TOOL], max: 5 };
const access: BotPlanAccessPort = { scopeOf: async () => ({ kind: "outside", authorization }), allowOnce: async () => {}, revokePlan() {} };

test("mutating tool captures live server identity, descriptor title and cap", async () => {
  const result = await validateBotPlanProposal(input([connector]), context());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.proposal.items, [{ id: "i1", kind: "connector", app: "Mail", action: "send updates", max: 5, tools: [{ modelName: SEND_EMAIL_TOOL, serverId: MAIL_SERVER.id, remoteName: "send_email", title: "Send email" }] }]);
  assert.equal(result.proposal.authorization.proposalFingerprint, botPlanProposalFingerprint(result.proposal));
  assert.equal(Object.isFrozen(result.proposal.items[0]), true);
});

test("read-only and ungranted tools report each refusal without partial approval", async () => {
  const result = await validateBotPlanProposal(input([{ ...connector, tools: [READ_INBOX_TOOL, "missing__tool"] }]), context());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems.length, 2);
  assert.ok(result.problems[0]!.includes("doesn't need approval"));
});

test("locked, hand-off, unknown and Computer Use declarations are refused", async () => {
  const c = context();
  c.rules = c.rules.map((r) => r.id === "default.purchase" ? { ...r, behavior: "hand_off" } : r);
  const result = await validateBotPlanProposal(input([{ rule: "locked.money" }, { rule: "default.purchase" }, { rule: "absent" }, { ...connector, tools: ["computer_use"] }]), c);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.problems.length, 4); assert.ok(result.problems.some((p) => p.includes("always asks on its own card"))); }
  const allowed = await validateBotPlanProposal(input([{ rule: "make a purchase or booking" }]), context());
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.proposal.items[0]!.kind === "rule" && allowed.proposal.items[0].ruleId, "default.purchase");
});

test("outside folder captures immutable pinned authorization and only one is allowed", async () => {
  const result = await validateBotPlanProposal(input([{ files: "~/Taxes", action: "read" }]), context({ access }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.proposal.items, [{ id: "i1", kind: "files", path: "/outside", access: "read", grant: true }]);
    assert.deepEqual(result.proposal.authorization.folder, authorization);
    assert.notEqual(result.proposal.authorization.folder, authorization);
  }
  for (const c of [context(), context({ access: { ...access, scopeOf: async () => ({ kind: "outside" }) } })]) {
    assert.equal((await validateBotPlanProposal(input([{ files: "/outside", action: "write" }]), c)).ok, false);
  }
  assert.equal((await validateBotPlanProposal(input([{ files: "/outside", action: "write" }, { files: "/other", action: "read" }]), context({ access }))).ok, false);
  assert.equal((await validateBotPlanProposal(input([{ files: "/", action: "write" }]), context({ access }))).ok, false);
});

test("browser capability and shell are required, payment sites never qualify", async () => {
  assert.equal((await validateBotPlanProposal(input([{ site: "example.com", action: "browse" }]), context())).ok, false);
  const site = await validateBotPlanProposal(input([{ site: "https://Docs.Example.com/path:80", action: "browse" }, { shell: "bot_home" }]), context({ browser: true, shell: true }));
  assert.equal(site.ok, true);
  if (site.ok) assert.deepEqual(site.proposal.items, [{ id: "i1", kind: "site", host: "docs.example.com", max: 10 }, { id: "i2", kind: "shell" }]);
  for (const site of ["paypal.com", "localhost", "https://user:password@example.com"]) assert.equal((await validateBotPlanProposal(input([{ site, action: "browse" }]), context({ browser: true }))).ok, false);
  assert.equal((await validateBotPlanProposal(input([{ shell: "bot_home" }]), context())).ok, false);
});

test("invalid site hostnames are proposal problems before a task memo is saved", async () => {
  for (const site of ["my_site.example.com", `${"a".repeat(254)}.example.com`]) {
    const result = await validateBotPlanProposal(input([{ site, action: "browse" }]), context({ browser: true }));
    assert.equal(result.ok, false, site);
    if (!result.ok) assert.deepEqual(result.problems, [`${site} isn't a site hostname.`]);
  }
  const international = await validateBotPlanProposal(input([{ site: "https://bücher.example/", action: "browse" }]), context({ browser: true }));
  assert.equal(international.ok, true);
  if (international.ok) assert.deepEqual(international.proposal.items, [{ id: "i1", kind: "site", host: "xn--bcher-kva.example", max: 10 }]);
});

test("shape and bounds are strict, caps default and text is cleaned", async () => {
  for (const covers of [[{ ...connector, max: 26 }], [{ ...connector, max: 1.5 }], [{ ...connector, extra: true }], [{ shell: "other" }]]) {
    assert.equal((await validateBotPlanProposal(input(covers), context())).ok, false);
  }
  const { max: _max, ...uncapped } = connector;
  const result = await validateBotPlanProposal({ ...input([uncapped]), title: "  Prepare\n\u202ethe  week\u0000  " }, context());
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.proposal.title, "Prepare the week"); assert.equal(result.proposal.items[0]!.kind === "connector" && result.proposal.items[0].max, 10); }
  assert.equal((await validateBotPlanProposal({ ...input([connector]), untrusted: 1 }, context())).ok, false);
});

test("rule fingerprint binds normalized definition and behavior, proposal binds all captured authority", async () => {
  const r = { id: "custom.1", text: "Book a flight.", behavior: "ask" as const, locked: false };
  assert.equal(botPlanRuleFingerprint(r), botPlanRuleFingerprint({ ...r, text: "Book  a flight" }));
  assert.notEqual(botPlanRuleFingerprint(r), botPlanRuleFingerprint({ ...r, text: "Book a hotel" }));
  assert.notEqual(botPlanRuleFingerprint(r), botPlanRuleFingerprint({ ...r, behavior: "hand_off" }));
  const result = await validateBotPlanProposal(input([connector]), context());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(botPlanProposalFingerprint(result.proposal), botPlanProposalFingerprint({ ...result.proposal, authorization: { ...result.proposal.authorization, bindingRevision: "different" } }));
});
