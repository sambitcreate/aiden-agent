// Contract revision 61 (provisional): the shared fixture
// `protocol/aiden-remote/v1/fixtures/bot-ux-revision-61.json` is what the host
// serves, built here with the host's own serializers. iOS and Android decode
// the same file. Regenerate it with `AIDEN_WRITE_FIXTURES=1`.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { buildApprovalCard } from "../../renderer/shared/approval-card-model.ts";
import { BOT_STARTER_INSTRUCTIONS, BOT_TEMPLATE_STALE_MESSAGE } from "../../renderer/shared/bot-presets.ts";
import type { BotTranscriptEntry } from "../../renderer/shared/bot-live.ts";
import {
  AidenRemoteApprovalSettingsService,
  parseAidenRemoteApprovalRulePicker,
  parseAidenRemoteApprovalRulesView,
  type AidenRemoteApprovalSettingsPorts,
} from "./aiden-remote-approval-settings.ts";
import {
  AIDEN_REMOTE_BOT_SKILL_PREVIEW_MAX,
  botApprovalCardForAudience,
  botTemplateFields,
  parseAidenRemoteApprovalCard,
  parseAidenRemoteApprovalModeRequest,
  parseAidenRemoteApprovalModeView,
  parseAidenRemoteBotTemplateCreateRequest,
  parseAidenRemoteBotTemplateList,
  parseAidenRemoteBotUxEntry,
  projectBotUxEntry,
} from "./aiden-remote-bot-ux.ts";
import { AidenRemoteServiceError } from "./aiden-remote-errors.ts";
import {
  AIDEN_REMOTE_APPROVAL_CARD_CAPABILITIES,
  AIDEN_REMOTE_APPROVAL_SETTINGS_CAPABILITIES,
  AIDEN_REMOTE_BOT_SETTINGS_CHANGE_CAPABILITIES,
  AIDEN_REMOTE_BOT_SUGGESTION_CAPABILITIES,
  AIDEN_REMOTE_BOT_TEMPLATE_CAPABILITIES,
  AIDEN_REMOTE_BOT_UX_CONTRACT_REVISION,
  parseAidenRemoteBotCreateRequest,
  parseAidenRemoteBotSessionEntry,
  parseAidenRemotePhoneRunApproval,
  parseAidenRemotePhoneStreamApproval,
} from "./aiden-remote-protocol.ts";
import { hostRunWireEvent } from "./aiden-remote-host-runs.ts";
import { projectPhoneStreamApproval } from "./aiden-remote-streams.ts";
import { ApprovalRulesUnreadableError } from "./approval-rules/store.ts";
import type { ApprovalRulesView } from "../../renderer/shared/approval-rules.ts";

const FIXTURE = new URL("../../protocol/aiden-remote/v1/fixtures/bot-ux-revision-61.json", import.meta.url);
const AT = "2026-11-13T09:00:00.000Z";

const hook = (command: string) => ({ event: "PreToolUse", matcher: "run_command", command, timeoutSeconds: 30, async: false, failClosed: true, envAllow: [] });

const RULES_VIEW: ApprovalRulesView = {
  rows: [
    { ref: { source: "rule", id: "rule_fixture_01" }, group: "allow", title: "github.com", kind: "Site", scope: { kind: "mac" }, decisions: ["allow", "ask", "block"], createdAt: AT },
    { ref: { source: "rule", id: "rule_fixture_02" }, group: "block", title: "Send email", kind: "Tool", scope: { kind: "workspace", label: "Docs" }, decisions: ["allow", "ask", "block"] },
    { ref: { source: "rule", id: "rule_fixture_03" }, group: "ask", title: "When a Bot wants to post in public channels", kind: "When a Bot wants to", scope: { kind: "mac" }, decisions: ["ask", "block"], handOff: { on: true } },
    { ref: { source: "bot-allow", botId: "bot_fixture_01", entryId: "entry_fixture_01" }, group: "allow", title: "Google Calendar · Create event", kind: "Connector", scope: { kind: "bot", label: "Chief" }, legacy: true, decisions: [] },
    { ref: { source: "workspace-mac", workspaceId: "workspace_fixture_01", grant: "shell" }, group: "mac", title: "Run commands", kind: "Mac", scope: { kind: "workspace", label: "Site" }, decisions: [] },
  ],
};

/** Every revision-61 shape, produced by the functions the host serves with. */
function build() {
  const settingsHeld: BotTranscriptEntry = {
    id: "e1",
    type: "settings_change",
    change: {
      changeId: "change_fixture_held",
      mode: "held",
      fields: ["instructions"],
      lines: ["Instructions: 2 lines changed"],
      instructions: "Plan my meals.\nKeep it vegetarian.\nShop on Saturdays.",
      previousInstructions: "Plan my meals.\nKeep it vegetarian.",
      heldReason: "outside_content",
    },
    status: "pending",
  };
  const settingsApplied: BotTranscriptEntry = {
    id: "e2",
    type: "settings_change",
    change: { changeId: "change_fixture_applied", mode: "applied", fields: ["name"], lines: ["Name: Chief → Planner"] },
    status: "pending",
  };
  const skill: BotTranscriptEntry = {
    id: "e3",
    type: "skill_proposal",
    proposal: { proposalId: "8d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a61", name: "Weekly shop", description: "Build the Saturday shopping list.", reason: "You asked for this three weeks running.", origin: "bot", preview: "# Weekly shop\n\nList what the week's meals need.", update: false },
    status: "pending",
  };
  // A skill too long to show in full: the phone reads previewTruncated and adds it on the Mac.
  const longSkill: BotTranscriptEntry = {
    id: "e7",
    type: "skill_proposal",
    proposal: { proposalId: "6a1f3e2d-9c4b-4e8a-b1d2-7f0e5c3a9b61", name: "House rules", description: "Everything the house agreed on.", origin: "folder", preview: `# House rules\n\n${"Take turns with the dishes.\n".repeat(700)}`, update: false },
    status: "pending",
  };
  const lessonProposal: BotTranscriptEntry = { id: "e4", type: "lesson_proposal", lesson: { lessonId: "lesson_fixture_01", lesson: "Skip recipes with mushrooms.", routineName: "Weekly meal plan", runs: 3 }, status: "pending" };
  const lessonLearned: BotTranscriptEntry = { id: "e5", type: "lesson_learned", lesson: { lessonId: "lesson_fixture_02", lesson: "Prices in euros." }, status: "active" };
  const tidy: BotTranscriptEntry = { id: "e6", type: "memory_tidy", changeId: "learning_fixture_01" };
  const entries = [settingsHeld, settingsApplied, skill, lessonProposal, lessonLearned, tidy, longSkill]
    .map((entry, index) => projectBotUxEntry(entry, `entry_fixture_6${index}`, AT));

  const botApproval = buildApprovalCard({
    toolName: "web_fetch",
    summary: "Fetch https://example.com/menu",
    canAllow: true,
    scopes: ["always"],
    alwaysLabel: "Always allow this tool",
    notes: ["You’ve allowed this 4 times in the last 2 weeks."],
  });
  // The same approvals as a phone's own stream and a run it watches read them.
  const streamApproval = (approvalId: string, toolName: string, summary: string, scopes?: ("once" | "chat" | "always")[]) => projectPhoneStreamApproval({
    approvalId,
    streamId: "stream_fixture_61",
    chatId: "chat_fixture_61",
    summary,
    toolCallId: `call_${approvalId}`,
    toolName,
    expiresAt: AT,
    canAllow: true,
    ...(scopes ? { scopes } : {}),
  }, { card: true });
  const runApproval = (approvalId: string, sequence: number, toolName: string, summary: string, scopes?: string[]) => hostRunWireEvent({
    runId: "run_fixture_61",
    sequence,
    timestamp: AT,
    type: "approval_required",
    terminal: false,
    payload: { approvalId, summary, toolCallId: `call_${approvalId}`, toolName, canAllow: true, ...(scopes ? { scopes } : {}) },
  }, "chat_fixture_61", "phone-cards");
  return {
    contractRevision: AIDEN_REMOTE_BOT_UX_CONTRACT_REVISION,
    capabilities: [
      ...AIDEN_REMOTE_APPROVAL_CARD_CAPABILITIES,
      ...AIDEN_REMOTE_APPROVAL_SETTINGS_CAPABILITIES,
      ...AIDEN_REMOTE_BOT_SETTINGS_CHANGE_CAPABILITIES,
      ...AIDEN_REMOTE_BOT_SUGGESTION_CAPABILITIES,
      ...AIDEN_REMOTE_BOT_TEMPLATE_CAPABILITIES,
    ],
    approvalCards: {
      macCommand: buildApprovalCard({ toolName: "run_command", summary: "Run command: npm test -- --watch=false", canAllow: true, scopes: ["chat", "always"] }),
      hookProposal: buildApprovalCard({
        toolName: "hooks",
        summary: "Update hook",
        canAllow: true,
        details: { kind: "hook-proposal", action: "update", name: "Lint before commit", scopeLabel: "This workspace (site)", warnings: [], previous: hook("npm run lint"), digestPrefix: "abc123", ...hook("npm run lint -- --fix") },
      }),
      formFill: buildApprovalCard({
        toolName: "form_fill",
        summary: "Fill the checkout form",
        canAllow: true,
        details: { kind: "form-fill-batch", planId: "plan_fixture", sourceDocument: "address.txt", sourceHashPrefix: "abcd", targetApp: "Safari", targetTitle: "Checkout", rows: [{ order: 0, elementIndex: 3, label: "Name", value: "Ada Lovelace", sourceLabel: "Name", sourceLine: 1 }], skippedRows: [], fillCount: 1, reviewCount: 0 },
      }),
      allowOnMac: buildApprovalCard({ toolName: "computer_use", summary: "Click Send in Mail", canAllow: true }),
      botAlways: botApproval,
      botWithoutAllowed: botApprovalCardForAudience(botApproval, false),
    },
    streamApprovals: {
      complete: streamApproval("approval_fixture_61a", "run_command", "Run command: npm test", ["once", "chat"]),
      denyOnly: streamApproval("approval_fixture_61b", "computer_use", "Click Send in Mail"),
    },
    phoneRunApprovalEvents: {
      complete: runApproval("approval_fixture_61c", 2, "run_command", "Run command: git status", ["once", "chat"]),
      denyOnly: runApproval("approval_fixture_61d", 3, "computer_use", "Click Send in Mail"),
    },
    botSessionEntries: entries,
    templates: parseAidenRemoteBotTemplateList({
      presets: [{
        id: "meal-planner",
        name: "Meal planner",
        subtitle: "Plans the week's meals",
        avatar: { version: 1, shape: "hex", color: "periwinkle" },
        suggestedConnections: [],
        suggestedRoutine: { name: "Weekly meal plan", label: "Every Sunday at 9:00 AM" },
        ...botTemplateFields({ version: 2, instructions: "Plan the week's meals around what I like.", sample: ["What should we eat this week?", "Here's a plan for seven dinners."] }, "bot:00000000-0000-4000-8000-000000000061"),
      }],
    }),
    approvalMode: parseAidenRemoteApprovalModeView({ mode: "ask", autoAvailable: true }),
    approvalRules: parseAidenRemoteApprovalRulesView(RULES_VIEW),
    approvalRulePicker: parseAidenRemoteApprovalRulePicker({
      options: [
        { target: { kind: "tool", tool: "send_email" }, label: "Send email", group: "Aiden" },
        { target: { kind: "connector", serverId: "calendar" }, label: "Calendar", group: "Connected apps", description: "Every tool of this app" },
      ],
    }),
    requests: {
      settingsChangeRespond: { decision: "apply" },
      skillProposalRespond: { decision: "add" },
      lessonRespond: { decision: "keep" },
      lessonRemove: {},
      learningUndo: {},
      templateCreate: { presetId: "meal-planner", version: 2 },
      oneFieldCreate: { name: "Scout", avatar: { version: 1, shape: "hex", color: "periwinkle" } },
      approvalMode: { mode: "never" },
      ruleAdd: { target: { kind: "site", host: "github.com" }, decision: "allow" },
      ruleChange: { ref: { source: "rule", id: "rule_fixture_02" }, decision: "ask" },
      ruleRemove: { ref: { source: "rule", id: "rule_fixture_01" } },
    },
    errors: {
      templateStale: { error: { code: "revision_conflict", message: BOT_TEMPLATE_STALE_MESSAGE, retryable: false } },
    },
  };
}

test("the shared revision-61 fixture is exactly what the host's serializers produce", () => {
  const built = JSON.parse(JSON.stringify(build()));
  if (process.env.AIDEN_WRITE_FIXTURES === "1") writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), built);
});

test("every fixture shape round-trips through the strict parsers clients mirror", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  for (const card of Object.values(fixture.approvalCards)) assert.deepEqual(parseAidenRemoteApprovalCard(card), card);
  for (const approval of Object.values(fixture.streamApprovals)) assert.deepEqual(parseAidenRemotePhoneStreamApproval(approval), approval);
  for (const event of Object.values(fixture.phoneRunApprovalEvents) as Array<{ type: string; payload: unknown }>) {
    assert.equal(event.type, "approval_required");
    assert.deepEqual(parseAidenRemotePhoneRunApproval(event.payload), event.payload);
  }
  // canAllow is the card's answer: a Deny-only card leaves canAllow false and offers no scopes.
  for (const pair of [fixture.streamApprovals, { complete: fixture.phoneRunApprovalEvents.complete.payload, denyOnly: fixture.phoneRunApprovalEvents.denyOnly.payload }]) {
    assert.equal(pair.complete.canAllow, true);
    assert.deepEqual(pair.complete.scopes, ["once", "chat"]);
    assert.equal(pair.denyOnly.canAllow, false);
    assert.equal(pair.denyOnly.scopes, undefined);
    assert.equal(pair.denyOnly.card.allowOnMac, "Allow it on your Mac.");
  }
  for (const entry of fixture.botSessionEntries) {
    assert.deepEqual(parseAidenRemoteBotUxEntry(entry), entry);
    assert.deepEqual(parseAidenRemoteBotSessionEntry(entry), entry, "the session parser accepts the new entries");
  }
  assert.deepEqual(parseAidenRemoteBotTemplateList(fixture.templates), fixture.templates);
  assert.deepEqual(parseAidenRemoteApprovalRulesView(fixture.approvalRules), fixture.approvalRules);
  assert.deepEqual(parseAidenRemoteBotTemplateCreateRequest(fixture.requests.templateCreate), fixture.requests.templateCreate);
  assert.equal(parseAidenRemoteApprovalModeRequest(fixture.requests.approvalMode), "never");
  // One-field create decodes through the real Bot create parser: no purpose, the starter instructions.
  const oneField = parseAidenRemoteBotCreateRequest(fixture.requests.oneFieldCreate);
  assert.equal(oneField.name, "Scout");
  assert.equal(oneField.purpose, "");
  assert.equal(oneField.instructions, BOT_STARTER_INSTRUCTIONS);
  assert.deepEqual(oneField.avatar, fixture.requests.oneFieldCreate.avatar);

  const held = fixture.botSessionEntries[0];
  assert.equal(held.mode, "held");
  assert.equal(held.instructions.endsWith("Shop on Saturdays."), true, "the card carries the full proposed text");
  assert.equal(held.previousInstructions, "Plan my meals.\nKeep it vegetarian.");
  assert.ok(held.instructionsDiff.some((line: { kind: string }) => line.kind !== "same"), "and a diff against the current text");
  const skills = fixture.botSessionEntries.filter((entry: { type: string }) => entry.type === "skill_proposal");
  assert.deepEqual(skills.map((entry: { previewTruncated?: boolean }) => entry.previewTruncated === true), [false, true]);
  assert.equal([...skills[1].preview].length, AIDEN_REMOTE_BOT_SKILL_PREVIEW_MAX);
  assert.deepEqual(fixture.approvalCards.botWithoutAllowed.buttons.map((button: { label: string }) => button.label), ["Deny", "Allow once"]);
});

test("the parsers refuse what a client must not trust", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const denyOnly = fixture.streamApprovals.denyOnly;
  assert.throws(() => parseAidenRemotePhoneStreamApproval({ ...denyOnly, canAllow: true }), "canAllow must match the card");
  assert.throws(() => parseAidenRemotePhoneStreamApproval({ ...fixture.streamApprovals.complete, scopes: ["once", "always"] }), "a scope the card does not offer");
  assert.throws(() => parseAidenRemotePhoneRunApproval({ ...fixture.phoneRunApprovalEvents.complete.payload, card: { ...denyOnly.card, extra: true } }));
  const card = fixture.approvalCards.macCommand;
  assert.throws(() => parseAidenRemoteApprovalCard({ ...card, extra: true }));
  assert.throws(() => parseAidenRemoteApprovalCard({ ...card, buttons: [...card.buttons].reverse() }), "Deny comes first");
  assert.throws(() => parseAidenRemoteApprovalCard({ ...card, allowOnMac: "Allow it on your Mac." }), "allowOnMac only on a deny-only card");
  assert.throws(() => parseAidenRemoteApprovalCard({ ...fixture.approvalCards.allowOnMac, allowOnMac: undefined }));
  assert.throws(() => parseAidenRemoteBotUxEntry({ ...fixture.botSessionEntries[0], status: "approved" }));
  assert.throws(() => parseAidenRemoteBotTemplateCreateRequest({ presetId: "meal-planner", version: 0 }));
  assert.throws(() => parseAidenRemoteApprovalRulesView({ rows: [{ ...RULES_VIEW.rows[0], group: "maybe" }] }));
  assert.throws(() => parseAidenRemoteApprovalModeRequest({ mode: "always" }));
});

function settingsPorts(overrides: Partial<AidenRemoteApprovalSettingsPorts["rules"]> & { autoAvailable?: boolean; view?: ApprovalRulesView } = {}) {
  const writes: unknown[] = [];
  const ports: AidenRemoteApprovalSettingsPorts = {
    readMode: async () => ({ mode: "ask", autoAvailable: overrides.autoAvailable ?? true }),
    writeMode: async (mode) => { writes.push(["mode", mode]); },
    rules: {
      list: async () => overrides.view ?? RULES_VIEW,
      picker: async () => [],
      add: overrides.add ?? (async (input) => { writes.push(["add", input]); return {}; }),
      change: overrides.change ?? (async (input) => { writes.push(["change", input]); return { changed: true }; }),
      remove: overrides.remove ?? (async (ref) => { writes.push(["remove", ref]); return { removed: true }; }),
    },
  };
  return { service: new AidenRemoteApprovalSettingsService(ports), writes };
}

const isError = (code: string, status: number) => (error: unknown) => error instanceof AidenRemoteServiceError && error.code === code && error.status === status;

test("approval settings: Auto needs a model, malformed input is refused before any write", async () => {
  const noModel = settingsPorts({ autoAvailable: false });
  await assert.rejects(noModel.service.setMode({ mode: "auto" }), isError("invalid_request", 400));
  await assert.rejects(noModel.service.setMode({ mode: "never", extra: 1 }), isError("invalid_request", 400));
  await noModel.service.setMode({ mode: "never" });
  assert.deepEqual(noModel.writes, [["mode", "never"]]);

  const { service, writes } = settingsPorts();
  await assert.rejects(service.addRule({ target: { kind: "text", text: "post" }, decision: "allow" }), isError("invalid_request", 400), "words can only tighten");
  await assert.rejects(service.changeRule({ ref: { source: "rule", id: "rule_fixture_01" } }), isError("invalid_request", 400));
  await assert.rejects(service.removeRule({ ref: { source: "rule", id: "rule_fixture_01" }, extra: true }), isError("invalid_request", 400));
  assert.deepEqual(writes, []);
  assert.deepEqual(await service.addRule({ target: { kind: "site", host: "GitHub.com" }, decision: "allow" }), RULES_VIEW);
  assert.deepEqual(writes, [["add", { target: { kind: "site", host: "github.com" }, decision: "allow" }]]);
});

test("approval settings fail closed: an unreadable rules file refuses every change, refusals stay generic", async () => {
  const unreadable = settingsPorts({ view: { rows: [], unreadable: true } });
  await assert.rejects(unreadable.service.addRule({ target: { kind: "site", host: "github.com" }, decision: "block" }), isError("revision_conflict", 409));
  await assert.rejects(unreadable.service.removeRule({ ref: { source: "rule", id: "rule_fixture_01" } }), isError("revision_conflict", 409));
  assert.deepEqual(unreadable.writes, []);
  assert.deepEqual(await unreadable.service.rules(), { rows: [], unreadable: true }, "reading still says why");

  const gone = settingsPorts({ change: async () => ({ changed: false }) });
  await assert.rejects(gone.service.changeRule({ ref: { source: "rule", id: "rule_fixture_09" }, decision: "ask" }), isError("not_found", 404));

  const refused = settingsPorts({ remove: async () => { throw new ApprovalRulesUnreadableError(); } });
  await assert.rejects(refused.service.removeRule({ ref: { source: "rule", id: "rule_fixture_01" } }), (error: unknown) =>
    isError("revision_conflict", 409)(error) && !(error as Error).message.includes("/"));
});
