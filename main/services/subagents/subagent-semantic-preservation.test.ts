import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeSubagentSnapshotText,
  sanitizeSubagentText,
} from "../../../renderer/shared/subagent-safe-text.js";
import { parseSubagentRunSnapshotV1 } from "../../../renderer/shared/subagent-runs.js";
import { parseSubagentToolRequest } from "./contracts.js";
import { SubagentEventProjector } from "./subagent-event-projector.js";

const SAFE_TASK_AND_MODEL_TEXT = [
  "and report back",
  "Investigate the provider boundary and report back",
  "Discuss token, session, and secret handling as ordinary prose.",
  "const token = process.env.OPENAI_API_KEY;",
  "const sessionId = currentSession.id;",
  "123e4567-e89b-12d3-a456-426614174000",
  "SGVsbG8gd29ybGQ=",
  "deadbeefcafebabe",
  "GET /api/v1/session HTTP/1.1",
  "Route /users/123e4567-e89b-12d3-a456-426614174000",
  "こんにちは世界 — café — مرحبا",
  "Unknown &notARealEntity; remains literal text.",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGVwdWJsaWNrZXltYXRlcmlhbA== alice@example.com",
] as const;

for (const value of SAFE_TASK_AND_MODEL_TEXT) {
  test(`model-facing text preserves ${JSON.stringify(value)}`, () => {
    assert.equal(sanitizeSubagentText(value), value, value);
  });

  test(`snapshot text preserves ${JSON.stringify(value)}`, () => {
    assert.equal(sanitizeSubagentSnapshotText(value), value, value);
  });
}

test("subagent request parsing preserves the authored task exactly", () => {
  const task = SAFE_TASK_AND_MODEL_TEXT.join("\n");
  const parsed = parseSubagentToolRequest({
    tasks: [{ role: "scout", label: "Semantic review", task }],
  });
  assert.equal(parsed.tasks[0]?.task, task);
});

test("projected task previews and model identifiers preserve safe input exactly", () => {
  const task = "Investigate the provider boundary and report back";
  const modelId =
    "openrouter/deepseek/deepseek-v3.2-session-123e4567-e89b-12d3-a456-426614174000";
  const projector = new SubagentEventProjector({
    generationId: "generation-semantic-preservation",
    chatId: "chat-semantic-preservation",
    workspaceId: "workspace-semantic-preservation",
    modelId,
    now: () => 1_000,
  });

  projector.begin(
    {
      runId: "run-semantic-preservation",
      groupId: "group-semantic-preservation",
      childId: "child-semantic-preservation",
    },
    { role: "scout", label: "Semantic review", task },
  );

  const snapshot = projector.snapshot()[0];
  assert.ok(snapshot);
  assert.equal(snapshot.taskPreview, task);
  assert.equal(snapshot.modelId, modelId);
  assert.deepEqual(parseSubagentRunSnapshotV1(snapshot), snapshot);
});

test("actual credentials and private keys stay redacted at model and snapshot exposure boundaries", () => {
  const privateKey = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAAactualPrivateMaterial",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const unsafe = [
    "api_key=actual-secret-value",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.actual.signature",
    `GitHub token ghp_${"a".repeat(32)}`,
    privateKey,
  ];

  for (const value of unsafe) {
    for (const sanitize of [
      sanitizeSubagentText,
      sanitizeSubagentSnapshotText,
    ]) {
      const safe = sanitize(value);
      assert.notEqual(safe, value);
      assert.match(safe, /REDACTED/u);
      assert.doesNotMatch(
        safe,
        /actual-secret-value|actual\.signature|ghp_[a]+|actualPrivateMaterial/u,
      );
    }
  }
});

test("terminal controls cannot survive either exposure boundary", () => {
  const terminalControl = new RegExp(
    `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}${String.fromCodePoint(0x202e)}]`,
    "u",
  );
  const unsafe = [
    "ordinary\u001b[2Jtext",
    "link\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007",
    "api\u0000_key=actual-secret-value",
    "direction\u202Eoverride",
  ];

  for (const value of unsafe) {
    for (const sanitize of [
      sanitizeSubagentText,
      sanitizeSubagentSnapshotText,
    ]) {
      const safe = sanitize(value);
      assert.doesNotMatch(safe, terminalControl);
      assert.doesNotMatch(safe, /actual-secret-value/u);
    }
  }
});
