import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeSubagentSnapshotText,
  sanitizeSubagentSnapshotTextWithFacts,
  sanitizeSubagentText,
} from "../../../renderer/shared/subagent-safe-text.js";
import { parseSubagentRunSnapshotV1 } from "../../../renderer/shared/subagent-runs.js";
import { parseSubagentToolRequest } from "./contracts.js";
import { SubagentEventProjector } from "./subagent-event-projector.js";
import { sanitizeSubagentWorkText } from "./subagent-work-text-filter.js";

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

test("snapshot sanitizer reports replacements without inferring from literal markers", () => {
  const literal = "Document [REDACTED] and [REDACTED ENCODED TEXT] literally.";
  assert.deepEqual(sanitizeSubagentSnapshotTextWithFacts(literal), {
    text: literal,
    privacyReplacement: false,
  });

  const credential = sanitizeSubagentSnapshotTextWithFacts(
    "Document [REDACTED] then token=actual-secret-value",
  );
  assert.equal(credential.text, "Document [REDACTED] then token=[REDACTED]");
  assert.equal(credential.privacyReplacement, true);

  const encoded = Buffer.from("OPENAI_API_KEY=actual-secret-value").toString("base64");
  assert.deepEqual(
    sanitizeSubagentSnapshotTextWithFacts(`Literal [REDACTED ENCODED TEXT] ${encoded}`),
    { text: "[REDACTED ENCODED TEXT]", privacyReplacement: true },
  );
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

const IMPLEMENTER_TASK_WITH_LABEL_BLOCKS = [
  "Add cooking times to cookbook.html.",
  "",
  "JSON:",
  '  {"recipes": [{"name": "Dal", "minutes": 40}]}',
  "TASK:",
  "  Keep the layout; add a time badge.",
  "Report the files you changed.",
].join("\n");

test("a task with JSON: and TASK: label blocks shows in full in the saved panel view", () => {
  const projector = new SubagentEventProjector({
    generationId: "generation-label-blocks",
    chatId: "chat-label-blocks",
    workspaceId: "workspace-label-blocks",
    modelId: "test-model",
    now: () => 1_000,
  });
  projector.begin(
    { runId: "run-label-blocks", groupId: "group-label-blocks", childId: "child-label-blocks" },
    { role: "implementer", label: "Cooking times", task: IMPLEMENTER_TASK_WITH_LABEL_BLOCKS },
  );
  const snapshot = projector.snapshot()[0];
  assert.ok(snapshot);
  assert.equal(
    snapshot.taskPreview,
    'Add cooking times to cookbook.html. JSON — {"recipes": [{"name": "Dal", "minutes": 40}]} ' +
      "TASK — Keep the layout; add a time badge. Report the files you changed.",
  );
  assert.equal(snapshot.projectionNotices, undefined);
  assert.deepEqual(parseSubagentRunSnapshotV1(snapshot), snapshot);
  assert.equal(sanitizeSubagentText(IMPLEMENTER_TASK_WITH_LABEL_BLOCKS), IMPLEMENTER_TASK_WITH_LABEL_BLOCKS);
});

test("a real API_KEY: block stays hidden while the text around it survives", () => {
  const value = "Use this config:\nAPI_KEY:\n  abcd1234efgh5678\nDone.";
  for (const sanitize of [sanitizeSubagentText, sanitizeSubagentSnapshotText]) {
    const safe = sanitize(value);
    assert.doesNotMatch(safe, /abcd1234efgh5678/u);
    assert.match(safe, /^Use this config:\n/u);
    assert.match(safe, /\nDone\.$/u);
  }
});

const SECRET_NAMED_BLOCKS = [
  { name: "PASSPHRASE", text: "Setup:\nPASSPHRASE:\n  correct-horse-battery\nDone.", secrets: ["correct-horse-battery"] },
  { name: "KEY", text: "Setup:\nKEY:\n  zq81LmPq0xWv\nDone.", secrets: ["zq81LmPq0xWv"] },
  { name: "APITOKEN", text: "Setup:\nAPITOKEN:\n  tok9vXaa71Rr\nDone.", secrets: ["tok9vXaa71Rr"] },
  { name: "API_KEY", text: "Setup:\nAPI_KEY:\n  mz71Qa0bWx4Kp\nDone.", secrets: ["mz71Qa0bWx4Kp"] },
  { name: "apiToken", text: "Setup:\napiToken:\n  rt5Nv8Xq2Lw9\nDone.", secrets: ["rt5Nv8Xq2Lw9"] },
  {
    name: "multi-line Password",
    text: "Setup:\nPassword:\n  hunter2-plain\n  hunter3-second\nDone.",
    secrets: ["hunter2-plain", "hunter3-second"],
  },
  // Plain single-word names that must match exactly: the second line is not
  // caught by the shared credential filter, so it shows the block rule works.
  ...[
    ["apikey", "ak7Qw2Zx9Lm4", "ak8Rt3Yv0Np5"],
    ["authtoken", "at4Hd8Ks1Pq6", "at5Je9Lt2Qr7"],
    ["accesstoken", "ac3Fg7Jm0Ow2", "ac4Gh8Kn1Px3"],
    ["Credentials", "cr6Tb0Wd4Ys8", "cr7Uc1Xe5Zt9"],
    ["creds", "cs2Mn6Pr0Tv4", "cs3No7Qs1Uw5"],
    ["Creds", "cd9Vb3Xd7Zf1", "cd0Wc4Ye8Ag2"],
    ["Secrets", "se5Kl9Np3Rt7", "se6Lm0Oq4Su8"],
  ].map(([name, first, second]) => ({
    name: `multi-line ${name}`,
    text: `Setup:\n${name}:\n  ${first}\n  ${second}\nDone.`,
    secrets: [first, second],
  })),
  {
    name: "multi-line PASSWORD",
    text: "Setup:\nPASSWORD:\n  firstline-hunter2\n  secondline-hunter3\nDone.",
    secrets: ["firstline-hunter2", "secondline-hunter3"],
  },
];

for (const block of SECRET_NAMED_BLOCKS) {
  test(`a ${block.name}: block is hidden by the parent, snapshot and panel filters`, () => {
    const projector = new SubagentEventProjector({
      generationId: "generation-secret-block",
      chatId: "chat-secret-block",
      workspaceId: "workspace-secret-block",
      modelId: "test-model",
      now: () => 1_000,
    });
    projector.begin(
      { runId: "run-secret-block", groupId: "group-secret-block", childId: "child-secret-block" },
      { role: "scout", label: "Secret block", task: block.text },
    );
    const preview = projector.snapshot()[0]?.taskPreview ?? "";
    for (const safe of [sanitizeSubagentText(block.text), sanitizeSubagentSnapshotText(block.text)]) {
      for (const secret of block.secrets) assert.ok(!safe.includes(secret), `${secret} leaked: ${safe}`);
      assert.match(safe, /^Setup:\n/u);
      assert.match(safe, /\nDone\.$/u);
    }
    // The one-line preview may hide more than the block, never less.
    for (const secret of block.secrets) assert.ok(!preview.includes(secret), `${secret} leaked: ${preview}`);
    assert.match(preview, /^Setup: /u);
  });
}

test("prose heading blocks without a secret-like name survive the parent, panel and preview filters", () => {
  for (const value of [
    "Findings:\nAuthentication:\n  The login flow uses OAuth.\n  Tests cover it.\nNext steps.",
    "Keyboard:\n  Shortcuts work.\nAuthors:\n  The core team.\nDone.",
    "README:\n  Install with npm, then run the dev server.\nDone.",
    "PROMPT:\n  Summarise the attached notes.\nDATA:\n  rows 1 to 20\nDone.",
    "Design tokens:\n  --color-bg is reused in styles.css\nDone.",
    "Hotkeys:\n  Cmd+K opens search\nDone.",
    "Keys:\n  Arrow keys move the selection.\nCookies:\n  None are set.\nDone.",
    "Tokens:\n  Spacing tokens live in theme.ts\nDone.",
  ]) {
    assert.equal(sanitizeSubagentText(value), value);
    assert.equal(sanitizeSubagentSnapshotText(value), value);
    const projector = new SubagentEventProjector({
      generationId: "generation-prose-block",
      chatId: "chat-prose-block",
      workspaceId: "workspace-prose-block",
      modelId: "test-model",
      now: () => 1_000,
    });
    projector.begin(
      { runId: "run-prose-block", groupId: "group-prose-block", childId: "child-prose-block" },
      { role: "scout", label: "Prose block", task: value },
    );
    const preview = projector.snapshot()[0]?.taskPreview ?? "";
    assert.doesNotMatch(preview, /\[REDACTED\]/u, `prose heading hidden in preview: ${preview}`);
  }
});

test("a label block whose value is a lone opaque token stays out of the panel", () => {
  const value = "DATA:\n  q8Zr2LmPx0Wv7Tn\nDone.";
  assert.doesNotMatch(sanitizeSubagentSnapshotText(value), /q8Zr2LmPx0Wv7Tn/u);
  assert.match(sanitizeSubagentSnapshotText(value), /\nDone\.$/u);
});

test("filtering already-filtered text changes nothing", () => {
  const samples = [
    ...SAFE_TASK_AND_MODEL_TEXT,
    SAFE_TASK_AND_MODEL_TEXT.join("\n"),
    IMPLEMENTER_TASK_WITH_LABEL_BLOCKS,
    "Use this config:\nAPI_KEY:\n  abcd1234efgh5678\nDone.",
    "api_key=actual-secret-value",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.actual.signature",
    "Document [REDACTED] then token=actual-secret-value",
  ];
  for (const sample of samples) {
    for (const sanitize of [sanitizeSubagentText, sanitizeSubagentSnapshotText]) {
      const once = sanitize(sample);
      assert.equal(sanitize(once), once, sample);
    }
  }
});

// Assembled at runtime so no key block sits in the source.
const KEY_BEGIN = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ");
const KEY_END = ["-----END", "OPENSSH", "PRIVATE", "KEY-----"].join(" ");
const KEY_BODY = ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "QyNTUxOQAAACDhLz4wKzN0bXhyZWFsa2V5bWF0ZXJpYWxub3RmYWtlAAAAoHN0dWZm"];

test("a helper's saved words hide a whole private key block and keep the text around it", () => {
  const value = `Found this in ~/.ssh:\n${KEY_BEGIN}\n${KEY_BODY.join("\n")}\n${KEY_END}\nDone.`;
  const safe = sanitizeSubagentWorkText(value);
  for (const line of KEY_BODY) assert.ok(!safe.includes(line), `key body leaked: ${safe}`);
  assert.doesNotMatch(safe, /BEGIN OPENSSH/u);
  assert.match(safe, /^Found this in ~\/\.ssh:\n/u);
  assert.match(safe, /\nDone\.$/u);
});

test("a helper's saved words hide a private key cut off before its END line", () => {
  const value = `Found this:\n${KEY_BEGIN}\n${KEY_BODY[0]}\n${KEY_BODY[1]!.slice(0, 30)}`;
  const safe = sanitizeSubagentWorkText(value);
  assert.ok(!safe.includes(KEY_BODY[0]!.slice(0, 24)), safe);
  assert.ok(!safe.includes(KEY_BODY[1]!.slice(0, 24)), safe);
  assert.match(safe, /^Found this:\n/u);
});

const SECRET_NAMED_SAME_LINE = [
  { text: "Sign in with OTP: 731905 now.", secret: "731905" },
  { text: "PIN=4821", secret: "4821" },
  { text: "PASSCODE: 99812", secret: "99812" },
  { text: '{"cvv": "381"}', secret: "381" },
  { text: "CVV: 381", secret: "381" },
  { text: "SEED: abandon ability able about above absent absorb abstract absurd abuse access accident", secret: "abandon ability" },
  { text: "- TOTP_SECRET=JBSWY3DPEHPK3PXP", secret: "JBSWY3DPEHPK3PXP" },
];

for (const { text, secret } of SECRET_NAMED_SAME_LINE) {
  test(`a secret-named value on one line is hidden: ${JSON.stringify(text.slice(0, 24))}`, () => {
    const safe = sanitizeSubagentWorkText(`Setup notes.\n${text}\nDone.`);
    assert.ok(!safe.includes(secret), `${secret} leaked: ${safe}`);
    assert.match(safe, /^Setup notes\.\n/u);
    assert.match(safe, /\nDone\.$/u);
  });
}

test("labels without a secret name, and secret words used in prose, survive the helper filter", () => {
  for (const value of [
    "NOTE: run the tests before the build.",
    "README: install with npm, then run the dev server.",
    "Design tokens: --color-bg is reused in styles.css",
    "Keys: arrow keys move the selection.",
    "Signature: see the docs for the request format.",
    "Private: these notes stay in the repo.",
    "The seed data lives in fixtures/seed.json.",
    "const pin = readPin();",
    "OTP: $OTP_FROM_ENV",
  ]) {
    assert.equal(sanitizeSubagentWorkText(value), value);
  }
});

for (const name of ["OTP", "PASSCODE", "CVV", "SEED", "mnemonic", "signature"]) {
  test(`a ${name}: block on the next lines is hidden by the parent, snapshot and helper filters`, () => {
    const secret = name === "SEED" || name === "mnemonic"
      ? "abandon ability able about above absent absorb abstract absurd abuse access accident"
      : "z8Kq2Lm0Px7Wv";
    const value = `Setup:\n${name}:\n  ${secret}\nDone.`;
    for (const safe of [sanitizeSubagentText(value), sanitizeSubagentSnapshotText(value), sanitizeSubagentWorkText(value)]) {
      assert.ok(!safe.includes(secret), `${name} leaked: ${safe}`);
      assert.match(safe, /^Setup:\n/u);
      assert.match(safe, /\nDone\.$/u);
    }
  });
}
