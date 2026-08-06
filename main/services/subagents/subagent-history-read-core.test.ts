import assert from "node:assert/strict";
import test from "node:test";
import type {
  SubagentRunSnapshotV1,
  SubagentRunSnapshotV2,
} from "../../../renderer/shared/subagent-runs.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  parseSubagentHistoryRequestIds,
  readSubagentHistoryDetailForOwner,
  readSubagentHistoryForOwner,
} from "./subagent-history-read-core.js";

function base32(value: string): string {
  let bits = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    bits = bits * 256 + byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const divisor = 2 ** bitCount;
      encoded += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(bits / divisor) & 31];
      bits %= divisor;
    }
  }
  if (bitCount > 0) {
    encoded += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(bits * 2 ** (5 - bitCount)) & 31];
  }
  return encoded;
}

function splitEncoding(value: string): string {
  return value.match(/.{1,4}/gu)!.join(".");
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    groupId: "generation-1:group-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "reviewer",
    label: "Review",
    taskPreview: "Review the workspace.",
    state: "completed",
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2,
    modelId: "test-model",
    turns: 1,
    tools: 0,
    tokens: 1,
    warnings: [],
  };
}

function fakeOwner() {
  let invalidated = false;
  let subscribed = false;
  let removed = false;
  const listeners = new Set<() => void>();
  const owner: RendererDocumentOwner = {
    id: 1,
    documentId: "1:1:document",
    isDestroyed: () => invalidated,
    send: () => {
      if (invalidated) throw new Error("The renderer document is no longer active.");
    },
    onInvalidated: (listener) => {
      subscribed = true;
      listeners.add(listener);
      return () => {
        removed = true;
        listeners.delete(listener);
      };
    },
  };
  return {
    owner,
    invalidate: () => {
      invalidated = true;
      for (const listener of [...listeners]) listener();
    },
    subscribed: () => subscribed,
    removed: () => removed,
  };
}

const chat = {
  id: "chat-1",
  workspaceId: "workspace-1",
  messages: [
    {
      role: "assistant",
      subagents: {
        version: 1,
        generationId: "generation-1",
        runIds: ["run-1"],
      },
    },
  ],
};

test("history request IDs reject private encodings before store lookup", () => {
  const raw = "sk-proj-abcdefghijklmno";
  const base64url = Buffer.from(raw, "utf8").toString("base64url");
  const base32Value = base32(raw);
  const nested = Buffer.from(base32Value, "utf8").toString("base64url");
  const unsafe = [
    raw,
    base64url,
    base32Value,
    nested,
    `run-${base64url}-suffix`,
    splitEncoding(base64url),
    splitEncoding(base32("/Users/alice/private.txt")),
    splitEncoding(Buffer.from("OPENAI_API_KEY=correct-horse-battery-staple", "utf8").toString("hex")),
  ];
  for (const identifier of unsafe) {
    assert.throws(
      () => parseSubagentHistoryRequestIds(identifier, "run-valid"),
      /Invalid subagent history request/u,
    );
    assert.throws(
      () => parseSubagentHistoryRequestIds("chat-valid", identifier),
      /Invalid subagent history request/u,
    );
  }
  assert.deepEqual(
    parseSubagentHistoryRequestIds(
      "chat-550e8400-e29b-41d4-a716-446655440000",
      "run-550e8400-e29b-41d4-a716-446655440000",
    ),
    {
      chatId: "chat-550e8400-e29b-41d4-a716-446655440000",
      runId: "run-550e8400-e29b-41d4-a716-446655440000",
    },
  );
});

test("an in-flight history read cannot cross navigation after the chat read starts", async () => {
  const owner = fakeOwner();
  const chatRead = deferred<typeof chat>();
  let snapshotReads = 0;
  const reading = readSubagentHistoryForOwner(owner.owner, "chat-1", "run-1", {
    getChat: () => chatRead.promise,
    getSnapshot: async () => {
      snapshotReads += 1;
      return snapshot();
    },
  });
  assert.equal(owner.subscribed(), true);

  owner.invalidate();
  chatRead.resolve(chat);

  await assert.rejects(reading, /renderer document is no longer active/u);
  assert.equal(snapshotReads, 0);
  assert.equal(owner.removed(), true);
});

test("an in-flight history read cannot return a snapshot after navigation", async () => {
  const owner = fakeOwner();
  const snapshotRead = deferred<SubagentRunSnapshotV1>();
  const reading = readSubagentHistoryForOwner(owner.owner, "chat-1", "run-1", {
    getChat: async () => chat,
    getSnapshot: () => snapshotRead.promise,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  owner.invalidate();
  snapshotRead.resolve(snapshot());

  await assert.rejects(reading, /renderer document is no longer active/u);
  assert.equal(owner.removed(), true);
});

test("history rejects a mismatched chat identity before reading the snapshot store", async () => {
  const owner = fakeOwner();
  let snapshotReads = 0;
  const result = await readSubagentHistoryForOwner(owner.owner, "chat-1", "run-1", {
    getChat: async () => ({ ...chat, id: "different-chat-id" }),
    getSnapshot: async () => {
      snapshotReads += 1;
      return snapshot();
    },
  });

  assert.equal(result, null);
  assert.equal(snapshotReads, 0);
  assert.equal(owner.removed(), true);
});

test("an active exact owner can read its referenced snapshot", async () => {
  const owner = fakeOwner();
  const result = await readSubagentHistoryForOwner(owner.owner, "chat-1", "run-1", {
    getChat: async () => chat,
    getSnapshot: async () => snapshot(),
  });

  assert.deepEqual(result, snapshot());
  assert.equal(owner.removed(), true);
});

test("history detail remains owner-checked across bounded effect projection", async () => {
  const owner = fakeOwner();
  const result = await readSubagentHistoryDetailForOwner(
    owner.owner,
    "chat-1",
    "run-1",
    {
      getChat: async () => chat,
      getSnapshot: async () => snapshot(),
      getEffectActivity: async () => [{
        version: 1,
        kind: "shell",
        state: "unknown",
        label: "Command outcome unknown. Check the workspace before retrying.",
        updatedAt: 3,
      }],
    },
  );
  assert.equal(result?.snapshot.runId, "run-1");
  assert.equal(result?.effects[0]?.state, "unknown");

  const invalidated = fakeOwner();
  const effects = deferred<[]>();
  const reading = readSubagentHistoryDetailForOwner(
    invalidated.owner,
    "chat-1",
    "run-1",
    {
      getChat: async () => chat,
      getSnapshot: async () => snapshot(),
      getEffectActivity: () => effects.promise,
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  invalidated.invalidate();
  effects.resolve([]);
  await assert.rejects(reading, /renderer document is no longer active/u);
});

test("an active exact owner retains native V2 context metadata", async () => {
  const owner = fakeOwner();
  const v2: SubagentRunSnapshotV2 = {
    ...snapshot(),
    version: 2,
    depth: 1,
    execution: "foreground",
    context: "fork",
    authorityRevision: 1,
  };
  const result = await readSubagentHistoryForOwner(owner.owner, "chat-1", "run-1", {
    getChat: async () => chat,
    getSnapshot: async () => v2,
  });

  assert.deepEqual(result, v2);
  assert.equal(owner.removed(), true);
});
