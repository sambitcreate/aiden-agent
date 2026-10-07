import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatApprovalCard } from "./chat-approval-card";
import type { ScheduledTaskApprovalDetails } from "../shared/assistant";

const approval: ScheduledTaskApprovalDetails = {
  kind: "scheduled-task", action: "create", taskId: null, expectedUpdatedAt: null,
  enabled: true, name: "Inbox brief", prompt: "Summarize unread messages without sending replies.",
  script: null, cron: "0 9 * * *", timezone: "America/New_York", nextRunAt: 1_900_000_000_000,
  notify: true, mode: "llm", permission: "full", workspaceId: null, workspaceName: null,
  mcpServerIds: ["mail-1"], mcpServerNames: ["Email"], providerId: "local",
  providerName: "Local provider", model: "brief-model", modelName: "Brief model",
  legacyGlobalMcp: false, schedulerEnabled: false,
};

function renderApproval(details: unknown) {
  return renderToStaticMarkup(createElement(ChatApprovalCard, {
    pending: { approvalId: "approval-1", toolCallId: "call-1", toolName: "schedule_task", summary: "Create daily brief", details: details as ScheduledTaskApprovalDetails },
    deciding: false, onDecide: () => undefined,
    cardRef: createRef<HTMLElement>(), denyRef: createRef<HTMLButtonElement>(),
  }));
}

test("task approval discloses instructions, runtime, exact connectors and paused scheduling", () => {
  const markup = renderApproval(approval);
  for (const text of ["Summarize unread messages without sending replies.", "Local provider", "Brief model", "Email (mail-1)", "America/New_York", "will not run automatically"]) {
    assert.ok(markup.includes(text), `Missing approval disclosure: ${text}`);
  }
  assert.ok(markup.includes("Allow once"));
  assert.ok(!markup.includes("Remember this exact action"));
});

test("malformed schedule approval withholds Allow instead of presenting incomplete consent", () => {
  const markup = renderApproval({ ...approval, providerName: undefined });
  assert.ok(markup.includes("Invalid privileged approval blocked"));
  assert.ok(!markup.includes("Allow once"));
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("scheduled task editor offers an explicit App default and pins provider/model on choice", () => {
  const editor = source("./scheduled-task-editor.tsx");
  assert.match(editor, /App default \(follows your selection\)/u);
  assert.match(editor, /value=\{draft\.providerId \?\? APP_DEFAULT_PROVIDER_CHOICE\}/u);
  assert.match(editor, /providerId: undefined, model: undefined/u);
  assert.match(editor, /usableProviders\.map\(/u);
  assert.match(editor, /scheduledTaskProviderModelOptions\(/u);
  assert.match(editor, /providerModelOptions\.models\.map\(/u);
  assert.match(editor, /disabled=\{assistantOwned\}/u);
});

test("provider guardrail is a soft inline warning only for LLM tasks without a provider", () => {
  const editor = source("./scheduled-task-editor.tsx");
  assert.match(editor, /scheduledTaskProviderGuardrail\(/u);
  assert.match(editor, /providerGuardrail \?/u);
  assert.match(
    editor,
    /rounded-control bg-status-warning-surface px-2\.5 py-1\.5 text-small text-status-warning/u,
  );
  assert.doesNotMatch(
    editor,
    /bg-status-warning-surface px-2\.5 py-1\.5 text-small text-status-warning[^"]*(?:border|ring|outline)/u,
  );
  assert.match(editor, /No provider pinned\./u);
});

test("the Model select stays bound to the helper's pinned model and never re-filters its options", () => {
  const editor = source("./scheduled-task-editor.tsx");
  assert.match(
    editor,
    /value=\{providerModelOptions\.model \?\? ""\}/u,
    "the Select value is the helper's pinned (possibly hidden) model",
  );
  assert.match(editor, /providerModelOptions\.models\.map\(/u);
  assert.match(
    editor,
    /scheduledTaskProviderModelOptions\(\s*pinnedProvider,/u,
    "the editor delegates pinned-model resolution to the shared helper",
  );
  assert.doesNotMatch(
    editor,
    /providerModelOptions\.models\.filter\(/u,
    "the editor must not re-filter the helper's prepended pinned-model list",
  );
  assert.match(
    editor,
    /current\.providerId === provider\.id \? current\.model : undefined/u,
    "a stale pinned model from another provider never leaks into the new provider",
  );
});
