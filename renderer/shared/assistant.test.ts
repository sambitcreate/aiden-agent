import assert from "node:assert/strict";
import test from "node:test";
import {
  isAssistantAutomationApprovalDetails,
  type AssistantAutomationApprovalDetails,
} from "./assistant.js";

const base: AssistantAutomationApprovalDetails = {
  kind: "assistant-automation",
  action: "create",
  name: "Daily report",
  prompt: "Update the report.",
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
  providerId: "local-provider",
  providerName: "Local Provider",
  model: "local-model",
  modelName: "Local Model",
  schedulerEnabled: true,
};

test("Assistant automation details require a matching project identity for Full access", () => {
  assert.equal(isAssistantAutomationApprovalDetails(base), true);
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      workspaceId: "workspace-1",
      workspaceName: "Website",
    }),
    true,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      workspaceId: "workspace-1",
      workspaceName: "Website",
      mcpServerIds: ["gmail"],
      mcpServerNames: ["Gmail"],
    }),
    false,
  );
  assert.equal(isAssistantAutomationApprovalDetails({ ...base, permission: "full" }), false);
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      mcpServerIds: ["gmail"],
      mcpServerNames: ["Gmail"],
    }),
    true,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      mcpServerIds: ["gmail"],
      mcpServerNames: ["Gmail"],
    }),
    false,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      permission: "full",
      mcpServerIds: ["gmail"],
      mcpServerNames: [],
    }),
    false,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      workspaceId: "workspace-1",
      workspaceName: null,
    }),
    false,
  );
});

test("Assistant edit approvals require an exact task identity and enabled state", () => {
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      action: "edit",
      taskId: "task-1",
      enabled: true,
    }),
    true,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      action: "edit",
      enabled: true,
    }),
    false,
  );
  assert.equal(
    isAssistantAutomationApprovalDetails({
      ...base,
      action: "edit",
      taskId: "task-1",
    }),
    false,
  );
  assert.equal(isAssistantAutomationApprovalDetails({ ...base, taskId: "task-1" }), false);
});
