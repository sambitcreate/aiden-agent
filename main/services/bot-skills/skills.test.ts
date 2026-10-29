import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { botSkillContentFingerprint, createBotSkillApprovals } from "../bot-skill-approvals.js";
import { resolveBotRuntimeSkillBindings } from "../bot-skill-inventory.js";
import { parseSkillMd } from "../skills-discovery.js";
import { writesIntoSkillDirectory } from "../bot-file-tool-router.js";
import type { DiscoveredSkill } from "../types.js";
import { botHomeSkillFile, createBotSkillProposalService } from "./proposals.js";
import { validateBotSkillProposal } from "./validate.js";
import { botSkillProposalOf } from "../../../renderer/shared/bot-skill-proposals.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-skills-"));
  roots.push(root);
  return root;
}

const KEY = new Uint8Array(32).fill(7);
const homeSkill: DiscoveredSkill = {
  id: "workspace:00:/home/.aiden/skills/meal-plan/SKILL.md",
  name: "meal-plan",
  description: "Use when planning the week's meals.",
  instructions: "List seven dinners.",
  source: "workspace",
  path: "/home/.aiden/skills/meal-plan/SKILL.md",
} as DiscoveredSkill;

function inventory(approvals: ReturnType<typeof createBotSkillApprovals>, unapproved: string[] = []) {
  return resolveBotRuntimeSkillBindings({
    loadIdentityKey: async () => KEY,
    listConfigured: async () => [],
    botId: "bot-a",
    loadBotHomePath: async () => "/home",
    discover: async (root) => (root ? [homeSkill] : []),
    isHomeSkillApproved: (_id, fingerprint) => approvals.isApproved("bot-a", fingerprint, fingerprint),
    onUnapprovedHomeSkills: (found) => unapproved.push(...found.map((skill) => skill.name)),
  });
}

test("an unapproved home skill is not admitted; approving its content admits it; a changed file is out again", async () => {
  const root = tempRoot();
  const approvals = createBotSkillApprovals({ profileDir: () => root });
  const unapproved: string[] = [];
  assert.deepEqual((await inventory(approvals, unapproved)).map((skill) => skill.label), []);
  assert.deepEqual(unapproved, ["meal-plan"], "a hand-placed skill is reported for review");
  const fingerprint = botSkillContentFingerprint(homeSkill);
  await approvals.approve("bot-a", fingerprint, fingerprint);
  assert.deepEqual((await inventory(approvals)).map((skill) => skill.label), ["meal-plan"]);
  homeSkill.instructions = "List seven dinners and a dessert.";
  assert.deepEqual((await inventory(approvals)).map((skill) => skill.label), [], "editing the file un-admits it");
  homeSkill.instructions = "List seven dinners.";
});

test("a Bot's file tools cannot write into a skill folder", async () => {
  const root = tempRoot();
  for (const target of [".aiden/skills/x/SKILL.md", ".aiden/skill/x/SKILL.md", ".claude/skills/x/SKILL.md", ".agents/x/SKILL.md", ".claude/Skills/x/SKILL.md", ".Agents/x/SKILL.md", ".AIDEN/skills/x/SKILL.md"]) {
    assert.equal(await writesIntoSkillDirectory(root, { path: target }), true, target);
  }
  assert.equal(await writesIntoSkillDirectory(root, { path: "notes/skills.md" }), false);
});

test("validator messages name the problem", () => {
  const sources = new Map<string, "configured" | "workspace" | "global">([["standup", "global"]]);
  const errors = (input: Partial<{ name: string; description: string; instructions: string }>) => {
    const result = validateBotSkillProposal({ name: "ok-name", description: "Use when x.", instructions: "Do y.", ...input }, { existingSources: sources });
    return result.ok ? [] : result.errors;
  };
  assert.match(errors({ name: "Bad Name" })[0]!, /lowercase letters, numbers and dashes/u);
  assert.match(errors({ name: "standup" })[0]!, /A global skill is already named “standup”, so this one would be hidden/u);
  assert.match(errors({ description: "" })[0]!, /say when to use this skill/u);
  assert.match(errors({ instructions: "x".repeat(17 * 1024) })[0]!, /Instructions are 17 KB; the limit is 16 KB/u);
});

test("a valid proposal round-trips through the skill loader", () => {
  const result = validateBotSkillProposal({ name: "meal-plan", description: "Use when planning   meals.", instructions: "Step one.\nStep two." }, { existingSources: new Map() });
  assert.ok(result.ok);
  const parsed = parseSkillMd(result.file);
  assert.equal(parsed?.frontmatter.name, "meal-plan");
  assert.equal(parsed?.frontmatter.description, "Use when planning meals.");
  assert.equal(parsed?.body, "Step one.\nStep two.");
});

function service(root: string, home: string) {
  const approvals = createBotSkillApprovals({ profileDir: () => root });
  const entries: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let invalidated = 0;
  let sequence = 0;
  const proposals = createBotSkillProposalService({
    profileDir: () => root,
    homePath: async () => home,
    approvals,
    existingSources: async () => new Map(),
    appendEntry: async (_botId, kind, data) => void entries.push({ kind, data }),
    invalidate: () => void (invalidated += 1),
    newId: () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`,
  });
  return { proposals, approvals, entries, invalidated: () => invalidated };
}

test("Add writes the file, approves that content, and a second pending proposal is refused", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const h = service(root, home);
  const first = await h.proposals.propose("bot-a", { name: "meal-plan", description: "Use when planning meals.", instructions: "List seven dinners.", reason: "You asked twice." });
  assert.ok(first.ok);
  assert.equal(h.entries[0]?.kind, "aiden.skill-proposal");
  const second = await h.proposals.propose("bot-a", { name: "other", description: "Use when x.", instructions: "y" });
  assert.equal(!second.ok && second.code, "too_many_pending");
  assert.deepEqual(await h.proposals.respond({ botId: "bot-a", proposalId: first.proposalId, decision: "add" }), { status: "added" });
  const written = readFileSync(botHomeSkillFile(home, "meal-plan"), "utf8");
  const parsed = parseSkillMd(written)!;
  const fingerprint = botSkillContentFingerprint({ name: parsed.frontmatter.name!, description: parsed.frontmatter.description!, instructions: parsed.body });
  assert.equal(await h.approvals.isApproved("bot-a", fingerprint, fingerprint), true, "the file as the loader reads it is approved");
  assert.equal(h.invalidated(), 1);
  assert.equal(h.entries[h.entries.length - 1]?.kind, "aiden.skill-proposal-status");
});

test("an update to a huge current skill shows every proposed line on its card", async () => {
  const home = tempRoot();
  const h = service(tempRoot(), home);
  const file = botHomeSkillFile(home, "meal-plan");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: meal-plan\ndescription: "Use when planning meals."\n---\n\n${"x".repeat(70_000)}\n`);
  const proposed = await h.proposals.propose("bot-a", { name: "meal-plan", description: "Use when planning meals.", instructions: "Only suggest vegetarian dinners." });
  assert.ok(proposed.ok);
  const card = botSkillProposalOf(h.entries[0]?.data);
  assert.ok(card);
  assert.equal(card.update, true);
  assert.ok(card.preview.includes("Only suggest vegetarian dinners."), "the instructions Add would approve are on the card");
});

test("a skill found in the folder becomes a review card; Use skill approves it without rewriting the file", async () => {
  const root = tempRoot();
  const home = tempRoot();
  const file = botHomeSkillFile(home, "meal-plan");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "hand written");
  const h = service(root, home);
  await h.proposals.reviewExisting("bot-a", homeSkill);
  await h.proposals.reviewExisting("bot-a", homeSkill);
  assert.equal(h.entries.length, 1, "one card per content");
  const proposalId = String(h.entries[0]!.data.proposalId);
  await h.proposals.respond({ botId: "bot-a", proposalId, decision: "add" });
  assert.equal(readFileSync(file, "utf8"), "hand written");
  const fingerprint = botSkillContentFingerprint(homeSkill);
  assert.equal(await h.approvals.isApproved("bot-a", fingerprint, fingerprint), true);
});
