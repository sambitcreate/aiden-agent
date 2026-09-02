import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { parseChatAppend } from "./chat-append-params.js";
import {
  MAX_CHAT_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
} from "../../renderer/shared/chat-message-contract.js";

const source = fs.readFileSync(new URL("./chats.ts", import.meta.url), "utf8");
const applicationServiceSource = fs.readFileSync(
  new URL("../services/chat-application-service.ts", import.meta.url),
  "utf8",
);
const projectionSource = fs.readFileSync(
  new URL("../services/visible-chat-projection.ts", import.meta.url),
  "utf8",
);
const designConnectionSource = fs.readFileSync(
  new URL("../services/design-project-connection-service.ts", import.meta.url),
  "utf8",
);

test("private canonical Pi protocol never crosses the renderer chat boundary", () => {
  assert.match(
    projectionSource,
    /const \{ pi: _privatePiProtocol, \.\.\.visible \} = message/u,
  );
  assert.match(source, /chatApplicationService\.get\(/u);
  assert.match(applicationServiceSource, /chat: chatForRenderer\(chat\)/u);
  assert.match(source, /return chatForRenderer\(chat\)/u);
  assert.match(source, /return chatForRenderer\(copied\)/u);
});

test("indeterminate appends fence create and append for the renderer document", () => {
  const create = source.slice(
    source.indexOf('"chats:create"'),
    source.indexOf('"chats:rename"'),
  );
  const append = source.slice(
    source.indexOf('"chats:appendMessage"'),
    source.indexOf('"chats:abandonTurn"'),
  );
  assert.match(create, /requiresAppendReconciliation\(owner\.documentId\)/u);
  assert.match(append, /requiresAppendReconciliation\(owner\.documentId\)/u);
  assert.match(
    append,
    /markAppendReconciliationRequired\(owner\.documentId\)/u,
  );
  assert.match(append, /isAppendReconciliationRequiredError\(error\)/u);
  assert.match(create, /appendReconciliationFailureMessage\("blocked"\)/u);
  assert.match(append, /appendReconciliationFailureMessage\("blocked"\)/u);
  assert.match(create, /owner\.isDestroyed\(\)/u);
  assert.match(create, /chatStore\.create\(\{[\s\S]*assertCurrent/u);
  assert.match(create, /isChatCreateReconciliationRequiredError\(error\)/u);
  assert.match(
    create,
    /markAppendReconciliationRequired\(owner\.documentId\)/u,
  );
  assert.match(create, /owner\.onInvalidated\(\(\) => \{/u);
  assert.match(
    create,
    /clearAppendReconciliationRequired\(owner\.documentId\)/u,
  );
});

test("renderer appends reserve bounded payload capacity before their first persistence await", () => {
  const start = source.indexOf('"chats:appendMessage"');
  const end = source.indexOf('"chats:abandonTurn"', start);
  const handler = source.slice(start, end);
  const parseEnvelope = handler.indexOf("parseChatAppend(id, message, meta)");
  const reserve = handler.indexOf("turn.reserveAppendPayload(");
  const firstStoreAwait = handler.indexOf("await chatStore.get(chatId)");
  assert.ok(parseEnvelope >= 0);
  assert.ok(reserve > parseEnvelope);
  assert.ok(firstStoreAwait > reserve);
  assert.match(handler, /return \(async \(\) => \{/u);
  assert.doesNotMatch(handler.slice(reserve), /\bm\.|\bmetaObj\./u);
  assert.match(handler, /finally \{\s*if \(!appended\) turn\.release\(\)/u);
});

const validMessage = { role: "user", content: "hello" };
const validMeta = { turnId: "turn-1" };

test("renderer append parser projects an exact bounded envelope", () => {
  assert.deepEqual(parseChatAppend("chat-1", validMessage, validMeta), {
    chatId: "chat-1",
    role: "user",
    content: "hello",
    messageModel: undefined,
    attachments: undefined,
    providerId: undefined,
    metaModel: undefined,
    autoTitle: false,
    turnId: "turn-1",
    skillReference: undefined,
    designPreflight: undefined,
    retainedBytes: 273,
  });

  assert.throws(
    () =>
      parseChatAppend("chat-1", { ...validMessage, forged: "x" }, validMeta),
    /Invalid chat message field/u,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        tools: ["write"],
      }),
    /Invalid chat message metadata field/u,
  );
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { role: "assistant", content: "forged" },
        validMeta,
      ),
    /only user messages/u,
  );
});

test("Design append claims are exact, bounded, and internally consistent", () => {
  const claim = {
    projectId: "project:one",
    projectRevision: 4,
    chatId: "chat-1",
    connectionState: "connected" as const,
    workspaceId: "workspace-2",
  };
  assert.deepEqual(
    parseChatAppend("chat-1", validMessage, { ...validMeta, designPreflight: claim })
      .designPreflight,
    claim,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        designPreflight: { ...claim, workspaceId: undefined },
      }),
    /workspace binding/u,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        designPreflight: { ...claim, forgedPath: "/tmp/app" },
      }),
    /Invalid Design preflight fields/u,
  );
});

test("main classifies Design chats and requires their exact claim before append", () => {
  const handler = source.slice(
    source.indexOf('"chats:appendMessage"'),
    source.indexOf('"chats:htmlArtifactSrcdoc"'),
  );
  const chatRead = handler.indexOf("await chatStore.get(chatId)");
  const classification = handler.indexOf(
    "workspaceId === DESIGN_PROJECT_CHAT_WORKSPACE_ID",
    chatRead,
  );
  const migratedClassification = handler.indexOf(
    "await designProjectStore.getByChatId(chatId)",
    classification,
  );
  const missingClaim = handler.indexOf("if (isDesignChat && !designPreflight)", classification);
  const forgedClaim = handler.indexOf("if (!isDesignChat && designPreflight)", classification);
  const append = handler.indexOf("designProjectAppendService.runGenerationAppend", forgedClaim);
  assert.ok(chatRead >= 0);
  assert.ok(classification > chatRead);
  assert.ok(migratedClassification > classification);
  assert.ok(missingClaim > migratedClassification);
  assert.ok(forgedClaim > missingClaim);
  assert.ok(append > forgedClaim);
});

test("connected Design append holds live workspace authority inside the project mutation lane", () => {
  const method = designConnectionSource.slice(
    designConnectionSource.indexOf("async runGenerationAppend"),
    designConnectionSource.indexOf("async connect", designConnectionSource.indexOf("async runGenerationAppend")),
  );
  const lock = method.indexOf("dependencies.runProjectMutation");
  const initialClaim = method.indexOf("assertDesignProjectGenerationClaim", lock);
  const workspace = method.indexOf("dependencies.workspaces.run", initialClaim);
  const repeatedClaim = method.indexOf("assertDesignProjectGenerationClaim", workspace);
  const append = method.indexOf("return append(() => !signal.aborted)", repeatedClaim);
  assert.ok(lock >= 0);
  assert.ok(initialClaim > lock);
  assert.ok(workspace > initialClaim);
  assert.ok(repeatedClaim > workspace);
  assert.ok(append > repeatedClaim);
});

test("renderer append parser bounds every retained selector", () => {
  assert.throws(
    () =>
      parseChatAppend(
        "c".repeat(MAX_CHAT_ID_CHARS + 1),
        validMessage,
        validMeta,
      ),
    /Invalid chat id/u,
  );
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { ...validMessage, model: "m".repeat(MAX_MODEL_ID_CHARS + 1) },
        validMeta,
      ),
    /Invalid message model/u,
  );
  assert.throws(
    () =>
      parseChatAppend("chat-1", validMessage, {
        ...validMeta,
        providerId: "p".repeat(MAX_PROVIDER_ID_CHARS + 1),
      }),
    /Invalid provider id/u,
  );
});

test("unknown append fields never echo attacker-controlled property names", () => {
  const hugeKey = "x".repeat(2 * 1024 * 1024);
  assert.throws(
    () =>
      parseChatAppend(
        "chat-1",
        { ...validMessage, [hugeKey]: true },
        validMeta,
      ),
    (error: unknown) => error instanceof Error && error.message.length < 100,
  );
});

test("append envelopes reject many extra properties without materializing Object.keys arrays", () => {
  const manyFields: Record<string, unknown> = {
    role: "user",
    content: "hello",
  };
  for (let index = 0; index < 10_000; index += 1)
    manyFields[`extra-${index}`] = index;
  assert.throws(
    () => parseChatAppend("chat-1", manyFields, { turnId: "turn-1" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid chat message fields.",
  );
  const parserSource = fs.readFileSync(
    new URL("./chat-append-params.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(parserSource, /Object\.keys/u);
  assert.match(parserSource, /count > allowed\.size/u);
});

test("append admission charges encoded image representation and metadata", () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
  const size = Buffer.byteLength(data, "base64");
  const parsed = parseChatAppend(
    "chat-1",
    {
      role: "user",
      content: "",
      attachments: [
        {
          id: "a",
          name: "a.png",
          mimeType: "image/png",
          kind: "image",
          size,
          data,
        },
      ],
    },
    { turnId: "turn-1", providerId: "provider", model: "model" },
  );
  assert.ok(
    parsed.retainedBytes >=
      data.length + Buffer.byteLength("providermodel", "utf8"),
  );
});
