import assert from "node:assert/strict";
import test from "node:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantAutomationApproval } from "./assistant-automation-approval.js";
import { AssistantPanel } from "./assistant-panel.js";
import { AssistantThread } from "./assistant-thread.js";
import type { AssistantChat } from "./use-assistant-chat.js";

const idleAssistantChat: AssistantChat = {
  messages: [],
  streaming: false,
  streamComplete: false,
  error: null,
  ready: true,
  readiness: "ready",
  canChangeThread: true,
  threads: [],
  activeChatId: null,
  lastNotice: null,
  approvals: [],
  decidingApprovalId: null,
  send: () => undefined,
  stop: () => undefined,
  finishStreamHandoff: () => undefined,
  decideApproval: async () => undefined,
  openThread: () => undefined,
  newThread: () => undefined,
};

test("Aiden replies use the main chat Markdown renderer", () => {
  const html = renderToStaticMarkup(
    <AssistantThread
      messages={[
        { role: "user", content: "Show me a list" },
        { role: "assistant", content: "**Key directories**\n\n- `src`\n- `tests`" },
      ]}
      streaming={false}
      streamComplete={false}
      onStreamHandoffComplete={() => undefined}
      error={null}
    />,
  );
  assert.match(html, /<strong>Key directories<\/strong>/u);
  assert.match(html, /<ul>/u);
  assert.match(html, /<code[^>]*>src<\/code>/u);
  assert.doesNotMatch(html, /\*\*Key directories\*\*/u);
});

test("Aiden composer reuses chat controls and grows for wrapped multiline drafts", () => {
  const html = renderToStaticMarkup(
    <AssistantPanel
      chat={idleAssistantChat}
      draft={"First line\nSecond line\nThird line\nA-very-long-unbroken-value-that-must-wrap"}
      inputRef={createRef<HTMLTextAreaElement>()}
      onDraftChange={() => undefined}
      onMinimize={() => undefined}
    />,
  );
  assert.match(html, /field-sizing-content/u);
  assert.match(html, /min-h-7/u);
  assert.match(html, /max-h-32/u);
  assert.match(html, /overflow-x-hidden/u);
  assert.match(html, /overflow-y-auto/u);
  assert.match(html, /whitespace-pre-wrap/u);
  assert.match(html, /break-words/u);
  assert.match(html, /wrap="soft"/u);
  assert.match(html, /aria-label="Send message"/u);
  assert.match(html, /First line\nSecond line\nThird line/u);
});

test("automation confirmation shows the approved scope with check and cross actions", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-1",
        toolCallId: "tool-1",
        toolName: "schedule_task",
        summary: "Create Morning brief",
        details: {
          kind: "assistant-automation",
          action: "create",
          name: "Morning brief",
          prompt: "Summarize <private> updates.",
          cron: "0 9 * * *",
          timezone: "UTC",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "read-only",
          workspaceId: null,
          workspaceName: null,
          mcpServerIds: [],
          mcpServerNames: [],
          schedulerEnabled: false,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /aria-label="Decline automation"/u);
  assert.match(html, /aria-label="Confirm automation"/u);
  assert.match(html, /Every day at 9:00 AM/u);
  assert.match(html, />Read-only</u);
  assert.match(html, /saved but will not run/u);
  assert.match(html, /Runs while Aiden is open/u);
  assert.match(html, /Summarize &lt;private&gt; updates\./u);
  assert.doesNotMatch(html, /0 9 \* \* \*/u);
  assert.doesNotMatch(html, /No project|Notifications on|MCP:/u);
  assert.doesNotMatch(html, /<private>/u);
});

test("Full automation confirmation names the project and write scope", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-full",
        toolCallId: "tool-full",
        toolName: "schedule_task",
        summary: "Update report",
        details: {
          kind: "assistant-automation",
          action: "create",
          name: "Update report",
          prompt: "Update the project report.",
          cron: "0 9 * * *",
          timezone: "UTC",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "full",
          workspaceId: "workspace-1",
          workspaceName: "Website",
          mcpServerIds: [],
          mcpServerNames: [],
          schedulerEnabled: true,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /Full access · Website/u);
  assert.match(html, /Can edit files and run commands in Website/u);
  assert.doesNotMatch(html, /Notifications on/u);
});

test("MCP automation confirmation keeps the decision compact and Full access explicit", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-mcp",
        toolCallId: "tool-mcp",
        toolName: "schedule_task",
        summary: "Create Morning email brief",
        details: {
          kind: "assistant-automation",
          action: "create",
          name: "Morning email brief",
          prompt: "Summarize new email.",
          cron: "0 9 * * *",
          timezone: "UTC",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "full",
          workspaceId: null,
          workspaceName: null,
          mcpServerIds: ["gmail"],
          mcpServerNames: ["Gmail"],
          schedulerEnabled: true,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /aria-label="Decline Full access automation"/u);
  assert.match(html, /aria-label="Confirm Full access automation"/u);
  assert.match(html, />Full access</u);
  assert.doesNotMatch(html, /Gmail|MCP:|tools unattended|external data/u);
});

test("automation edits use a save confirmation and describe paused state truthfully", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-edit",
        toolCallId: "tool-edit",
        toolName: "edit_automation",
        summary: "Edit Morning email brief",
        details: {
          kind: "assistant-automation",
          action: "edit",
          taskId: "task-1",
          enabled: false,
          name: "Morning email brief",
          prompt: "Summarize new email.",
          cron: "0 9 * * *",
          timezone: "America/New_York",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "full",
          workspaceId: null,
          workspaceName: null,
          mcpServerIds: ["gmail"],
          mcpServerNames: ["Gmail"],
          schedulerEnabled: true,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /Save these changes\?/u);
  assert.match(html, /aria-label="Decline Full access automation changes"/u);
  assert.match(html, /aria-label="Confirm Full access automation changes"/u);
  assert.match(html, /Remains paused/u);
  assert.doesNotMatch(html, /Create this automation|Next run:/u);
});

test("automation confirmation fails closed when normalized details are missing", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-invalid",
        toolCallId: "tool-invalid",
        toolName: "schedule_task",
        summary: "Create something else",
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /invalid and cannot be confirmed/u);
  assert.match(html, /aria-label="Confirm automation"[^>]*disabled=""/u);
  assert.doesNotMatch(html, /Create something else/u);
});
