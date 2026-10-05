import assert from "node:assert/strict";
import test from "node:test";
import protocol from "../../protocol/aiden-remote/v1/openapi.json";
import contract from "../../protocol/aiden-remote/v1/fixtures/contract.json";
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
    [{ operation: "uploadAttachment", resourceId: "chat_1", body: { name: "a.txt" } }, "uploadChatAttachment"],
    [{ operation: "removeAttachment", resourceId: "chat_1", itemId: `att_${"A".repeat(43)}` }, "removeChatAttachment"],
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
    { operation: "removeAttachment", resourceId: "chat_1", itemId: "att_short" },
    { operation: "removeAttachment", resourceId: "chat_1", itemId: `../${"A".repeat(43)}` },
  ])
    assert.throws(() => peerOperationRequest(invalid), JSON.stringify(invalid));
});

test("only an attachment upload may send a body past the 1 MiB JSON cap", () => {
  const upload = peerOperationRequest({ operation: "uploadAttachment", resourceId: "chat_1", body: {} });
  assert.ok((upload.maxBodyBytes ?? 0) >= 12 * 1024 * 1024);
  // Staged uploads expire unused, so the upload carries no idempotency key.
  assert.equal(upload.idempotencyKey, undefined);
  for (const operation of [
    { operation: "send", resourceId: "chat_1", idempotencyKey: KEY, body: { text: "hi" } },
    { operation: "createChat", idempotencyKey: KEY, body: { workspaceId: "ws" } },
    { operation: "createWorkspace", idempotencyKey: KEY, body: { mode: "scratch" } },
    { operation: "removeAttachment", resourceId: "chat_1", itemId: `att_${"A".repeat(43)}` },
  ])
    assert.equal(peerOperationRequest(operation).maxBodyBytes, undefined, operation.operation);
});

test("expanded peer reads reject malformed DTOs and attachment bytes stay bounded images", async () => {
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
    "uploadAttachment",
    "removeAttachment",
  ])
    await assert.rejects(peerOperationResult({ operation }, {}), operation);
  const staged = {
    id: `att_${"A".repeat(43)}`,
    name: "notes.md",
    mimeType: "text/markdown",
    kind: "text",
    size: 12,
    expiresAt: "2026-10-03T12:10:00.000Z",
  };
  assert.deepEqual(await peerOperationResult({ operation: "uploadAttachment" }, staged), staged);
  assert.equal(await peerOperationResult({ operation: "removeAttachment" }, undefined), undefined);
  // `markRead` is a 204: only an empty body satisfies it.
  assert.equal(await peerOperationResult({ operation: "markRead" }, undefined), undefined);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const content = (await peerOperationResult(
    { operation: "attachmentContent" },
    { mimeType: "image/png", data: png },
  )) as { mimeType: string; bytes: Uint8Array };
  assert.equal(content.mimeType, "image/png");
  assert.deepEqual([...content.bytes], [...png]);
  assert.ok(!Buffer.isBuffer(content.bytes));
  for (const invalid of [
    { mimeType: "text/html", data: png },
    { mimeType: "image/png", data: Buffer.alloc(0) },
    { mimeType: "image/png", data: "iVBOR" },
  ])
    await assert.rejects(
      peerOperationResult({ operation: "attachmentContent" }, invalid),
    );
});

test("fork operations reach the contract's fork routes with the headers each one declares", () => {
  const fork = peerOperationRequest({
    operation: "forkChat",
    resourceId: "chat_1",
    body: contract.chatFork.fork.request,
    idempotencyKey: KEY,
    revision: "rev_1",
  });
  const route = contractRoute(fork.method ?? "GET", fork.path);
  assert.equal(route?.operationId, "forkChat");
  assert.equal(fork.method, "POST");
  assert.ok(route?.idempotent && route.conditional, "the contract keys and conditions a fork");
  assert.equal(fork.idempotencyKey, KEY);
  assert.equal(fork.revision, "rev_1");
  assert.deepEqual(fork.body, contract.chatFork.fork.request);

  for (const [operation, action] of [
    ["forkSummaryRetry", "retry"],
    ["forkSummarySkip", "skip"],
    ["forkSummaryCancel", "cancel"],
  ] as const) {
    const request = peerOperationRequest({ operation, resourceId: "chat_1" });
    assert.equal(request.path, `/chats/chat_1/fork-summary/${action}`);
    const summaryRoute = contractRoute(request.method ?? "GET", request.path);
    assert.equal(summaryRoute?.operationId, "chatForkSummaryAction", operation);
    // The contract declares neither header, and the host reads no body.
    assert.equal(summaryRoute?.idempotent, false);
    assert.equal(summaryRoute?.conditional, false);
    assert.equal(request.idempotencyKey, undefined);
    assert.equal(request.revision, undefined);
    assert.deepEqual(request.body, {});
  }
});

test("a fork without its key, revision or a well-formed cut point never leaves this Mac", () => {
  const valid = {
    operation: "forkChat",
    resourceId: "chat_1",
    body: { messageId: "m1", position: "before" },
    idempotencyKey: KEY,
    revision: "rev_1",
  };
  assert.doesNotThrow(() => peerOperationRequest(valid));
  const { idempotencyKey: _key, ...unkeyed } = valid;
  const { revision: _revision, ...unconditional } = valid;
  for (const invalid of [
    unkeyed,
    unconditional,
    { ...valid, idempotencyKey: "short" },
    { ...valid, body: undefined },
    { ...valid, body: { messageId: "m1" } },
    { ...valid, body: { messageId: "m1", position: "middle" } },
    { ...valid, body: { messageId: "../m1", position: "after" } },
    { ...valid, body: { messageId: "m1", position: "after", extra: true } },
    // The desktop's internal name for the focus is not part of the wire.
    { ...valid, body: { messageId: "m1", position: "after", summary: { instructions: "x" } } },
    { ...valid, body: { messageId: "m1", position: "after", summary: { focus: "   " } } },
    { ...valid, body: { messageId: "m1", position: "after", summary: { focus: "x".repeat(1001) } } },
    { ...valid, resourceId: "../server" },
    { operation: "forkSummaryRetry", resourceId: "chat_1", body: { force: true } },
  ])
    assert.throws(() => peerOperationRequest(invalid), JSON.stringify(invalid));
  // At the bound, and with no focus at all, a summary request is accepted.
  for (const summary of [{}, { focus: "x".repeat(1000) }])
    assert.deepEqual(
      peerOperationRequest({ ...valid, body: { messageId: "m1", position: "after", summary } }).body,
      { messageId: "m1", position: "after", summary },
    );
});

test("fork answers are parsed into the contract's chat and prefill shapes", async () => {
  // Restaged attachments carry IDs the host minted for uploads.
  const restaged = `att_${"B".repeat(43)}`;
  const editFork = contract.chatFork.editFork.response;
  const edited = (await peerOperationResult(
    { operation: "forkChat" },
    {
      ...editFork,
      prefill: { ...editFork.prefill, attachments: editFork.prefill.attachments.map((entry) => ({ ...entry, id: restaged })) },
    },
  )) as { chat: { id: string; forkedFrom?: { position: string } }; prefill?: { text: string; attachments?: { id: string }[] } };
  assert.equal(edited.chat.id, "chat_fixture_fork_02");
  assert.equal(edited.chat.forkedFrom?.position, "before");
  assert.equal(edited.prefill?.text, "Now check the error codes.");
  assert.deepEqual(edited.prefill?.attachments?.map((attachment) => attachment.id), [restaged]);

  const summarized = (await peerOperationResult(
    { operation: "forkSummaryRetry" },
    contract.chatFork.fork.response.chat,
  )) as { forkedFrom?: { summary?: { state: string } } };
  assert.equal(summarized.forkedFrom?.summary?.state, "pending");
  assert.deepEqual(
    await peerOperationResult({ operation: "forkSummaryCancel" }, contract.chatFork.summaryCancel),
    { cancelled: true },
  );

  // A fork answer without lineage, or a cancel answer that is not a chat or {cancelled}, is refused.
  const { forkedFrom: _lineage, ...plain } = contract.chatFork.fork.response.chat;
  await assert.rejects(peerOperationResult({ operation: "forkChat" }, { chat: plain }));
  for (const operation of ["forkChat", "forkSummaryRetry", "forkSummarySkip", "forkSummaryCancel"])
    await assert.rejects(peerOperationResult({ operation }, {}), operation);
  await assert.rejects(peerOperationResult({ operation: "forkSummaryCancel" }, { cancelled: "yes" }));
});
