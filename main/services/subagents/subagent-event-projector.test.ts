import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  MAX_SUBAGENT_MILESTONES,
  parseSubagentMessageReferenceV1,
  parseSubagentRunSnapshotV1,
  subagentMessageReference,
  type SubagentRunSnapshotV1,
} from "../../../renderer/shared/subagent-runs.js";
import {
  containsHighConfidenceSecret,
  containsHighConfidenceSecretIncludingEncodings,
  sanitizeSubagentSnapshotText,
} from "../../../renderer/shared/subagent-safe-text.js";
import { SubagentEventProjector } from "./subagent-event-projector.js";

function base32(
  value: string,
  alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  padded = true,
): string {
  let bits = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    bits = bits * 256 + byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const divisor = 2 ** bitCount;
      encoded += alphabet[Math.floor(bits / divisor) & 31];
      bits %= divisor;
    }
  }
  if (bitCount > 0) encoded += alphabet[(bits * 2 ** (5 - bitCount)) & 31];
  return padded ? encoded.padEnd(Math.ceil(encoded.length / 8) * 8, "=") : encoded;
}

function irregularWrap(value: string, widths = [4, 7, 5, 9]): string {
  const chunks: string[] = [];
  let offset = 0;
  let widthIndex = 0;
  while (offset < value.length) {
    const width = widths[widthIndex % widths.length]!;
    chunks.push(value.slice(offset, offset + width));
    offset += width;
    widthIndex += 1;
  }
  return chunks.join("  ");
}

function frameWrappedEncoding(value: string): string {
  return `ALPHA BRAVO CIVIC DELTA HOTEL ${value} INDIA JULIET KILO MANGO NOVEL`;
}

function javascriptUnicodeEscapes(value: string, braced = false): string {
  return Array.from(value, (character) => {
    const hex = character.codePointAt(0)!.toString(16);
    return braced ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  }).join("");
}

function javascriptHexEscapes(value: string): string {
  return Array.from(
    Buffer.from(value, "utf8"),
    (byte) => `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");
}

function javascriptOctalEscapes(value: string): string {
  return Array.from(
    Buffer.from(value, "utf8"),
    (byte) => `\\${byte.toString(8).padStart(3, "0")}`,
  ).join("");
}

function usageMessage(totalTokens = 42): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

test("projector emits only bounded safe lifecycle snapshots with monotonic revisions", async () => {
  let now = 1_000;
  const emitted: SubagentRunSnapshotV1[] = [];
  const projector = new SubagentEventProjector({
    generationId: "generation-1",
    chatId: "chat-1",
    workspaceId: "workspace-1",
    modelId: "model-1",
    now: () => now,
    onSnapshot: async (snapshot) => {
      emitted.push(snapshot);
    },
  });
  const identity = {
    runId: "run-1",
    groupId: "generation-1:group-1",
    childId: "child-1",
  };
  projector.begin(identity, {
    role: "reviewer",
    label: "Review credentials",
    task: "Do not expose OPENAI_API_KEY=super-secret-value.\nInspect /Users/example/private.",
  });
  now += 1;
  projector.starting(identity.runId);
  now += 1;
  projector.running(identity.runId);
  now += 1;
  projector.turnStarted(identity.runId);
  now += 1;
  projector.toolStarted(identity.runId, "read_file");
  now += 200;
  projector.textDelta(identity.runId, "Found\t/Users/example/private and Bearer abcdefghijklmnop.");
  now += 1;
  projector.usage(identity.runId, usageMessage());
  now += 1;
  projector.finish(identity.runId, {
    role: "reviewer",
    label: "Review credentials",
    status: "completed",
    summary: "Clean. Source was /Users/example/private.",
  });
  await projector.flush();

  const snapshots = projector.snapshot();
  assert.equal(snapshots.length, 1);
  const final = snapshots[0]!;
  assert.equal(final.state, "completed");
  assert.equal(final.turns, 1);
  assert.equal(final.tools, 1);
  assert.equal(final.tokens, 42);
  assert.deepEqual(final.milestones, ["reading", "composing"]);
  assert.match(final.taskPreview, /\[REDACTED(?: ENVIRONMENT VALUE)?\]/u);
  assert.match(final.latestText ?? "", /\[REDACTED ABSOLUTE PATH\]/u);
  assert.doesNotMatch(final.latestText ?? "", /\t/u);
  assert.match(final.terminalMarkdown ?? "", /\[REDACTED ABSOLUTE PATH\]/u);
  assert.equal(emitted.length, 6);
  assert.ok(
    emitted.every(
      (snapshot, index) => index === 0 || snapshot.revision > emitted[index - 1]!.revision,
    ),
  );
  assert.ok(emitted.every((snapshot) => parseSubagentRunSnapshotV1(snapshot)));
});

test("snapshot parser rejects raw secrets, absolute paths, unknown fields, and invalid terminal state", () => {
  let now = 5;
  const projector = new SubagentEventProjector({
    generationId: "generation-2",
    chatId: "chat-2",
    workspaceId: "workspace-2",
    modelId: "model-2",
    now: () => now,
  });
  projector.begin(
    { runId: "run-2", groupId: "generation-2:group-1", childId: "child-2" },
    { role: "scout", label: "Scout", task: "Inspect the workspace." },
  );
  const valid = projector.snapshot()[0]!;
  assert.ok(parseSubagentRunSnapshotV1(valid));
  assert.equal(
    parseSubagentRunSnapshotV1({ ...valid, latestText: "token=secret-value-here" }),
    undefined,
  );
  assert.equal(
    parseSubagentRunSnapshotV1({ ...valid, activity: "/Users/example/private" }),
    undefined,
  );
  assert.equal(parseSubagentRunSnapshotV1({ ...valid, rawToolArgs: {} }), undefined);
  assert.equal(parseSubagentRunSnapshotV1({ ...valid, milestones: ["read_file"] }), undefined);
  assert.equal(
    parseSubagentRunSnapshotV1({
      ...valid,
      milestones: Array.from({ length: MAX_SUBAGENT_MILESTONES + 1 }, () => "reading"),
    }),
    undefined,
  );
  for (const unsafe of [
    { terminalMarkdown: "[file](</Users/alice/private file.txt>)" },
    { terminalMarkdown: "Cookie: session=abcdefghijklmnop" },
    {
      terminalMarkdown: "-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop\n-----END PRIVATE KEY-----",
    },
    { terminalMarkdown: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCexample" },
    { latestText: "NODE_ENV=production" },
    { taskPreview: "Path is /" },
    { taskPreview: "Path is C:\\" },
  ]) {
    assert.equal(
      parseSubagentRunSnapshotV1({ ...valid, ...unsafe }),
      undefined,
      `accepted unsafe snapshot field: ${JSON.stringify(unsafe)}`,
    );
  }
  for (const activeTerminalField of [
    { latestText: "partial child text" },
    { terminalMarkdown: "partial child report" },
    { error: "partial child error" },
    { warnings: ["partial child warning"] },
  ]) {
    assert.equal(
      parseSubagentRunSnapshotV1({ ...valid, ...activeTerminalField }),
      undefined,
      `accepted terminal-only field on active snapshot: ${JSON.stringify(activeTerminalField)}`,
    );
  }
  assert.equal(parseSubagentRunSnapshotV1({ ...valid, runId: "run-K" }), undefined);
  assert.equal(parseSubagentRunSnapshotV1({ ...valid, childId: "child-ſ" }), undefined);
  now += 1;
  assert.equal(
    parseSubagentRunSnapshotV1({
      ...valid,
      state: "completed",
      updatedAt: now,
    }),
    undefined,
  );
});

test("projector redacts snapshot-only environment and key material", () => {
  let now = 50;
  const projector = new SubagentEventProjector({
    generationId: "generation-redaction",
    chatId: "chat-redaction",
    workspaceId: "workspace-redaction",
    modelId: "model-redaction",
    now: () => now,
  });
  projector.begin(
    {
      runId: "run-redaction",
      groupId: "generation-redaction:group-1",
      childId: "child-redaction",
    },
    {
      role: "reviewer",
      label: "Check NODE_ENV\u200b＝production",
      task: "Inspect [file](<／Users/alice/private file.txt>)",
    },
  );
  now += 200;
  projector.textDelta(
    "run-redaction",
    "Cookie: session=abcdefghijklmnop\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCexample",
  );
  now += 1;
  projector.finish("run-redaction", {
    role: "reviewer",
    label: "Check environment",
    status: "completed",
    summary:
      "NODE_ENV=production\n-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop\n-----END PRIVATE KEY-----",
  });
  const serialized = JSON.stringify(projector.snapshot()[0]);
  assert.doesNotMatch(
    serialized,
    /production|Users|alice|abcdefghijklmnop|AAAAB3Nza|BEGIN PRIVATE KEY/u,
  );
  assert.match(serialized, /REDACTED/u);
  assert.equal(
    JSON.stringify(projector.snapshot()[0]),
    JSON.stringify(parseSubagentRunSnapshotV1(projector.snapshot()[0])),
  );
  const confusableSecret = "OPENAI_API_KEY\u200b＝super-secret-value";
  const sanitized = sanitizeSubagentSnapshotText(confusableSecret);
  assert.doesNotMatch(sanitized, /super-secret-value|\u200b|＝/u);
  assert.equal(sanitizeSubagentSnapshotText(sanitized), sanitized);
});

test("snapshot sanitizer covers short and mark-obfuscated credentials without erasing multilingual labels", () => {
  for (const credential of [
    "api_key=abc",
    "token=abc",
    "password=x",
    'secret="z"',
    'password="x',
    "api_key='a",
    "token=`z",
    "password: |\n  x",
    "Bearer a",
    "Basic eDo=",
    "s\u0332ecret=correct-horse-battery-staple",
    "passworԁ=x",
    "p😀assword=correct-horse-battery-staple",
    "api$key=correct-horse-battery-staple",
    "p$assword=correct-horse-battery-staple",
    "auth/token=correct-horse-battery-staple",
    "API key: correct-horse-battery-staple",
    "AWS\u00a0secret\u00a0access\u00a0key: correct-horse-battery-staple",
    "signing.key = correct-horse-battery-staple",
    "encryption·key: correct-horse-battery-staple",
  ]) {
    const sanitized = sanitizeSubagentSnapshotText(credential);
    assert.match(sanitized, /REDACTED/u);
    assert.notEqual(sanitized, credential);
  }

  const malformedQuoted = 'password="x';
  for (const encoded of [
    Buffer.from(malformedQuoted, "utf8").toString("base64"),
    Buffer.from(malformedQuoted, "utf8").toString("base64url"),
    Buffer.from(malformedQuoted, "utf8").toString("hex"),
  ]) {
    assert.equal(sanitizeSubagentSnapshotText(encoded), "[REDACTED ENCODED TEXT]");
  }
  const credentialBase64 = Buffer.from("OPENAI_API_KEY=x", "utf8").toString("base64");
  for (const width of [1, 2, 4, 12]) {
    const wrappedBase64 = credentialBase64.match(new RegExp(`.{1,${width}}`, "gu"))!.join("\n");
    const sanitized = sanitizeSubagentSnapshotText(wrappedBase64);
    assert.match(sanitized, /REDACTED/u);
    assert.notEqual(sanitized, wrappedBase64);
  }
  const credentialHex = Buffer.from("OPENAI_API_KEY=x", "utf8").toString("hex");
  const wrappedHex = credentialHex.match(/.{1,4}/gu)!.join("\n");
  const sanitizedHex = sanitizeSubagentSnapshotText(wrappedHex);
  assert.match(sanitizedHex, /REDACTED/u);
  assert.notEqual(sanitizedHex, wrappedHex);
  const credentialPercent = Array.from(
    Buffer.from("OPENAI_API_KEY=x", "utf8"),
    (byte) => `%${byte.toString(16).padStart(2, "0")}`,
  ).join("\n");
  const sanitizedPercent = sanitizeSubagentSnapshotText(credentialPercent);
  assert.match(sanitizedPercent, /REDACTED/u);
  assert.notEqual(sanitizedPercent, credentialPercent);

  for (const safe of ["版本v2: clean", "日本語title: clean"]) {
    assert.equal(sanitizeSubagentSnapshotText(safe), safe);
  }
});

test("snapshot sanitizer consumes complete sensitive values while preserving benign references", () => {
  for (const credential of [
    "password: correct,horse;battery",
    "password: correct]horse",
    'secret: "correct,\\"horse;battery"',
    "token='correct;horse,battery']",
  ]) {
    const sanitized = sanitizeSubagentSnapshotText(credential);
    assert.match(sanitized, /REDACTED/u);
    assert.doesNotMatch(sanitized, /correct|horse|battery/u);
    assert.equal(containsHighConfidenceSecret(sanitized), false);
  }

  for (const safe of [
    "authorization: role based",
    "const password = process.env.PASSWORD",
    "const secret = import.meta.env.SECRET",
  ]) {
    assert.equal(sanitizeSubagentSnapshotText(safe), safe);
    assert.equal(containsHighConfidenceSecret(safe), false);
  }
});

test("snapshot sanitizer redacts complete POSIX environment values without rewriting source controls", () => {
  const unsafe = [
    "X=single-character-environment-value,semicolon;brace}",
    "NODE_ENV=conventional-environment-value,semicolon;brace}",
    "export foo=export-lowercase-environment-value,semicolon;brace}",
    "env foo=env-lowercase-environment-value,semicolon;brace} command",
    "mixedName=bare-mixed-case-environment-value,semicolon;brace} command",
    "declare -x foo=declare-lowercase-environment-value,semicolon;brace}",
    "$ foo=prompt-lowercase-environment-value,semicolon;brace} command",
    "sh -c 'foo=shell-c-lowercase-environment-value,semicolon;brace} command'",
    "sh -c 'printf \"<\"; foo=supersecretvalue env'",
    "command env mixedName=command-env-mixed-case-environment-value,semicolon;brace} command",
    "sudo foo=sudo-lowercase-environment-value,semicolon;brace} command",
    "```sh\nfoo=fenced-lowercase-environment-value,semicolon;brace} command\n```",
    "> foo=quoted-lowercase-environment-value,semicolon;brace} command",
    "**X**=visible-environment-value,semicolon;brace}",
    'X="first-environment-line\nsecond-environment-line,semicolon;brace}"',
    String.raw`X=continued-environment-value\
next-environment-line,semicolon;brace}`,
    'NODE_ENV={"nested":"structured-environment-value,semicolon;brace}"}',
    "NODE_ENV: |\n  block-environment-line,semicolon;brace}\n  second-block-environment-line",
    "NODE_ENV=\n  indented-environment-line,semicolon;brace}\n  second-indented-environment-line",
  ];
  for (const value of unsafe) {
    const sanitized = sanitizeSubagentSnapshotText(value);
    assert.match(sanitized, /REDACTED/u, value);
    assert.doesNotMatch(
      sanitized,
      /single-character-environment-value|conventional-environment-value|export-lowercase-environment-value|env-lowercase-environment-value|bare-mixed-case-environment-value|declare-lowercase-environment-value|prompt-lowercase-environment-value|shell-c-lowercase-environment-value|supersecretvalue|command-env-mixed-case-environment-value|sudo-lowercase-environment-value|fenced-lowercase-environment-value|quoted-lowercase-environment-value|visible-environment-value|first-environment-line|second-environment-line|continued-environment-value|next-environment-line|structured-environment-value|block-environment-line|second-block-environment-line|indented-environment-line|second-indented-environment-line/u,
      value,
    );
    assert.equal(sanitizeSubagentSnapshotText(sanitized), sanitized, value);
  }

  for (const value of [
    "const X=1;",
    'const NODE_ENV = "test";',
    "const lowercase=value;",
    'const mixedName = "test";',
    "function score(X=1) { return X; }",
    "const score = (value=defaultScore) => value;",
    "callbacks.map((callback=defaultCallback) => callback);",
    "const { foo=defaultValue, nested: { bar=defaultBar } } = defaults;",
    "const pick = ({foo=defaultValue}) => foo;",
    "X = 1",
    "x = 1",
    "lowercase = value",
    "X: coordinate",
    "lowercase: coordinate",
    "mixedName: coordinate",
    '<div data-state=ready data-mode=compact></div>',
    '<a href="https://example.com/docs?mode=compact">Docs</a>',
    "https://example.com/docs?mode=compact&view=grid",
    "QUJDREVGR0g=",
  ]) {
    assert.equal(sanitizeSubagentSnapshotText(value), value, value);
  }
});

test("snapshot path sanitizer preserves unambiguous non-filesystem slash syntax", () => {
  for (const safe of [
    "The regex /foo/ matches.",
    "The pattern /foo.bar/giu matches.",
    "10 / 2",
    "route /api/users",
    '<a href="/api/users">Users</a>',
  ]) {
    assert.equal(sanitizeSubagentSnapshotText(safe), safe);
  }
  for (const privatePath of [
    "Inspect /Users/alice/private.txt",
    "route /Users/alice/private.txt",
    '<a href="/Users/alice/private.txt">file</a>',
  ]) {
    const sanitized = sanitizeSubagentSnapshotText(privatePath);
    assert.match(sanitized, /REDACTED ABSOLUTE PATH/u);
    assert.doesNotMatch(sanitized, /Users|alice|private\.txt/u);
  }
});

test("live text activity publishes only on an actual state transition", async () => {
  let now = 1_000;
  const emitted: SubagentRunSnapshotV1[] = [];
  const projector = new SubagentEventProjector({
    generationId: "generation-delta-bound",
    chatId: "chat-delta-bound",
    workspaceId: "workspace-delta-bound",
    modelId: "model-delta-bound",
    now: () => now,
    onSnapshot: (snapshot) => {
      emitted.push(snapshot);
    },
  });
  projector.begin(
    {
      runId: "run-delta-bound",
      groupId: "generation-delta-bound:group",
      childId: "child-delta-bound",
    },
    { role: "reviewer", label: "Delta bound", task: "Bound live projection writes." },
  );
  projector.running("run-delta-bound");
  for (let index = 0; index < 500; index += 1) {
    now += 200;
    projector.textDelta("run-delta-bound", `fragment-${index}`);
  }
  await projector.flush();

  assert.equal(emitted.length, 3);
  assert.equal(projector.snapshot()[0]?.activity, "Writing a bounded report");
  assert.deepEqual(projector.snapshot()[0]?.milestones, ["composing"]);
});

test("milestones are bounded enum-only projections that cannot carry private tool data", () => {
  const projector = new SubagentEventProjector({
    generationId: "generation-safe-milestones",
    chatId: "chat-safe-milestones",
    workspaceId: "workspace-safe-milestones",
    modelId: "model-safe-milestones",
  });
  projector.begin(
    {
      runId: "run-safe-milestones",
      groupId: "generation-safe-milestones:group",
      childId: "child-safe-milestones",
    },
    {
      role: "reviewer",
      label: "Safe milestone review",
      task: "Review bounded activity.",
    },
  );
  for (const tool of [
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "shell /Users/alice/private --token=correct-horse-battery-staple",
  ]) {
    projector.toolStarted("run-safe-milestones", tool);
  }
  projector.textDelta(
    "run-safe-milestones",
    "command=/Users/alice/private token=correct-horse-battery-staple",
  );
  for (let index = 0; index < 100; index += 1) {
    projector.toolStarted("run-safe-milestones", index % 2 === 0 ? "read_file" : "grep");
  }

  const snapshot = projector.snapshot()[0]!;
  assert.ok((snapshot.milestones?.length ?? 0) <= MAX_SUBAGENT_MILESTONES);
  assert.deepEqual(snapshot.milestones?.slice(0, 6), [
    "reading",
    "listing",
    "matching",
    "searching",
    "inspecting",
    "composing",
  ]);
  assert.doesNotMatch(
    JSON.stringify(snapshot.milestones),
    /shell|Users|alice|private|token|correct-horse|read_file/u,
  );
  assert.ok(parseSubagentRunSnapshotV1(snapshot));
});

test("turn, usage, and tool telemetry has a hard durable-write bound", async () => {
  const emitted: SubagentRunSnapshotV1[] = [];
  const projector = new SubagentEventProjector({
    generationId: "generation-telemetry-bound",
    chatId: "chat-telemetry-bound",
    workspaceId: "workspace-telemetry-bound",
    modelId: "model-telemetry-bound",
    onSnapshot: (snapshot) => {
      emitted.push(snapshot);
    },
  });
  projector.begin(
    {
      runId: "run-telemetry-bound",
      groupId: "generation-telemetry-bound:group",
      childId: "child-telemetry-bound",
    },
    { role: "reviewer", label: "Telemetry bound", task: "Bound durable telemetry." },
  );
  projector.running("run-telemetry-bound");
  const tools = ["read_file", "list_dir", "glob", "grep"] as const;
  for (let index = 0; index < 512; index += 1) {
    projector.turnStarted("run-telemetry-bound");
    projector.toolStarted("run-telemetry-bound", tools[index % tools.length]!);
    projector.usage("run-telemetry-bound", usageMessage(1));
  }
  projector.finish("run-telemetry-bound", {
    role: "reviewer",
    label: "Telemetry bound",
    status: "completed",
    summary: "Bounded.",
  });
  await projector.flush();

  const final = projector.snapshot()[0]!;
  assert.equal(final.turns, 512);
  assert.equal(final.tools, 512);
  assert.equal(final.tokens, 512);
  assert.equal(final.milestones?.length, MAX_SUBAGENT_MILESTONES);
  assert.ok(emitted.length <= 7, `published ${emitted.length} durable snapshots`);
  assert.equal(emitted[emitted.length - 1]?.state, "completed");
});

test("projector withholds text across stream boundaries until terminal sanitization", () => {
  const cases = [
    {
      name: "NFKC token",
      deltas: ["ｇｈ", `ｐ＿${"a".repeat(24)}`],
      leaked: /ghp_|ｇｈ|ｐ＿/u,
    },
    {
      name: "post-redaction token tail",
      deltas: ["ghp_ABCDEFGHIJKLMNOPQRS", "T", "UVWX"],
      leaked: /ghp_|ABCDEFGHIJKLMNOPQRS|UVWX/u,
    },
    {
      name: "split bearer token",
      deltas: ["Bearer abc", "defghijklmnop"],
      leaked: /Bearer abc|defghijklmnop/u,
    },
    {
      name: "format-split assignment",
      deltas: ["OPENAI_API_", "KEY\u200b=super-secret-value"],
      leaked: /super-secret-value|\u200b/u,
    },
    {
      name: "split Windows path",
      deltas: ["Inspect C", ":\\Users\\alice\\private.txt"],
      leaked: /Users|alice|private\.txt/u,
    },
  ] as const;

  for (const [index, current] of cases.entries()) {
    let now = 1_000;
    const runId = `run-split-${index}`;
    const emitted: SubagentRunSnapshotV1[] = [];
    const observedProjector = new SubagentEventProjector({
      generationId: `generation-observed-${index}`,
      chatId: `chat-observed-${index}`,
      workspaceId: "workspace-split",
      modelId: "model-split",
      now: () => now,
      onSnapshot: (snapshot) => {
        emitted.push(snapshot);
      },
    });
    observedProjector.begin(
      {
        runId: `${runId}-observed`,
        groupId: `generation-observed-${index}:group-1`,
        childId: `child-observed-${index}`,
      },
      {
        role: "reviewer",
        label: "Review split stream",
        task: "Inspect streamed output.",
      },
    );

    for (const delta of current.deltas) {
      now += 200;
      assert.doesNotThrow(
        () => observedProjector.textDelta(`${runId}-observed`, delta),
        current.name,
      );
    }
    assert.ok(
      emitted.every((snapshot) => snapshot.latestText === undefined),
      `${current.name} exposed a partial stream`,
    );
    now += 1;
    assert.doesNotThrow(() =>
      observedProjector.finish(`${runId}-observed`, {
        role: "reviewer",
        label: "Review split stream",
        status: "completed",
        summary: current.deltas.join(""),
      }),
    );

    const snapshot = observedProjector.snapshot()[0]!;
    assert.equal(snapshot.state, "completed", current.name);
    assert.match(snapshot.latestText ?? "", /REDACTED/u, current.name);
    assert.doesNotMatch(snapshot.latestText ?? "", current.leaked, current.name);
    assert.ok(parseSubagentRunSnapshotV1(snapshot), current.name);
  }
});

test("projector redacts paths after Markdown and Unicode punctuation", () => {
  let now = 10;
  const projector = new SubagentEventProjector({
    generationId: "generation-punctuation",
    chatId: "chat-punctuation",
    workspaceId: "workspace-punctuation",
    modelId: "model-punctuation",
    now: () => now,
  });
  projector.begin(
    {
      runId: "run-punctuation",
      groupId: "generation-punctuation:group-1",
      childId: "child-punctuation",
    },
    {
      role: "reviewer",
      label: "Review punctuation paths",
      task: "Inspect the report.",
    },
  );
  now += 200;
  projector.textDelta(
    "run-punctuation",
    "**/Users/alice/private.txt** and Found—/Users/alice/other.txt",
  );
  assert.equal(projector.snapshot()[0]?.latestText, undefined);
  now += 1;
  projector.finish("run-punctuation", {
    role: "reviewer",
    label: "Review punctuation paths",
    status: "completed",
    summary: "**/Users/alice/private.txt** and Found—/Users/alice/other.txt",
  });

  const snapshot = projector.snapshot()[0]!;
  assert.doesNotMatch(JSON.stringify(snapshot), /Users|alice|private\.txt|other\.txt/u);
  assert.match(snapshot.latestText ?? "", /REDACTED ABSOLUTE PATH/u);
  assert.match(snapshot.terminalMarkdown ?? "", /REDACTED ABSOLUTE PATH/u);
  assert.ok(parseSubagentRunSnapshotV1(snapshot));
  assert.equal(
    sanitizeSubagentSnapshotText("See https://example.com/path"),
    "See https://example.com/path",
  );
});

test("snapshot sanitizer handles Markdown underscores without corrupting HTTP URLs", () => {
  assert.equal(containsHighConfidenceSecret("PUBLIC_TOKEN=show-this"), false);
  const githubToken = `github_pat_${"a".repeat(40)}`;
  const unsafe = [
    "_Bearer abcdefghijklmnop_",
    `_${githubToken}_`,
    "_OPENAI_API_KEY=super-secret-value_",
    "_/Users/alice/private.txt_",
  ];
  for (const value of unsafe) {
    const sanitized = sanitizeSubagentSnapshotText(value);
    assert.notEqual(sanitized, value);
    assert.doesNotMatch(
      sanitized,
      /abcdefghijklmnop|github_pat_|super-secret-value|Users|alice|private\.txt/u,
    );
    assert.match(sanitized, /REDACTED/u);
  }

  for (const url of ["https://example.com/foo-/bar", "https://[::1]/private/path"]) {
    assert.equal(sanitizeSubagentSnapshotText(url), url);
  }
  assert.equal(
    sanitizeSubagentSnapshotText("https://user:supersecret@example.com/private/path"),
    "https://[REDACTED]@example.com/private/path",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("https://example.com/path?token=super-secret-value"),
    "https://example.com/path?token=[REDACTED]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("**OPENAI_API_KEY**=super-secret-value"),
    "**OPENAI_API_KEY=[REDACTED]",
  );
  assert.equal(sanitizeSubagentSnapshotText("Bearer **abcdefghijklmnop**"), "Bearer [REDACTED]");
  assert.equal(
    sanitizeSubagentSnapshotText("https://supersecret@example.com/private/path"),
    "https://[REDACTED]@example.com/private/path",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("https://example.com/?api%5Fkey=super-secret-value"),
    "https://example.com/?api_key=[REDACTED]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("api_**key**=super-secret-value"),
    "api_key=[REDACTED]",
  );
  assert.equal(sanitizeSubagentSnapshotText("Bearer abc**defghijklmnop**"), "Bearer [REDACTED]");
  assert.equal(sanitizeSubagentSnapshotText("api_`key`=super-secret-value"), "api_key=[REDACTED]");
});

test("credential scanning remains bounded at the read-file ceiling", () => {
  for (const benign of [
    "a.".repeat(100_000),
    `${"a.".repeat(99_999)}=`,
    `ordinary token documentation\n${"a.".repeat(99_980)}=`,
    "a=".repeat(100_000),
  ]) {
    const startedAt = Date.now();
    assert.equal(containsHighConfidenceSecret(benign), false);
    assert.ok(
      Date.now() - startedAt < 2_000,
      "a maximum-size benign file must not trigger superlinear credential scanning",
    );
  }
});

test("unsafe text cannot survive projector, parser, or the production Markdown pipeline", () => {
  const rawSecret = "OPENAI_API_KEY=correct-horse-battery-staple";
  const rawPath = "/Users/alice/private.txt";
  const encodedSecret = Buffer.from(rawSecret, "utf-8").toString("base64");
  const hexSecret = Buffer.from(rawSecret, "utf-8").toString("hex");
  const splitLinks = encodedSecret
    .match(/.{1,12}/gu)!
    .map((part, index) => `[${part}](https://example.com/${index})`)
    .join("");
  const splitReferences = `${hexSecret
    .match(/.{1,12}/gu)!
    .map((part, index) => `[${part}][hex-${index}]`)
    .join("")}\n\n${hexSecret
    .match(/.{1,12}/gu)!
    .map((_part, index) => `[hex-${index}]: https://example.com/${index}`)
    .join("\n")}`;
  const splitCodeAndLinks = encodedSecret
    .match(/.{1,12}/gu)!
    .map((part, index) =>
      index % 2 === 0 ? `\`${part}\`` : `[${part}](https://example.com/${index})`,
    )
    .join("");
  const variationSelectorSecret = `${[..."OPENAI_API_KEY"].join(
    "\uFE0F",
  )}=correct-horse-battery-staple`;
  let fiveLayerBase64Secret = rawSecret;
  for (let depth = 0; depth < 5; depth += 1) {
    fiveLayerBase64Secret = Buffer.from(fiveLayerBase64Secret, "utf-8").toString("base64");
  }
  let nineLayerPercentPath = rawPath;
  for (let depth = 0; depth < 9; depth += 1) {
    nineLayerPercentPath = encodeURIComponent(nineLayerPercentPath);
  }
  const cases = [
    "api&#95;key=fake-super-secret-value",
    "&#47;Users/alice/private.txt",
    "https://user:pass&#64;example.com/private",
    "api&#x09;_key=fake-control-secret",
    "NODE&#10;_ENV=production",
    "api\\_key=fake-markdown-secret",
    "api&#92;_key=fake-entity-backslash-secret",
    "api&bsol;_key=fake-named-backslash-secret",
    "https://example.com/open?path=/Users/alice/private.txt",
    "[open](https://example.com/open?path=/Users/alice/private.txt)",
    "db_url=postgres://alice:pass@secret-internal-db/private",
    "OPENAI_API_[KEY](https://example.com)=correct-horse-battery-staple",
    "OPENAI_API_[KEY][ref]=correct-horse-battery-staple\n\n[ref]: https://example.com",
    "OPENAI_API_$KEY$=correct-horse-battery-staple",
    "![tracking pixel](https://example.com/pixel.png)",
    "[open](%2FUsers%2Falice%2Fprivate.txt)",
    "[open][ref]\n\n[ref]: %2FUsers%2Falice%2Fprivate.txt",
    "[login](https%3A%2F%2Fuser%3Acorrect-horse%40example.com)",
    "OPENAI%255FAPI%255FKEY%253Dsuper%252Dsecret%252Dvalue",
    "`OPENAI%255FAPI%255FKEY%253Dsuper%252Dsecret%252Dvalue`",
    "[encoded](OPENAI%255FAPI%255FKEY%253Dsuper%252Dsecret%252Dvalue)",
    "[encoded][double]\n\n[double]: OPENAI%255FAPI%255FKEY%253Dsuper%252Dsecret%252Dvalue",
    "%252FUsers%252Falice%252Fprivate.txt",
    "junk%ZZ OPENAI%255FAPI%255FKEY%253Dsuper%252Dsecret%252Dvalue",
    "sеcret=correct-horse-battery-staple",
    "аpi_key=correct-horse-battery-staple",
    "T1BFTkFJX0FQSV9LRVk9Y29ycmVjdC1ob3JzZS1iYXR0ZXJ5LXN0YXBsZQ==",
    "T1BFTkFJX0FQSV9LRVk9Y29ycmVjdC1ob3JzZS1iYXR0ZXJ5LXN0YXBsZQ",
    "L1VzZXJzL2FsaWNlL3ByaXZhdGUudHh0",
    "4f50454e41495f4150495f4b45593d636f72726563742d686f7273652d626174746572792d737461706c65",
    "2f55736572732f616c6963652f707269766174652e747874",
    splitLinks,
    splitReferences,
    splitCodeAndLinks,
    variationSelectorSecret,
    fiveLayerBase64Secret,
    nineLayerPercentPath,
    javascriptUnicodeEscapes(rawSecret),
    javascriptUnicodeEscapes(rawSecret, true),
    javascriptHexEscapes(rawSecret),
    javascriptOctalEscapes(rawSecret),
    javascriptUnicodeEscapes(javascriptHexEscapes(rawSecret)),
    `\\\\${javascriptUnicodeEscapes(rawSecret)}`,
    javascriptUnicodeEscapes(rawPath),
    javascriptUnicodeEscapes(rawPath, true),
    javascriptHexEscapes(rawPath),
    javascriptOctalEscapes(rawPath),
  ];
  let now = 700;
  for (const [index, unsafe] of cases.entries()) {
    const projector = new SubagentEventProjector({
      generationId: `generation-entity-${index}`,
      chatId: `chat-entity-${index}`,
      workspaceId: "workspace-entity",
      modelId: "model-entity",
      now: () => now,
    });
    const runId = `run-entity-${index}`;
    projector.begin(
      {
        runId,
        groupId: `generation-entity-${index}:group-1`,
        childId: `child-entity-${index}`,
      },
      { role: "reviewer", label: "Entity review", task: "Review encoded output." },
    );
    now += 1;
    projector.finish(runId, {
      role: "reviewer",
      label: "Entity review",
      status: "completed",
      summary: unsafe,
    });

    const snapshot = projector.snapshot()[0]!;
    assert.ok(parseSubagentRunSnapshotV1(snapshot));
    assert.equal(
      parseSubagentRunSnapshotV1({
        ...snapshot,
        latestText: unsafe,
        terminalMarkdown: unsafe,
      }),
      undefined,
    );
    const rendered = renderToStaticMarkup(
      React.createElement(
        ReactMarkdown,
        {
          rehypePlugins: [rehypeKatex],
          remarkPlugins: [remarkGfm, remarkMath],
        },
        snapshot.terminalMarkdown,
      ),
    );
    assert.doesNotMatch(
      rendered,
      /fake-super-secret-value|fake-control-secret|fake-markdown-secret|fake-entity-backslash-secret|fake-named-backslash-secret|correct-horse-battery-staple|Users|alice|user:pass|production|secret-internal-db|postgres|<img|katex/u,
    );
    assert.match(rendered, /REDACTED/u);
  }
});

test("numeric escape decoding ignores malformed and benign JavaScript source text", () => {
  for (const benign of [
    String.raw`const marker = "\u0041";`,
    String.raw`const literal = "\\u0041";`,
    String.raw`const hex = "\x41";`,
    String.raw`const octal = "\101";`,
    String.raw`const invalid = "\u{110000}";`,
    String.raw`const windowsPath = "C:\\Users\\alice\\project";`,
  ]) {
    assert.equal(containsHighConfidenceSecretIncludingEncodings(benign), false, benign);
  }
});

test("JSON named control escapes cannot hide snapshot credentials", () => {
  const controls = ["t", "n", "r", "b", "f"] as const;
  const namedSecrets = controls.map((control) => `api\\${control}key=correct-horse-battery-staple`);
  const mixedSecret = String.raw`api\u005f\tkey\x3dcorrect-horse-battery-staple`;
  const doubledSecret = String.raw`api\\nkey=correct-horse-battery-staple`;
  const base64NestedSecret = Buffer.from(
    String.raw`api\rkey=correct-horse-battery-staple`,
    "utf8",
  ).toString("base64");
  const unsafeCases = [...namedSecrets, mixedSecret, doubledSecret, base64NestedSecret];

  for (const unsafe of unsafeCases) {
    assert.equal(containsHighConfidenceSecretIncludingEncodings(unsafe), true, unsafe);
    assert.equal(sanitizeSubagentSnapshotText(unsafe), "[REDACTED ENCODED TEXT]", unsafe);
  }

  let now = 900;
  for (const [index, unsafe] of unsafeCases.entries()) {
    const projector = new SubagentEventProjector({
      generationId: `generation-named-control-${index}`,
      chatId: "chat-named-control",
      workspaceId: "workspace-named-control",
      modelId: "model-named-control",
      now: () => now,
    });
    const runId = `run-named-control-${index}`;
    projector.begin(
      {
        runId,
        groupId: `generation-named-control-${index}:group-1`,
        childId: `child-named-control-${index}`,
      },
      { role: "reviewer", label: "Control review", task: "Inspect encoded output." },
    );
    now += 1;
    projector.finish(runId, {
      role: "reviewer",
      label: "Control review",
      status: "completed",
      summary: unsafe,
    });

    const projected = projector.snapshot()[0]!;
    assert.ok(parseSubagentRunSnapshotV1(projected));
    assert.match(projected.terminalMarkdown ?? "", /REDACTED/u);
    assert.doesNotMatch(projected.terminalMarkdown ?? "", /correct-horse|api\\/u);
    assert.equal(
      parseSubagentRunSnapshotV1({
        ...projected,
        latestText: unsafe,
        terminalMarkdown: unsafe,
      }),
      undefined,
    );
  }
});

test("JSON named control decoding leaves benign escaped source available", () => {
  for (const benign of [
    String.raw`const controls = ["\t", "\n", "\r", "\b", "\f"];`,
    String.raw`const arbitraryJavaScriptEscapes = ["\a", "\e", "\v"];`,
    String.raw`const relativePath = "fixtures\\temp\\new-folder";`,
    String.raw`const message = "first\nsecond";`,
  ]) {
    assert.equal(containsHighConfidenceSecretIncludingEncodings(benign), false, benign);
    assert.equal(sanitizeSubagentSnapshotText(benign), benign);
  }
  assert.equal(
    containsHighConfidenceSecretIncludingEncodings(
      String.raw`const doubled = ["\\t", "\\n", "\\r", "\\b", "\\f"];`,
    ),
    false,
  );
});

test("URL path parameters and complete connection strings are redacted without corrupting web paths", () => {
  assert.equal(
    sanitizeSubagentSnapshotText("[Docs](https://example.com/docs)"),
    "[Docs](https://example.com/docs)",
  );
  assert.equal(
    sanitizeSubagentSnapshotText(
      "OPENAI_API_[KEY](https://example.com)=correct-horse-battery-staple",
    ),
    "[REDACTED MARKDOWN CONTENT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("![tracking](https://example.com/pixel.png)"),
    "[REDACTED MARKDOWN CONTENT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("[open](%252FUsers%252Falice%252Fprivate.txt)"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("OPENAI%255FAPI%255FKEY%253Dsuper%252Dsecret%252Dvalue"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("%252FUsers%252Falice%252Fprivate.txt"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("[login](https%3A%2F%2Fuser%3Acorrect-horse%40example.com)"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("junk%ZZ OPENAI%255FAPI%255FKEY%253Dsuper%252Dsecret%252Dvalue"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("sеcret=correct-horse-battery-staple"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("аpi_key=correct-horse-battery-staple"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("T1BFTkFJX0FQSV9LRVk9Y29ycmVjdC1ob3JzZS1iYXR0ZXJ5LXN0YXBsZQ=="),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("L1VzZXJzL2FsaWNlL3ByaXZhdGUudHh0"),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText(
      "4f50454e41495f4150495f4b45593d636f72726563742d686f7273652d626174746572792d737461706c65",
    ),
    "[REDACTED ENCODED TEXT]",
  );
  assert.equal(sanitizeSubagentSnapshotText("SGVsbG8gd29ybGQ="), "SGVsbG8gd29ybGQ=");
  assert.equal(sanitizeSubagentSnapshotText("причина: чисто"), "причина: чисто");
  assert.equal(
    sanitizeSubagentSnapshotText("https://example.com/open?path=/Users/alice/private.txt"),
    "https://example.com/open?REDACTED_ABSOLUTE_PATH",
  );
  assert.equal(
    sanitizeSubagentSnapshotText(
      "https://example.com/open?path=C%3A%5CUsers%5Calice%5Cprivate.txt",
    ),
    "https://example.com/open?REDACTED_ABSOLUTE_PATH",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("db_url=postgres://alice:pass@secret-internal-db/private"),
    "db_url=[REDACTED]",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("https://example.com/Users/alice/public-profile"),
    "https://example.com/REDACTED_ABSOLUTE_PATH",
  );
  assert.equal(
    sanitizeSubagentSnapshotText("https://example.com/users/alice/public-profile"),
    "https://example.com/users/alice/public-profile",
  );
});

test("HTTP pathnames cannot carry local absolute paths through renderer-safe Markdown", () => {
  const unsafeUrls = [
    "https://example.invalid/Users/sambitbiswas/private/aiden.txt",
    "https://example.invalid/%55sers%2Fsambitbiswas%2Fprivate%2Faiden.txt",
    String.raw`https://example.invalid/C:\Users\sambitbiswas\private\aiden.txt`,
    "https://example.invalid/C%3A%5CUsers%5Csambitbiswas%5Cprivate%5Caiden.txt",
  ];
  let now = 1_500;

  for (const [index, unsafeUrl] of unsafeUrls.entries()) {
    const unsafeMarkdown = `[report](${unsafeUrl})`;
    const sanitized = sanitizeSubagentSnapshotText(unsafeMarkdown);
    assert.doesNotMatch(
      sanitized,
      /Users|sambitbiswas|private|aiden\.txt|%55sers|%5CUsers/iu,
      unsafeUrl,
    );
    assert.match(sanitized, /REDACTED_ABSOLUTE_PATH/u);

    const projector = new SubagentEventProjector({
      generationId: `generation-http-path-${index}`,
      chatId: "chat-http-path",
      workspaceId: "workspace-http-path",
      modelId: "model-http-path",
      now: () => now,
    });
    const runId = `run-http-path-${index}`;
    projector.begin(
      {
        runId,
        groupId: `generation-http-path-${index}:group-1`,
        childId: `child-http-path-${index}`,
      },
      { role: "reviewer", label: "Path review", task: "Inspect the report." },
    );
    now += 1;
    projector.finish(runId, {
      role: "reviewer",
      label: "Path review",
      status: "completed",
      summary: unsafeMarkdown,
    });

    const projected = projector.snapshot()[0]!;
    assert.ok(parseSubagentRunSnapshotV1(projected));
    assert.equal(
      parseSubagentRunSnapshotV1({
        ...projected,
        latestText: unsafeMarkdown,
        terminalMarkdown: unsafeMarkdown,
      }),
      undefined,
    );
    const rendered = renderToStaticMarkup(
      React.createElement(ReactMarkdown, null, projected.terminalMarkdown),
    );
    assert.match(rendered, /REDACTED_ABSOLUTE_PATH/u);
    assert.doesNotMatch(rendered, /Users|sambitbiswas|private|aiden\.txt/iu);
  }
});

test("reversible-encoding budgets finish safely or fail closed", () => {
  let sixteenLayerBase64 = "Hello world, safely";
  let seventeenLayerBase64 = "Hello world, safely";
  for (let depth = 0; depth < 16; depth += 1) {
    sixteenLayerBase64 = Buffer.from(sixteenLayerBase64, "utf-8").toString("base64");
    seventeenLayerBase64 = Buffer.from(seventeenLayerBase64, "utf-8").toString("base64");
  }
  seventeenLayerBase64 = Buffer.from(seventeenLayerBase64, "utf-8").toString("base64");
  assert.equal(sanitizeSubagentSnapshotText(sixteenLayerBase64), sixteenLayerBase64);
  assert.equal(sanitizeSubagentSnapshotText(seventeenLayerBase64), "[REDACTED ENCODED TEXT]");

  let sixteenLayerPercent = "Hello world";
  let seventeenLayerPercent = "Hello world";
  for (let depth = 0; depth < 16; depth += 1) {
    sixteenLayerPercent = encodeURIComponent(sixteenLayerPercent);
    seventeenLayerPercent = encodeURIComponent(seventeenLayerPercent);
  }
  seventeenLayerPercent = encodeURIComponent(seventeenLayerPercent);
  assert.equal(sanitizeSubagentSnapshotText(sixteenLayerPercent), sixteenLayerPercent);
  assert.equal(sanitizeSubagentSnapshotText(seventeenLayerPercent), "[REDACTED ENCODED TEXT]");
});

test("Base32 credentials and paths fail closed across variants and nesting", () => {
  const credential = "OPENAI_API_KEY=correct-horse-battery-staple";
  const privatePath = "/Users/alice/private.txt";
  const standardPadded = base32(credential);
  const standardUnpadded = base32(credential, undefined, false);
  const hexadecimal = base32(credential, "0123456789ABCDEFGHIJKLMNOPQRSTUV");
  const wrapped = standardPadded.match(/.{1,4}/gu)!.join("\n");
  const nested = base32(Buffer.from(credential, "utf8").toString("base64"));

  for (const encoded of [standardPadded, standardUnpadded, hexadecimal, wrapped, nested]) {
    assert.equal(containsHighConfidenceSecretIncludingEncodings(encoded), true);
    assert.equal(sanitizeSubagentSnapshotText(encoded), "[REDACTED ENCODED TEXT]");
  }
  assert.equal(sanitizeSubagentSnapshotText(base32(privatePath)), "[REDACTED ENCODED TEXT]");
  const safeBase32 = base32("Hello world", undefined, false);
  assert.equal(sanitizeSubagentSnapshotText(safeBase32), safeBase32);
});

test("framed irregular encodings stay private through projection, parsing, and Markdown", () => {
  const standardBase64 = Buffer.from("OPENAI_API_KEY=correct-horse-framed-base64", "utf8").toString(
    "base64",
  );
  const urlBase64 = Buffer.from("AUTH_TOKEN=correct-horse-framed-url-base64", "utf8").toString(
    "base64url",
  );
  const standardBase32 = base32("CLIENT_SECRET=correct-horse-framed-base32");
  const hexadecimalBase32 = base32(
    "DATABASE_URL=postgres://alice:correct-horse@example.test/private",
    "0123456789ABCDEFGHIJKLMNOPQRSTUV",
  );
  const nested = Buffer.from(base32("REFRESH_TOKEN=correct-horse-framed-nested"), "utf8").toString(
    "base64url",
  );
  const unsafeCases = [standardBase64, urlBase64, standardBase32, hexadecimalBase32, nested].map(
    (value) => frameWrappedEncoding(irregularWrap(value)),
  );

  let now = 1_100;
  for (const [index, unsafe] of unsafeCases.entries()) {
    assert.equal(containsHighConfidenceSecretIncludingEncodings(unsafe), true, unsafe);
    assert.equal(sanitizeSubagentSnapshotText(unsafe), "[REDACTED ENCODED TEXT]", unsafe);

    const projector = new SubagentEventProjector({
      generationId: `generation-framed-${index}`,
      chatId: "chat-framed",
      workspaceId: "workspace-framed",
      modelId: "model-framed",
      now: () => now,
    });
    const runId = `run-framed-${index}`;
    projector.begin(
      {
        runId,
        groupId: `generation-framed-${index}:group-1`,
        childId: `child-framed-${index}`,
      },
      { role: "reviewer", label: "Framed review", task: "Inspect framed output." },
    );
    now += 1;
    projector.finish(runId, {
      role: "reviewer",
      label: "Framed review",
      status: "completed",
      summary: unsafe,
    });

    const projected = projector.snapshot()[0]!;
    assert.ok(parseSubagentRunSnapshotV1(projected));
    assert.equal(
      parseSubagentRunSnapshotV1({
        ...projected,
        latestText: unsafe,
        terminalMarkdown: unsafe,
      }),
      undefined,
    );
    const rendered = renderToStaticMarkup(
      React.createElement(ReactMarkdown, null, projected.terminalMarkdown),
    );
    assert.match(rendered, /REDACTED/u);
    assert.doesNotMatch(rendered, /correct-horse|postgres|alice/u);
  }

  const benign = frameWrappedEncoding(
    irregularWrap(Buffer.from("Hello reversible encoding", "utf8").toString("base64url")),
  );
  assert.equal(containsHighConfidenceSecretIncludingEncodings(benign), false);
  assert.equal(sanitizeSubagentSnapshotText(benign), benign);
});

test("projector falls back safely when child text normalizes to empty", () => {
  let now = 500;
  const projector = new SubagentEventProjector({
    generationId: "generation-empty",
    chatId: "chat-empty",
    workspaceId: "workspace-empty",
    modelId: "model-empty",
    now: () => now,
  });
  projector.begin(
    {
      runId: "run-empty",
      groupId: "generation-empty:group-1",
      childId: "child-empty",
    },
    { role: "reviewer", label: "Empty review", task: "Review empty output." },
  );
  now += 200;
  assert.doesNotThrow(() => projector.textDelta("run-empty", " \t\n\r\u0000\u200b"));
  now += 1;
  assert.doesNotThrow(() =>
    projector.finish("run-empty", {
      role: "reviewer",
      label: "Empty review",
      status: "completed",
      summary: "\t\u0000\u200b",
    }),
  );

  const snapshot = projector.snapshot()[0]!;
  assert.equal(snapshot.state, "completed");
  assert.equal(snapshot.latestText, undefined);
  assert.equal(snapshot.terminalMarkdown, "[No textual result.]");
  assert.ok(parseSubagentRunSnapshotV1(snapshot));
});

test("projector preserves timestamp and revision monotonicity across a backward wall clock", () => {
  let now = 100;
  const projector = new SubagentEventProjector({
    generationId: "generation-clock",
    chatId: "chat-clock",
    workspaceId: "workspace-clock",
    modelId: "model-clock",
    now: () => now,
  });
  projector.begin(
    {
      runId: "run-clock",
      groupId: "generation-clock:group-1",
      childId: "child-clock",
    },
    { role: "reviewer", label: "Clock review", task: "Review monotonic state." },
  );

  now = 99;
  projector.starting("run-clock");
  now = 98;
  projector.running("run-clock");
  now = 97;
  projector.finish("run-clock", {
    role: "reviewer",
    label: "Clock review",
    status: "completed",
    summary: "Clean.",
  });

  const snapshot = projector.snapshot()[0]!;
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.state, "completed");
  assert.equal(snapshot.startedAt, 100);
  assert.equal(snapshot.updatedAt, 100);
  assert.equal(snapshot.finishedAt, 100);
  assert.ok(parseSubagentRunSnapshotV1(snapshot));
});

test("a newer stopped control snapshot fences every late telemetry and finish callback", async () => {
  let now = 1_000;
  const controls: unknown[] = [];
  const projector = new SubagentEventProjector({
    generationId: "generation-control",
    chatId: "chat-control",
    workspaceId: "workspace-control",
    modelId: "model-control",
    now: () => now,
    onControlSnapshot: async (snapshot) => {
      controls.push(snapshot);
    },
  });
  const identity = {
    runId: "run-control",
    groupId: "group-control",
    childId: "child-control",
  };
  projector.begin(identity, {
    role: "reviewer",
    label: "Review control",
    task: "Review stop fencing.",
  });
  now += 1;
  projector.starting(identity.runId);
  const current = projector.snapshot()[0]!;
  const stopped = {
    ...current,
    version: 2 as const,
    revision: current.revision + 1,
    state: "stopped" as const,
    activity: undefined,
    updatedAt: now + 1,
    finishedAt: now + 1,
    depth: 1,
    execution: "foreground" as const,
    context: "fresh" as const,
    authorityRevision: 1,
  };

  const projection = projector.applyControlSnapshot(stopped);
  projector.starting(identity.runId);
  projector.running(identity.runId);
  projector.turnStarted(identity.runId);
  projector.toolStarted(identity.runId, "read_file");
  projector.finish(identity.runId, {
    role: "reviewer",
    label: "Review control",
    status: "completed",
    summary: "Late completion must not win.",
  });
  await projector.flush();

  assert.equal(projection.state, "interrupted");
  assert.equal(projector.snapshot()[0]!.revision, stopped.revision);
  assert.equal(projector.snapshot()[0]!.state, "interrupted");
  assert.equal(controls.length, 1);
});

test("control projection rejects stale, non-stop, foreign, and post-terminal transitions", () => {
  const projector = new SubagentEventProjector({
    generationId: "generation-control-reject",
    chatId: "chat-control-reject",
    workspaceId: "workspace-control-reject",
    modelId: "model-control-reject",
    now: () => 2_000,
  });
  projector.begin(
    { runId: "run-control-reject", groupId: "group-control-reject", childId: "child-control-reject" },
    { role: "reviewer", label: "Review", task: "Reject invalid controls." },
  );
  const current = projector.snapshot()[0]!;
  const stopped = {
    ...current,
    version: 2 as const,
    revision: current.revision + 1,
    state: "stopped" as const,
    activity: undefined,
    updatedAt: current.updatedAt + 1,
    finishedAt: current.updatedAt + 1,
    depth: 1,
    execution: "foreground" as const,
    context: "fresh" as const,
    authorityRevision: 1,
  };

  assert.throws(
    () => projector.applyControlSnapshot({ ...stopped, revision: current.revision }),
    /moved backward/u,
  );
  assert.throws(
    () => projector.applyControlSnapshot({ ...stopped, state: "completed" }),
    /terminal control/u,
  );
  assert.throws(
    () => projector.applyControlSnapshot({ ...stopped, childId: "child-foreign" }),
    /immutable run identity/u,
  );
  projector.applyControlSnapshot(stopped);
  assert.throws(() => projector.applyControlSnapshot({ ...stopped, revision: stopped.revision + 1 }), /moved backward/u);
});

test("assistant message reference is bounded, terminal-only, and strictly parsed", () => {
  let now = 10;
  const projector = new SubagentEventProjector({
    generationId: "generation-3",
    chatId: "chat-3",
    workspaceId: "workspace-3",
    modelId: "model-3",
    now: () => now,
  });
  projector.begin(
    { runId: "run-3", groupId: "generation-3:group-1", childId: "child-3" },
    { role: "planner", label: "Plan", task: "Plan the change." },
  );
  now += 1;
  projector.finish("run-3", {
    role: "planner",
    label: "Plan",
    status: "timed_out",
    summary: "",
    warning: "The child reached its deadline.",
  });
  const reference = subagentMessageReference("generation-3", projector.snapshot());
  assert.deepEqual(reference, {
    version: 1,
    generationId: "generation-3",
    runIds: ["run-3"],
    items: [
      {
        runId: "run-3",
        label: "Plan",
        role: "planner",
        state: "timed_out",
      },
    ],
    total: 1,
    completed: 0,
    failed: 0,
    timedOut: 1,
    interrupted: 0,
  });
  assert.deepEqual(parseSubagentMessageReferenceV1(reference), reference);
  assert.equal(parseSubagentMessageReferenceV1({ ...reference, failed: 1 }), undefined);
});
