import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatApprovalCard, type ChatApprovalDecisionOptions } from "./chat-approval-card";
import { TooltipProvider } from "./ui";
import type { ApprovalPrompt } from "../lib/ipc";
import type { AssistantAutomationApprovalDetails, ScheduledTaskApprovalDetails } from "../shared/assistant";
import { toolApprovalPreview } from "../shared/tool-approval-preview";
import { detectedKeyboardPlatform } from "../shared/keybindings";
import { subagentOutboundApprovalSummaryV2 } from "../../main/services/subagents/outbound-approval-v2.js";

afterEach(cleanup);

function mount(pending: Partial<ApprovalPrompt> & Pick<ApprovalPrompt, "toolName" | "summary">) {
  const decisions: Array<[string, ChatApprovalDecisionOptions | undefined]> = [];
  render(
    <TooltipProvider>
      <ChatApprovalCard
        pending={{ approvalId: "approval-1", toolCallId: "call-1", ...pending }}
        deciding={false}
        onDecide={(decision, options) => decisions.push([decision, options])}
      />
    </TooltipProvider>,
  );
  return { card: screen.getByRole("region"), decisions };
}

test("a command approval asks a plain question and shows the exact command", () => {
  const command = "rm -rf dist && npm ci";
  const { card, decisions } = mount({
    toolName: "run_command",
    summary: `Run command: ${command}`,
    preview: toolApprovalPreview("run_command", { command }),
    scopes: ["once", "chat", "always"],
  });

  assert.equal(screen.getByRole("region", { name: "Run this command?" }), card);
  assert.match(card.querySelector("#approval-summary-approval-1")?.textContent ?? "", /rm -rf dist && npm ci$/u);
  assert.deepEqual(
    within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ["Copy command", "Deny", "Allow once", "More ways to allow"],
  );

  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
  assert.deepEqual(decisions, [
    ["allow", undefined],
    ["deny", undefined],
  ]);
});

test("the Allow menu offers the remembered scopes and sends the one picked", async () => {
  const { card, decisions } = mount({
    toolName: "run_command",
    summary: "Run command: npm test",
    preview: { kind: "command", command: "npm test" },
    scopes: ["once", "chat", "always"],
  });

  fireEvent.pointerDown(within(card).getByRole("button", { name: "More ways to allow" }), { button: 0, pointerType: "mouse" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(
    items.map((item) => item.textContent),
    [
      "Allow for this chatWon't ask again for this exact command until Aiden quits.",
      "Always allow in this workspaceWon't ask again for this exact command here. Undo in Settings → Tool approvals.",
    ],
  );
  fireEvent.click(items[1]!);
  assert.deepEqual(decisions, [["allow", { scope: "always" }]]);
});

test("a remembered file approval says it covers any later change to that file", async () => {
  // File rules match the tool and path, not the contents, so the hint must not promise an exact change.
  const { card } = mount({ toolName: "edit_file", summary: "Edit file: src/forecast.ts", scopes: ["once", "chat", "always"] });

  fireEvent.pointerDown(within(card).getByRole("button", { name: "More ways to allow" }), { button: 0, pointerType: "mouse" });
  assert.deepEqual(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    [
      "Allow for this chatWon't ask again for any edit to forecast.ts until Aiden quits.",
      "Always allow in this workspaceWon't ask again for any edit to forecast.ts here. Undo in Settings → Tool approvals.",
    ],
  );
});

test("a file edit shows the lines it removes and adds, labelled for screen readers", () => {
  const { card } = mount({
    toolName: "edit_file",
    summary: "Edit file: src/forecast.ts",
    preview: toolApprovalPreview("edit_file", {
      path: "src/forecast.ts",
      old_string: "const score = hike();\nreturn Math.floor(score);",
      new_string: "const score = hike();\nreturn Math.round(score * 10) / 10;",
    }),
  });

  assert.ok(screen.getByRole("region", { name: "Edit forecast.ts?" }));
  const change = within(card).getByRole("group", { name: "Change to src/forecast.ts" });
  assert.deepEqual(
    [...change.querySelectorAll("[data-line]")].map((line) => [line.getAttribute("data-line"), line.textContent]),
    [
      ["context", "  const score = hike();"],
      ["removed", "- Removed: return Math.floor(score);"],
      ["added", "+ Added: return Math.round(score * 10) / 10;"],
    ],
  );
  assert.ok(within(card).getByText("src/forecast.ts · 1 added, 1 removed"));
  assert.equal(within(card).queryByRole("button", { name: "More ways to allow" }), null, "no scopes were offered");
});

test("a paired host's command summary still shows just the command", () => {
  const { card } = mount({ toolName: "run_command", summary: "Run command: git status" });

  assert.ok(screen.getByRole("region", { name: "Run this command?" }));
  assert.match(card.querySelector("#approval-summary-approval-1")?.textContent ?? "", /^\$ git status$/u);
  assert.ok(within(card).getByText("Aiden is paused until you choose."));
  cleanup();

  // A paired host's file summary names its one file in the title and keeps the summary as sent.
  mount({ toolName: "edit_file", summary: "Edit file: src/forecast.ts" });
  assert.ok(screen.getByRole("region", { name: "Edit forecast.ts?" }));
  assert.ok(screen.getByText("Edit file: src/forecast.ts"));
});

test("a subagent's web search reaches the owner as a plain card with its whole request", () => {
  const summary = subagentOutboundApprovalSummaryV2({ toolName: "web_search", kind: "web" }, { query: "best hikes near Boulder" });
  const { card, decisions } = mount({ toolName: "web_search", summary });

  assert.ok(screen.getByRole("region", { name: "Allow Web search?" }));
  assert.equal(within(card).getByText(/^Search the public web/u).textContent, summary, "every line of the request is shown");
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  assert.deepEqual(decisions, [["allow", undefined]]);
});

test("an approval that cannot be allowed here offers only Deny", () => {
  const { card } = mount({ toolName: "run_command", summary: "Run command: ls", canAllow: false });

  assert.deepEqual(
    within(card).getAllByRole("button").map((button) => button.textContent),
    ["Deny"],
  );
  assert.ok(within(card).getByText(/cannot safely authorize this action from this view/u));
});

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A scheduled-task approval as the schedule tool hands it to the card. */
function scheduledTask(overrides: Partial<ScheduledTaskApprovalDetails> = {}): ScheduledTaskApprovalDetails {
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
    timezone: LOCAL_ZONE,
    nextRunAt: Date.now() + 3 * 86_400_000,
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

function mountSchedule(details: ScheduledTaskApprovalDetails | AssistantAutomationApprovalDetails) {
  return mount({
    toolName: details.kind === "scheduled-task" || details.action === "create" ? "schedule_task" : "edit_automation",
    summary: "Create scheduled task",
    details: details as unknown as ApprovalPrompt["details"],
  });
}

/** Each detail row as its label and what it says, the way a screen reader pairs them. */
function facts(card: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    within(card).getAllByRole("term").map((term) => [term.textContent, term.nextElementSibling?.textContent ?? ""]),
  );
}

test("a scheduled task reads as the task itself: its question, cadence, next run, where it runs and what it is told", () => {
  const { card, decisions } = mountSchedule(scheduledTask());

  assert.equal(screen.getByRole("region", { name: "Save this scheduled task?" }), card);
  assert.ok(within(card).getByText("Morning briefing"));
  assert.ok(within(card).getByText(/^Weekdays at 9:00\sAM$/u), "the cadence is plain words, never cron");
  assert.equal(within(card).queryByText(/0 9 \* \* 1-5/u), null);
  assert.ok(within(card).getByText(/^Next run /u));
  const rows = facts(card);
  assert.match(rows["Runs in"] ?? "", /^Aiden Agent.*workspace-1$/u, "the project and the exact id it authorizes");
  assert.equal(rows.Access, "Read-only");
  assert.equal(rows.Model, "OpenRouter · Qwen3 Coder");
  assert.equal(rows.Notifications, "On");
  assert.equal(rows["Time zone"], LOCAL_ZONE);
  assert.equal(
    within(card).getByLabelText("Instructions").textContent,
    "Summarize overnight commits.\nFlag anything that broke the build.",
  );
  assert.ok(within(card).getByText("Scheduled work runs on your desktop while Aiden is open and the computer is awake."));
  assert.equal(within(card).queryAllByRole("note").length, 0, "a task that will run as asked needs no warning");

  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
  assert.deepEqual(decisions, [
    ["allow", undefined],
    ["deny", undefined],
  ]);
});

test("where a task runs follows its scope: connectors by name and id, the whole computer, or no project", () => {
  const { card } = mountSchedule(scheduledTask({
    permission: "full",
    workspaceId: null,
    workspaceName: null,
    mcpServerIds: ["gmail-1", "linear-2"],
    mcpServerNames: ["Gmail", "Linear"],
  }));
  const connectors = within(card).getAllByRole("listitem").map((item) => item.textContent);
  assert.equal(connectors.length, 2);
  assert.match(connectors[0] ?? "", /^Gmail .*gmail-1$/u);
  assert.match(connectors[1] ?? "", /^Linear .*linear-2$/u);
  assert.equal(facts(card).Access, "Full access");
  cleanup();

  const { card: global } = mountSchedule(scheduledTask({ permission: "full", workspaceId: null, workspaceName: null }));
  assert.equal(facts(global)["Runs in"], "Anywhere on your computer");
  cleanup();

  const { card: unscoped } = mountSchedule(scheduledTask({ workspaceId: null, workspaceName: null }));
  assert.equal(facts(unscoped)["Runs in"], "No project");
  assert.equal(facts(unscoped).Access, "Read-only");
});

test("a next run is named only while the task will run on its own, and scheduling off or paused says why", () => {
  const { card: off } = mountSchedule(scheduledTask({ schedulerEnabled: false }));
  assert.equal(within(off).queryByText(/^Next run /u), null);
  assert.equal(
    within(off).getByRole("note").textContent,
    "Scheduling is off. This task will be saved but will not run automatically until you enable scheduling.",
  );
  assert.ok(within(off).getByRole("button", { name: "Allow once" }), "saving stays possible while scheduling is off");
  cleanup();

  const { card: paused } = mountSchedule(scheduledTask({ action: "update", taskId: "task-1", expectedUpdatedAt: 5, enabled: false }));
  assert.ok(screen.getByRole("region", { name: "Update this scheduled task?" }));
  assert.equal(within(paused).queryByText(/^Next run /u), null);
  assert.equal(within(paused).getByRole("note").textContent, "This task stays paused.");
  cleanup();

  const { card: removing } = mountSchedule(scheduledTask({ action: "remove", taskId: "task-1", expectedUpdatedAt: 5, enabled: false }));
  assert.ok(screen.getByRole("region", { name: "Delete this scheduled task?" }));
  assert.equal(within(removing).queryByText(/^Next run /u), null);
  assert.equal(within(removing).queryAllByRole("note").length, 0, "a deleted task is not described as paused");
  cleanup();

  for (const [action, title] of [
    ["pause", "Pause this scheduled task?"],
    ["resume", "Resume this scheduled task?"],
    ["run_now", "Run this scheduled task now?"],
  ] as const) {
    mountSchedule(scheduledTask({ action, taskId: "task-1", expectedUpdatedAt: 5 }));
    assert.ok(screen.getByRole("region", { name: title }), action);
    cleanup();
  }
});

test("pausing and resuming describe the task as it will be once approved", () => {
  // A proposal carries the task's state while it waits: resuming a paused task, pausing a running one.
  const { card: resuming } = mountSchedule(scheduledTask({ action: "resume", taskId: "task-1", expectedUpdatedAt: 5, enabled: false }));
  assert.ok(within(resuming).getByText(/^Next run /u), "a resumed task runs on its own again");
  assert.equal(within(resuming).queryAllByRole("note").length, 0);
  cleanup();

  const { card: pausing } = mountSchedule(scheduledTask({ action: "pause", taskId: "task-1", expectedUpdatedAt: 5, enabled: true }));
  assert.equal(within(pausing).queryByText(/^Next run /u), null, "a paused task has no next run");
  assert.equal(within(pausing).queryAllByRole("note").length, 0, "the question already says it pauses");
  cleanup();

  const { card: runningNow } = mountSchedule(scheduledTask({ action: "run_now", taskId: "task-1", expectedUpdatedAt: 5, enabled: false }));
  assert.equal(within(runningNow).queryByText(/^Next run /u), null);
  assert.equal(within(runningNow).getByRole("note").textContent, "This task stays paused.", "running it once leaves it paused");
});

test("a tall schedule review scrolls as one labelled region with the notes outside it", () => {
  const { card } = mountSchedule(scheduledTask({ schedulerEnabled: false }));
  const review = within(card).getByRole("group", { name: "Task details" });
  assert.equal(review.tabIndex, 0, "keyboard users can scroll it");
  assert.ok(within(review).getByText("Morning briefing"));
  assert.ok(within(review).getByLabelText("Instructions"));
  assert.equal(within(review).queryAllByRole("note").length, 0);
  assert.equal(within(card).getAllByRole("note").length, 1, "the scheduling-off note stays in view");
});

test("a script task shows the exact script it will run and no model", () => {
  const script = "npm outdated --json > reports/outdated.json";
  const { card } = mountSchedule(scheduledTask({ mode: "script", prompt: null, script }));

  const rows = facts(card);
  assert.equal(rows.Runs, "Script");
  assert.equal(rows.Model, undefined);
  assert.equal(within(card).getByLabelText("Script").textContent, script);
  assert.equal(within(card).queryByLabelText("Instructions"), null);
});

test("an automation change keeps its own question and the same review", () => {
  const automation: AssistantAutomationApprovalDetails = {
    kind: "assistant-automation",
    action: "edit",
    taskId: "task-1",
    enabled: false,
    name: "Weekly digest",
    prompt: "Write the weekly digest.",
    cron: "0 17 * * 5",
    timezone: LOCAL_ZONE,
    nextRunAt: Date.now() + 86_400_000,
    notify: false,
    mode: "llm",
    permission: "read-only",
    workspaceId: null,
    workspaceName: null,
    mcpServerIds: [],
    mcpServerNames: [],
    providerId: "openrouter",
    providerName: "OpenRouter",
    model: "qwen/qwen3-coder",
    modelName: "Qwen3 Coder",
    schedulerEnabled: true,
  };
  const { card } = mountSchedule(automation);

  assert.equal(screen.getByRole("region", { name: "Change this automation?" }), card);
  assert.equal(facts(card).Notifications, "Off");
  assert.equal(within(card).queryByText(/^Next run /u), null);
  assert.equal(within(card).getByRole("note").textContent, "This task stays paused.");
  cleanup();

  // The Assistant's own new task asks what an ordinary chat's would, not "Change".
  const { taskId: _taskId, enabled: _enabled, ...proposal } = automation;
  mountSchedule({ ...proposal, action: "create" });
  assert.ok(screen.getByRole("region", { name: "Save this scheduled task?" }));
});

function mountWithComposer(
  pending: Partial<ApprovalPrompt> & Pick<ApprovalPrompt, "toolName" | "summary">,
  { keyboardShortcuts = true, deciding = false }: { keyboardShortcuts?: boolean; deciding?: boolean } = {},
) {
  const decisions: Array<[string, ChatApprovalDecisionOptions | undefined]> = [];
  render(
    <TooltipProvider>
      <ChatApprovalCard
        pending={{ approvalId: "approval-1", toolCallId: "call-1", ...pending }}
        deciding={deciding}
        onDecide={(decision, options) => decisions.push([decision, options])}
        keyboardShortcuts={keyboardShortcuts}
      />
      <textarea aria-label="Message" data-message-draft="" />
    </TooltipProvider>,
  );
  const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  composer.focus();
  return { composer, decisions };
}

// The primary modifier the card listens for on this test's platform: ⌘ on a Mac, Ctrl elsewhere.
function primaryKey(key: "Enter" | "Backspace") {
  const mac = detectedKeyboardPlatform() === "darwin";
  return { key, metaKey: mac, ctrlKey: !mac };
}

test("⌘↩ allows once and ⌘⌫ denies while the message box is empty", () => {
  const { composer, decisions } = mountWithComposer({ toolName: "bash", summary: "npm test" });
  fireEvent.keyDown(composer, primaryKey("Enter"));
  fireEvent.keyDown(composer, primaryKey("Backspace"));
  assert.deepEqual(decisions, [
    ["allow", undefined],
    ["deny", undefined],
  ]);
  const allow = screen.getByRole("button", { name: /Allow once/ });
  assert.match(allow.getAttribute("aria-keyshortcuts") ?? "", /\+Enter$/);
});

test("approval keys leave the message box alone once something is typed", () => {
  const { composer, decisions } = mountWithComposer({ toolName: "bash", summary: "npm test" });
  fireEvent.change(composer, { target: { value: "wait, use pnpm" } });
  const enter = fireEvent.keyDown(composer, primaryKey("Enter"));
  const backspace = fireEvent.keyDown(composer, primaryKey("Backspace"));
  assert.deepEqual(decisions, []);
  assert.equal(enter && backspace, true, "the keys reach the message box untouched");

  // The draft still counts once focus moves to the card's buttons.
  const deny = screen.getByRole("button", { name: "Deny" });
  deny.focus();
  fireEvent.keyDown(deny, primaryKey("Enter"));
  fireEvent.keyDown(deny, primaryKey("Backspace"));
  assert.deepEqual(decisions, []);
});

test("approval keys stay off while a menu is open, without the modifier, or while deciding", () => {
  const typing = mountWithComposer({ toolName: "bash", summary: "npm test" });
  fireEvent.keyDown(typing.composer, { key: "Enter" });
  fireEvent.keyDown(typing.composer, { ...primaryKey("Enter"), shiftKey: true });
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-state", "open");
  document.body.append(menu);
  fireEvent.keyDown(typing.composer, primaryKey("Enter"));
  menu.remove();
  assert.deepEqual(typing.decisions, []);
  cleanup();

  const sending = mountWithComposer({ toolName: "bash", summary: "npm test" }, { deciding: true });
  fireEvent.keyDown(sending.composer, primaryKey("Enter"));
  assert.deepEqual(sending.decisions, []);
});

test("only a card that takes approval keys answers them, and one that can't allow only denies", () => {
  const passive = mountWithComposer({ toolName: "bash", summary: "npm test" }, { keyboardShortcuts: false });
  fireEvent.keyDown(passive.composer, primaryKey("Enter"));
  fireEvent.keyDown(passive.composer, primaryKey("Backspace"));
  assert.deepEqual(passive.decisions, []);
  cleanup();

  const denyOnly = mountWithComposer({ toolName: "bash", summary: "npm test", canAllow: false });
  fireEvent.keyDown(denyOnly.composer, primaryKey("Enter"));
  fireEvent.keyDown(denyOnly.composer, primaryKey("Backspace"));
  assert.deepEqual(denyOnly.decisions, [["deny", undefined]]);
});
