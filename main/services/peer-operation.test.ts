import assert from "node:assert/strict";
import test from "node:test";
import protocol from "../../protocol/aiden-remote/v1/openapi.json";
import { peerOperationRequest, peerOperationResult } from "./peer-operation.js";

type Endpoint = {
  operationId?: string;
  parameters?: { $ref?: string }[];
};

/** Resolve a concrete request against the checked-in contract's route templates. */
function contractRoute(method: string, url: string) {
  const [pathname, search = ""] = url.split("?");
  for (const [template, methods] of Object.entries(protocol.paths)) {
    const shape = new RegExp(
      `^${template.replace(/\{[^}]+\}/gu, "[^/]+")}$`,
      "u",
    );
    if (!shape.test(pathname)) continue;
    const endpoint = (methods as Record<string, Endpoint>)[
      method.toLowerCase()
    ];
    if (!endpoint) continue;
    const refs = (endpoint.parameters ?? []).map((entry) => entry.$ref ?? "");
    return {
      operationId: endpoint.operationId,
      idempotent: refs.some((ref) => ref.endsWith("/IdempotencyKey")),
      conditional: refs.some((ref) => ref.endsWith("/IfMatch")),
      query: new URLSearchParams(search),
    };
  }
  return undefined;
}

const KEY = "aiden-0123456789abcdef";

test("expanded peer operations resolve to the contract's routes, not arbitrary URLs", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ operation: "messagesWindow", resourceId: "chat_1", before: "msg:9", limit: 50 }, "chatMessagesWindow"],
    [{ operation: "attachmentContent", resourceId: "chat_1", itemId: `a${"x".repeat(200)}` }, "getChatAttachmentContent"],
    [{ operation: "skills", resourceId: "chat_1" }, "getChatSkills"],
    [{ operation: "tasks", resourceId: "chat_1" }, "getChatTasks"],
    [{ operation: "agents", resourceId: "chat_1", turnId: "turn_2" }, "getChatAgents"],
    [{ operation: "streamQuestion", resourceId: "stream_1" }, "getStreamQuestion"],
    [{ operation: "bots", includeArchived: true }, "listBots"],
    [{ operation: "bot", resourceId: "bot_1" }, "getBot"],
    [{ operation: "botConversations", query: "release notes & more", botId: "bot_1", limit: 20 }, "listBotConversations"],
    [{ operation: "botCapabilities", botId: "bot_1" }, "getBotCapabilityCatalog"],
    [{ operation: "botChatAccess", resourceId: "chat_1" }, "getBotChatAccess"],
    [{ operation: "botFavorites" }, "getBotFavorites"],
    [{ operation: "markRead", resourceId: "chat_1", idempotencyKey: KEY, body: { throughMessageId: "m1" } }, "markChatRead"],
    [{ operation: "interruptAgent", resourceId: "chat_1", itemId: "agent_1", idempotencyKey: KEY }, "interruptChatAgent"],
    [{ operation: "respondQuestion", resourceId: "prompt_1", idempotencyKey: KEY }, "respondQuestion"],
    [{ operation: "inputs", resourceId: "stream_1", idempotencyKey: KEY }, "submitStreamInput"],
    [{ operation: "runCancel", resourceId: "run_1", idempotencyKey: KEY }, "cancelRun"],
    [{ operation: "runRespondApproval", resourceId: "run_1", itemId: "approval_1", idempotencyKey: KEY }, "respondRunApproval"],
    [{ operation: "runRespondQuestion", resourceId: "run_1", itemId: "prompt_1", idempotencyKey: KEY }, "respondRunQuestion"],
    [{ operation: "runInputs", resourceId: "run_1", idempotencyKey: KEY }, "submitRunInput"],
    [{ operation: "createBotChat", resourceId: "bot_1", idempotencyKey: KEY }, "createBotChat"],
    [{ operation: "updateBotFavorites", idempotencyKey: KEY, revision: "\"r1\"" }, "updateBotFavorites"],
    [{ operation: "updateBotChatAccess", resourceId: "chat_1", idempotencyKey: KEY, revision: "\"r2\"" }, "updateBotChatAccess"],
  ];
  for (const [operation, expected] of cases) {
    const request = peerOperationRequest(operation);
    const route = contractRoute(request.method ?? "GET", request.path);
    assert.equal(route?.operationId, expected, String(operation.operation));
    // Every declared Idempotency-Key / If-Match travels with the request.
    if (route?.idempotent) assert.equal(request.idempotencyKey, KEY);
    if (route?.conditional) assert.ok(request.revision);
  }
  const search = contractRoute(
    "GET",
    peerOperationRequest({
      operation: "botConversations",
      query: "release notes & more",
      limit: 20,
    }).path,
  );
  assert.equal(search?.query.get("query"), "release notes & more");
  assert.equal(search?.query.get("limit"), "20");
});

test("expanded peer mutations demand a client-minted key and reject malformed parameters", () => {
  for (const operation of [
    "markRead",
    "interruptAgent",
    "respondQuestion",
    "inputs",
    "runCancel",
    "runRespondApproval",
    "runRespondQuestion",
    "runInputs",
    "createBotChat",
  ])
    assert.throws(
      () =>
        peerOperationRequest({
          operation,
          resourceId: "resource_1",
          itemId: "item_1",
        }),
      Error,
      operation,
    );
  assert.throws(() =>
    peerOperationRequest({
      operation: "updateBotFavorites",
      idempotencyKey: KEY,
    }),
  );
  for (const invalid of [
    { operation: "messagesWindow", resourceId: "chat_1", limit: 0 },
    { operation: "messagesWindow", resourceId: "chat_1", limit: 201 },
    { operation: "messagesWindow", resourceId: "chat_1", before: "../x" },
    { operation: "botConversations", limit: 51 },
    { operation: "botConversations", query: "q".repeat(201) },
    { operation: "attachmentContent", resourceId: "chat_1", itemId: "a/b" },
    { operation: "runCancel", resourceId: "../../server", idempotencyKey: KEY },
    { operation: "bots", url: "https://elsewhere" },
  ])
    assert.throws(() => peerOperationRequest(invalid), JSON.stringify(invalid));
});

test("expanded peer reads reject malformed DTOs and attachment bytes stay bounded images", () => {
  for (const operation of [
    "messagesWindow",
    "skills",
    "tasks",
    "agents",
    "streamQuestion",
    "bots",
    "bot",
    "botConversations",
    "botCapabilities",
    "botChatAccess",
    "botFavorites",
    "markRead",
    "interruptAgent",
    "respondQuestion",
    "inputs",
    "runCancel",
    "runRespondApproval",
    "runRespondQuestion",
    "runInputs",
    "createBotChat",
    "updateBotFavorites",
    "updateBotChatAccess",
  ])
    assert.throws(() => peerOperationResult({ operation }, {}), operation);
  // `markRead` is a 204: only an empty body satisfies it.
  assert.equal(peerOperationResult({ operation: "markRead" }, undefined), undefined);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const content = peerOperationResult(
    { operation: "attachmentContent" },
    { mimeType: "image/png", data: png },
  ) as { mimeType: string; bytes: Uint8Array };
  assert.equal(content.mimeType, "image/png");
  assert.deepEqual([...content.bytes], [...png]);
  assert.ok(!Buffer.isBuffer(content.bytes));
  for (const invalid of [
    { mimeType: "text/html", data: png },
    { mimeType: "image/png", data: Buffer.alloc(0) },
    { mimeType: "image/png", data: "iVBOR" },
  ])
    assert.throws(() =>
      peerOperationResult({ operation: "attachmentContent" }, invalid),
    );
});
