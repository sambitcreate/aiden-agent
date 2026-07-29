import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import {
  isSafeSubagentIdentifier,
  parseSubagentMessageReferenceV1,
  parseSubagentRunSnapshotV1,
  subagentMessageReference,
  type SubagentRunSnapshotV1,
} from "../../../renderer/shared/subagent-runs.js";

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

function snapshot(overrides: Partial<SubagentRunSnapshotV1> = {}): SubagentRunSnapshotV1 {
  return {
    version: 1,
    runId: "run-1",
    groupId: "group-1",
    generationId: "generation-1",
    childId: "child-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    revision: 1,
    role: "reviewer",
    label: "Privacy review",
    taskPreview: "Review renderer-safe identifiers.",
    state: "completed",
    startedAt: 10,
    updatedAt: 20,
    finishedAt: 20,
    modelId: "test-model",
    turns: 1,
    tools: 0,
    tokens: 10,
    warnings: [],
    ...overrides,
  };
}

const rawSecret = "sk-abcdefghijklmno";
const urlEncodedSecret = Buffer.from(rawSecret, "utf8").toString("base64url");
const secretIdentifiers = [
  rawSecret,
  Buffer.from(rawSecret, "utf8").toString("base64").replace(/=+$/u, ""),
  base32(rawSecret),
  `run-${urlEncodedSecret}-suffix`,
  splitEncoding(urlEncodedSecret),
  splitEncoding(base32("/Users/alice/private.txt")),
  splitEncoding(Buffer.from("OPENAI_API_KEY=correct-horse-battery-staple", "utf8").toString("hex")),
];
const snapshotIdentifierKeys = [
  "runId",
  "groupId",
  "generationId",
  "childId",
  "chatId",
  "workspaceId",
] as const;

test("every renderer-safe snapshot identifier rejects raw and reversibly encoded secrets", () => {
  assert.equal(isSafeSubagentIdentifier("s-mixed_case.1:child-2"), true);
  assert.equal(isSafeSubagentIdentifier("run-550e8400-e29b-41d4-a716-446655440000"), true);
  for (const unsafe of secretIdentifiers) {
    assert.equal(isSafeSubagentIdentifier(unsafe), false, unsafe);
    for (const key of snapshotIdentifierKeys) {
      assert.equal(
        parseSubagentRunSnapshotV1(snapshot({ [key]: unsafe })),
        undefined,
        `${key} accepted ${unsafe}`,
      );
    }
  }
});

test("realistic prefixed identifiers cannot frame a URL-Base64 secret", () => {
  const privateIdentifiers: Record<(typeof snapshotIdentifierKeys)[number], string> = {
    runId: `run-${urlEncodedSecret}-01`,
    groupId: `group-${urlEncodedSecret}-reviewers`,
    generationId: `generation-${urlEncodedSecret}-stream`,
    childId: `child-${urlEncodedSecret}-reviewer`,
    chatId: `chat-${urlEncodedSecret}-active`,
    workspaceId: `workspace-${urlEncodedSecret}-main`,
  };
  for (const [key, unsafe] of Object.entries(privateIdentifiers) as Array<
    [(typeof snapshotIdentifierKeys)[number], string]
  >) {
    assert.equal(isSafeSubagentIdentifier(unsafe), false, `${key} accepted ${unsafe}`);
    assert.equal(parseSubagentRunSnapshotV1(snapshot({ [key]: unsafe })), undefined);
  }

  const validReference = {
    version: 1,
    generationId: "generation-550e8400-e29b-41d4-a716-446655440000",
    runIds: ["run-550e8400-e29b-41d4-a716-446655440000"],
    total: 1,
    completed: 1,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  };
  assert.deepEqual(parseSubagentMessageReferenceV1(validReference), validReference);
  assert.equal(
    parseSubagentMessageReferenceV1({
      ...validReference,
      generationId: privateIdentifiers.generationId,
    }),
    undefined,
  );
  assert.equal(
    parseSubagentMessageReferenceV1({
      ...validReference,
      runIds: [privateIdentifiers.runId],
    }),
    undefined,
  );
});

test("allowed identifier separators cannot split reversible private encodings", () => {
  for (const unsafe of secretIdentifiers.slice(-3)) {
    assert.equal(isSafeSubagentIdentifier(unsafe), false, unsafe);
    for (const key of snapshotIdentifierKeys) {
      assert.equal(parseSubagentRunSnapshotV1(snapshot({ [key]: unsafe })), undefined);
    }
  }
});

test("assistant-message references reject private generation and run identifiers", () => {
  const valid = {
    version: 1,
    generationId: "generation-1",
    runIds: ["run-1", "run-2"],
    total: 2,
    completed: 2,
    failed: 0,
    timedOut: 0,
    interrupted: 0,
  };
  assert.deepEqual(parseSubagentMessageReferenceV1(valid), valid);
  for (const unsafe of secretIdentifiers) {
    assert.equal(
      parseSubagentMessageReferenceV1({ ...valid, generationId: unsafe }),
      undefined,
      `generationId accepted ${unsafe}`,
    );
    assert.equal(
      parseSubagentMessageReferenceV1({ ...valid, runIds: ["run-1", unsafe] }),
      undefined,
      `runIds accepted ${unsafe}`,
    );
    assert.equal(subagentMessageReference(unsafe, [snapshot({ generationId: unsafe })]), undefined);
    assert.equal(
      subagentMessageReference("generation-1", [snapshot({ runId: unsafe })]),
      undefined,
    );
  }
});

test("enriched assistant-message references are exact, bounded, and cross-checked", () => {
  const valid = {
    version: 1,
    generationId: "generation-1",
    runIds: ["run-1", "run-2"],
    items: [
      { runId: "run-1", label: "Plan", role: "planner", state: "completed" },
      { runId: "run-2", label: "Review", role: "reviewer", state: "failed" },
    ],
    total: 2,
    completed: 1,
    failed: 1,
    timedOut: 0,
    interrupted: 0,
  };
  assert.deepEqual(parseSubagentMessageReferenceV1(valid), valid);
  assert.equal(
    parseSubagentMessageReferenceV1({
      ...valid,
      items: [...valid.items].reverse(),
    }),
    undefined,
  );
  assert.equal(
    parseSubagentMessageReferenceV1({
      ...valid,
      items: [{ ...valid.items[0], state: "failed" }, valid.items[1]],
    }),
    undefined,
  );
  assert.equal(
    parseSubagentMessageReferenceV1({
      ...valid,
      items: [{ ...valid.items[0], task: "private task" }, valid.items[1]],
    }),
    undefined,
  );
  assert.equal(
    parseSubagentMessageReferenceV1({
      ...valid,
      items: [{ ...valid.items[0], label: "/Users/alice/private.txt" }, valid.items[1]],
    }),
    undefined,
  );
  assert.equal(
    parseSubagentMessageReferenceV1({
      ...valid,
      items: [{ ...valid.items[0], state: "running" }, valid.items[1]],
    }),
    undefined,
  );
});

test("new assistant-message references include one bounded terminal item per unique run", () => {
  const reference = subagentMessageReference("generation-1", [
    snapshot({ runId: "run-1", label: "First" }),
    snapshot({ runId: "run-1", revision: 2, label: "Duplicate" }),
    snapshot({
      runId: "run-2",
      role: "planner",
      label: "Second",
      state: "interrupted",
    }),
    snapshot({
      runId: "run-active",
      label: "Active",
      state: "running",
      finishedAt: undefined,
    }),
  ]);
  assert.deepEqual(reference, {
    version: 1,
    generationId: "generation-1",
    runIds: ["run-1", "run-2"],
    items: [
      { runId: "run-1", label: "First", role: "reviewer", state: "completed" },
      { runId: "run-2", label: "Second", role: "planner", state: "interrupted" },
    ],
    total: 2,
    completed: 1,
    failed: 0,
    timedOut: 0,
    interrupted: 1,
  });
});

test("chat:start rejects renderer-controlled private generation identifiers before starting", () => {
  const source = fs.readFileSync(new URL("../../handlers/chat.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(!isSafeSubagentIdentifier\(id\)\) \{\s+throw new Error\("Invalid chat stream identifier\."\);/u,
  );
  assert.ok(
    source.indexOf("if (!isSafeSubagentIdentifier(id))") <
      source.indexOf("const parsed = parseParams(params)"),
  );
  assert.match(
    source,
    /ipcMain\.handle\("chat:cancel"[\s\S]*?if \(!isSafeSubagentIdentifier\(streamId\)\) \{\s+throw new Error\("Invalid chat stream identifier\."\);/u,
  );
  for (const unsafe of secretIdentifiers) {
    assert.equal(isSafeSubagentIdentifier(unsafe), false);
  }
});
