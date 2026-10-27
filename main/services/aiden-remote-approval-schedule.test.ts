import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import {
  AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT,
  approvalScheduleCard,
  parseAidenRemoteApprovalSchedule,
} from "./aiden-remote-approval-schedule.js";

const NEXT_RUN = Date.UTC(2026, 9, 23, 16, 0, 0);

/** Scheduled-task approval details as the schedule tool hands them to the approval card. */
function details(overrides: Record<string, unknown> = {}) {
  return {
    kind: "scheduled-task",
    action: "create",
    taskId: null,
    expectedUpdatedAt: null,
    enabled: true,
    name: "Morning briefing",
    prompt: "Summarize overnight commits.\nFlag anything that broke the build.",
    script: null,
    cron: "0 9 * * 1-5",
    timezone: "America/Los_Angeles",
    nextRunAt: NEXT_RUN,
    notify: true,
    mode: "llm",
    permission: "read-only",
    workspaceId: "workspace-1",
    workspaceName: "Aiden Agent",
    mcpServerIds: [],
    mcpServerNames: [],
    providerId: "openrouter",
    providerName: "OpenRouter",
    model: "qwen/qwen3-coder",
    modelName: "Qwen3 Coder",
    legacyGlobalMcp: false,
    schedulerEnabled: true,
    ...overrides,
  };
}

test("a scheduled-task approval becomes a card with the facts a person decides on and no ids", () => {
  const card = approvalScheduleCard(details());
  assert.ok(card);
  const { cadence, ...rest } = card;
  // The zone suffix depends on the host's own zone, so only the wording is pinned.
  assert.match(cadence, /^Weekdays at 9:00 AM\b/u);
  assert.deepEqual(rest, {
    action: "create",
    name: "Morning briefing",
    timezone: "America/Los_Angeles",
    nextRunAt: "2026-10-23T16:00:00.000Z",
    mode: "llm",
    permission: "read-only",
    workspaceName: "Aiden Agent",
    connectors: [],
    providerName: "OpenRouter",
    modelName: "Qwen3 Coder",
    notify: true,
    enabled: true,
    schedulerEnabled: true,
    prompt: "Summarize overnight commits.\nFlag anything that broke the build.",
  });
  const wire = JSON.stringify(card);
  for (const id of ["workspace-1", "openrouter", "qwen/qwen3-coder", "0 9 * * 1-5"]) {
    assert.equal(wire.includes(id), false, `${id} stays on the host`);
  }
});

test("a full-access task lists its connectors by name", () => {
  const card = approvalScheduleCard(details({
    permission: "full",
    workspaceId: null,
    workspaceName: null,
    mcpServerIds: ["gmail", "linear"],
    mcpServerNames: ["Gmail", "Linear"],
  }));
  assert.equal(card?.permission, "full");
  assert.deepEqual(card?.connectors, ["Gmail", "Linear"]);
  assert.equal(card?.workspaceName, undefined);
});

test("a card names the next run only while the task will run on its own", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["saved paused", { action: "update", taskId: "task-1", expectedUpdatedAt: 5, enabled: false }],
    ["scheduling off", { schedulerEnabled: false }],
    ["being removed", { action: "remove", taskId: "task-1", expectedUpdatedAt: 5 }],
    ["no next run", { nextRunAt: 0 }],
  ];
  for (const [label, overrides] of cases) {
    const card = approvalScheduleCard(details(overrides));
    assert.ok(card, label);
    assert.equal(card.nextRunAt, undefined, label);
  }
  const paused = approvalScheduleCard(details(cases[0]![1]));
  assert.equal(paused?.enabled, false);
  assert.equal(paused?.action, "update");
  assert.equal(approvalScheduleCard(details({ schedulerEnabled: false }))?.schedulerEnabled, false);
});

test("a pause or resume card says what the task will be once approved, not what it is while it waits", () => {
  const resumed = approvalScheduleCard(details({ action: "resume", taskId: "task-1", expectedUpdatedAt: 5, enabled: false }));
  assert.equal(resumed?.enabled, true);
  assert.equal(resumed?.nextRunAt, "2026-10-23T16:00:00.000Z", "a resumed task runs on its own again");

  const paused = approvalScheduleCard(details({ action: "pause", taskId: "task-1", expectedUpdatedAt: 5, enabled: true }));
  assert.equal(paused?.enabled, false);
  assert.equal(paused?.nextRunAt, undefined);

  // Running a paused task once leaves it paused.
  const ranNow = approvalScheduleCard(details({ action: "run_now", taskId: "task-1", expectedUpdatedAt: 5, enabled: false }));
  assert.equal(ranNow?.enabled, false);
  assert.equal(ranNow?.nextRunAt, undefined);
});

test("a script task carries its command and never a model or instructions", () => {
  const card = approvalScheduleCard(details({
    mode: "script",
    prompt: null,
    script: "npm outdated --json > reports/outdated.json",
  }));
  assert.equal(card?.mode, "script");
  assert.equal(card?.script, "npm outdated --json > reports/outdated.json");
  assert.equal(card?.prompt, undefined);
  assert.equal(card?.providerName, undefined);
  assert.equal(card?.modelName, undefined);
});

test("long instructions are cut to the wire bound and marked, without splitting a character", () => {
  const exact = "a".repeat(AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT);
  const fits = approvalScheduleCard(details({ prompt: exact }));
  assert.equal(fits?.prompt, exact);
  assert.equal(fits?.truncated, undefined);

  // The emoji straddles the bound, so it is dropped whole rather than split.
  const kept = "b".repeat(AIDEN_REMOTE_APPROVAL_SCHEDULE_TEXT_LIMIT - 1);
  const cut = approvalScheduleCard(details({ prompt: `${kept}😀 and more instructions` }));
  assert.equal(cut?.prompt, kept);
  assert.equal(cut?.truncated, true);
});

test("the Assistant's own new task gets the same card, and its edits keep the summary", () => {
  const { kind: _kind, taskId: _taskId, expectedUpdatedAt: _expected, enabled: _enabled, script: _script, legacyGlobalMcp: _legacy, ...shared } = details();
  const proposal = { ...shared, kind: "assistant-automation", action: "create" };
  const card = approvalScheduleCard(proposal);
  assert.equal(card?.action, "create");
  assert.equal(card?.enabled, true);
  assert.equal(card?.nextRunAt, "2026-10-23T16:00:00.000Z");
  assert.equal(card?.workspaceName, "Aiden Agent");
  assert.equal(card?.prompt, proposal.prompt);
  assert.equal(JSON.stringify(card).includes("workspace-1"), false, "the project id stays on the host");

  assert.equal(approvalScheduleCard({ ...proposal, action: "edit", taskId: "task-1", enabled: false }), undefined);
});

test("other approvals and details that fail validation yield no card", () => {
  for (const [label, value] of [
    ["missing", undefined],
    ["a command approval", { kind: "command", command: "rm -rf build" }],
    ["an automation edit", { kind: "automation", action: "update", name: "Nightly" }],
    ["a bidi override in the name", details({ name: "Morning‮ briefing" })],
    ["a control character in the prompt", details({ prompt: "Run\u0007 now" })],
    ["connectors on a project task", details({ mcpServerIds: ["gmail"], mcpServerNames: ["Gmail"] })],
  ] as const) {
    assert.equal(approvalScheduleCard(value), undefined, label);
  }
});

test("the wire validator accepts every shared fixture card and rejects every malformed one", async () => {
  const fixture = JSON.parse(
    await fs.readFile(new URL("../../protocol/aiden-remote/v1/fixtures/contract.json", import.meta.url), "utf8"),
  ) as { scheduleCards: { cards: Array<{ label: string; schedule: unknown }>; rejected: Array<{ label: string; schedule: unknown }> } };
  assert.ok(fixture.scheduleCards.cards.length > 0);
  for (const { label, schedule } of fixture.scheduleCards.cards) {
    assert.deepEqual(parseAidenRemoteApprovalSchedule(schedule), schedule, label);
  }
  assert.ok(fixture.scheduleCards.rejected.length > 0);
  for (const { label, schedule } of fixture.scheduleCards.rejected) {
    assert.throws(() => parseAidenRemoteApprovalSchedule(schedule), /Approval schedule/u, label);
  }
});
