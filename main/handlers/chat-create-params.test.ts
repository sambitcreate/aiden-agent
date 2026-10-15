import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
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
  const applicationService = readFileSync(
    new URL("../services/chat-application-service.ts", import.meta.url),
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
  assert.match(publicCreate, /chatApplicationService\.create\(parsed, owner\)/u);
  assert.match(
    applicationService,
    /input\.workspaceId === ASSISTANT_WORKSPACE_ID/u,
  );
  assert.match(
    applicationService,
    /configStore\.getWorkspace\(input\.workspaceId\)/u,
  );
  assert.match(assistantCreate, /parseAssistantChatCreate\(input\)/u);
  assert.match(assistantCreate, /workspaceId: ASSISTANT_WORKSPACE_ID/u);
});
