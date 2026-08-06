import assert from "node:assert/strict";
import test from "node:test";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { manageSubagentForDocumentV2 } from "./subagent-control-ipc-core.js";
import type { SubagentManagementResultV2 } from "./subagent-control-v2.js";

function owner(overrides: Partial<RendererDocumentOwner> = {}): RendererDocumentOwner {
  return {
    id: 1,
    documentId: "document-one",
    isDestroyed: () => false,
    send: () => {},
    onInvalidated: () => () => {},
    ...overrides,
  };
}

test("IPC control resolves workspace and document in main without renderer authority", async () => {
  let received: unknown;
  const result = { version: 2, action: "status", snapshot: {} } as SubagentManagementResultV2;
  assert.equal(
    await manageSubagentForDocumentV2(
      owner(),
      "chat-one",
      { version: 2, action: "status", runId: "run-one" },
      {
        getChat: async () => ({ id: "chat-one", workspaceId: "workspace-one" }),
        execute: async (scope, request) => {
          received = { scope, request };
          return result;
        },
      },
    ),
    result,
  );
  assert.deepEqual(received, {
    scope: {
      chatId: "chat-one",
      workspaceId: "workspace-one",
      ownerDocumentId: "document-one",
    },
    request: { version: 2, action: "status", runId: "run-one" },
  });
});

test("IPC control rejects malformed input and invalidated documents", async () => {
  let destroyed = false;
  let executes = 0;
  const dependencies = {
    getChat: async () => {
      destroyed = true;
      return { id: "chat-one" };
    },
    execute: async () => {
      executes += 1;
      return {} as SubagentManagementResultV2;
    },
  };
  await assert.rejects(
    manageSubagentForDocumentV2(
      owner({ isDestroyed: () => destroyed }),
      "chat-one",
      { version: 2, action: "status", runId: "run-one" },
      dependencies,
    ),
    /no longer active/u,
  );
  assert.equal(executes, 0);
  await assert.rejects(
    manageSubagentForDocumentV2(
      owner(),
      "bad chat",
      { version: 2, action: "status", runId: "run-one" },
      dependencies,
    ),
    /Invalid subagent control chat/u,
  );
});
