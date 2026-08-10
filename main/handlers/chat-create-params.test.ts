import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import { WorkspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "../services/workspace-operation-registry.js";
import {
  parseAssistantChatCreate,
  parseChatCreate,
} from "./chat-create-params.js";

test("public and Assistant chat creation use distinct exact bounded envelopes", () => {
  assert.deepEqual(
    parseChatCreate({
      title: "Review",
      workspaceId: "workspace-1",
      providerId: "provider-1",
      model: "model-1",
    }),
    {
      title: "Review",
      workspaceId: "workspace-1",
      providerId: "provider-1",
      model: "model-1",
    },
  );
  assert.deepEqual(parseAssistantChatCreate({ providerId: "p", model: "m" }), {
    providerId: "p",
    model: "m",
  });
  assert.throws(
    () => parseAssistantChatCreate({ workspaceId: ASSISTANT_WORKSPACE_ID }),
    /Invalid Assistant chat creation fields/u,
  );
  assert.throws(
    () => parseChatCreate({ title: "x".repeat(121) }),
    /Invalid chat title/u,
  );
  assert.throws(() => parseChatCreate({}), /Invalid workspace id/u);
});

test("chat creation rejects excess keys lazily with constant errors", () => {
  const fields: Record<string, unknown> = { workspaceId: "workspace-1" };
  for (let index = 0; index < 10_000; index += 1)
    fields[`extra-${index}`] = index;
  assert.throws(
    () => parseChatCreate(fields),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid chat creation fields.",
  );
  const source = readFileSync(
    new URL("./chat-create-params.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Object\.keys/u);
  assert.match(source, /count > allowed\.size/u);
});

test("the reserved Assistant workspace is minted only by the dedicated handler", () => {
  const handlers = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
  const renderer = readFileSync(
    new URL(
      "../../renderer/components/assistant/use-assistant-chat.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const publicCreate = handlers.slice(
    handlers.indexOf('"chats:create"'),
    handlers.indexOf('"chats:createAssistant"'),
  );
  const assistantCreate = handlers.slice(
    handlers.indexOf('"chats:createAssistant"'),
    handlers.indexOf('"chats:rename"'),
  );
  assert.match(publicCreate, /parsed\.workspaceId === ASSISTANT_WORKSPACE_ID/u);
  assert.match(
    publicCreate,
    /configStore\.getWorkspace\(parsed\.workspaceId\)/u,
  );
  assert.match(assistantCreate, /parseAssistantChatCreate\(input\)/u);
  assert.match(assistantCreate, /workspaceId: ASSISTANT_WORKSPACE_ID/u);
  assert.match(renderer, /chatsApi\.createAssistant\(/u);
  assert.doesNotMatch(
    renderer,
    /chatsApi\.create\(\{\s*workspaceId: ASSISTANT_WORKSPACE_ID/u,
  );
});

test("public chat creation is aborted and drained across a workspace mutation", async () => {
  const mutationGate = new WorkspaceMutationGate();
  const operations = new WorkspaceOperationRegistry();
  const mutationAdmission = mutationGate.admit("workspace-1");
  const operation = operations.admit("workspace-1");

  const finishMutation = mutationGate.begin("workspace-1");
  let drained = false;
  const draining = operations.cancelAndSettle("workspace-1").then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(mutationAdmission.signal.aborted, true);
  assert.equal(operation.signal.aborted, true);
  assert.equal(drained, false);
  assert.throws(() => {
    if (mutationAdmission.signal.aborted || operation.signal.aborted) {
      throw new Error("The workspace changed before the chat was created.");
    }
  }, /workspace changed before the chat was created/u);

  operation.release();
  mutationAdmission.release();
  await draining;
  assert.equal(drained, true);
  finishMutation();

  const handlers = readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
  const publicCreate = handlers.slice(
    handlers.indexOf('"chats:create"'),
    handlers.indexOf('"chats:createAssistant"'),
  );
  assert.match(
    publicCreate,
    /workspaceMutationGate\.admit\(parsed\.workspaceId\)/u,
  );
  assert.match(publicCreate, /admitRendererOwnedWorkspaceOperation\(/u);
  assert.match(publicCreate, /workspaceOperation\?\.signal\.aborted/u);
  assert.match(publicCreate, /workspaceOperation\?\.release\(\)/u);
  assert.match(publicCreate, /mutationAdmission\?\.release\(\)/u);
});
