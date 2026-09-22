import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySessionRepo, prepareCompaction } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createPiSessionPort } from "../pi-session-port.js";
import { PiCompactionCoordinator } from "../pi-compaction-core.js";
import { compileVcc } from "./compiler.js";
import { compilerMessage, archiveFromBranch, sourceForPreparation } from "./history.js";
import { recallVcc } from "./recall-core.js";
import { createVccRecallTool } from "./recall.js";
import { vccErrorMessage, vccFailureCode, VccError } from "./errors.js";
import { compileVccInWorker, runVccWorker } from "./worker-client.js";

const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 300 };
async function fixture() {
  const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: "vcc-test" }));
  const faux = fauxProvider({
    api: "openai-completions",
    provider: "vcc-faux",
    models: [{ id: "model", contextWindow: 16000, maxTokens: 2000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  for (let i = 0; i < 14; i++) {
    await session.appendMessage({
      role: "user",
      content: `Goal ${i}: preserve database v2. Always keep user preferences. ${"Explain the existing implementation carefully. ".repeat(160)}`,
      timestamp: i + 1,
    });
  }
  await session.appendMessage({ role: "user", content: "Now update documentation", timestamp: 50 });
  const branch = await session.getBranch();
  const prepared = prepareCompaction(branch, settings);
  assert.ok(prepared.ok && prepared.value);
  return {
    session,
    faux,
    models,
    model: faux.getModel(),
    input: { branch, preparation: prepared.value, contextWindow: 16000 },
  };
}

test("ranked compiler is deterministic, keeps Pi's exact tail, and reduces full context", async () => {
  const { input } = await fixture();
  const a = compileVcc(input),
    b = compileVcc(input);
  assert.deepEqual(a, b);
  assert.deepEqual(a.retainedTail, input.preparation.retainedTail);
  assert.match(a.summary, /database v2/);
  assert.ok(a.summary.length < 15000);
  assert.equal(a.details.engine, "vcc");
  assert.equal(Object.prototype.hasOwnProperty.call(a, "usage"), false);
});

test("worker produces the same checkpoint and honors pre-cancellation", async () => {
  const { input } = await fixture();
  assert.deepEqual(await compileVccInWorker(input), compileVcc(input));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(compileVccInWorker(input, controller.signal), { name: "AbortError" });
  const running = new AbortController();
  const pending = compileVccInWorker(input, running.signal);
  const timer = setTimeout(() => running.abort(), 1);
  try {
    await assert.rejects(pending, { name: "AbortError" });
  } finally {
    clearTimeout(timer);
  }
});

test("coordinator VCC commits without using provider streams; worker failure preserves leaf", async () => {
  const { session, models, model } = await fixture();
  models.completeSimple = () => {
    throw new Error("VCC must never call inference");
  };
  const leaf = await session.getLeafId();
  const failure = await new PiCompactionCoordinator({
    session,
    models,
    model,
    settings,
    thinkingLevel: "off",
    engine: "vcc",
    compileVcc: async () => {
      throw new Error("worker failed");
    },
  }).compact();
  assert.equal(failure.compacted, false);
  assert.equal(await session.getLeafId(), leaf);
  const success = await new PiCompactionCoordinator({
    session,
    models,
    model,
    settings,
    thinkingLevel: "off",
    engine: "vcc",
  }).compact();
  assert.equal(success.compacted, true);
  assert.equal(success.shouldRetry, false);
  assert.equal(success.messages?.[0].role, "compactionSummary");
});

test("active worker cancellation cannot append a checkpoint", async () => {
  const { session, models, model, input } = await fixture();
  const controller = new AbortController();
  const leaf = await session.getLeafId();
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    settings,
    thinkingLevel: "off",
    engine: "vcc",
    signal: controller.signal,
    compileVcc: async () => {
      controller.abort();
      return compileVcc(input);
    },
  }).compact();
  assert.equal(result.compacted, false);
  assert.equal(await session.getLeafId(), leaf);
});

test("LLM → VCC rebuilds original history; repeated VCC avoids duplicate retained messages", async () => {
  const { session, models, model, input } = await fixture();
  await session.appendCompaction({
    id: "old-llm",
    summary: "## Goal\nPreserve database v2.",
    retainedTail: input.preparation.retainedTail,
    tokensBefore: 10000,
  });
  await session.appendMessage({ role: "user", content: "Next change ".repeat(700), timestamp: 60 });
  let coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    settings,
    thinkingLevel: "off",
    engine: "vcc",
  });
  assert.equal((await coordinator.compact()).compacted, true);
  const first = await session.getBranch();
  const count = archiveFromBranch(first).messages.length;
  await session.appendMessage({
    role: "user",
    content: "Another change ".repeat(700),
    timestamp: 61,
  });
  coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    settings,
    thinkingLevel: "off",
    engine: "vcc",
  });
  assert.equal((await coordinator.compact()).compacted, true);
  assert.equal(archiveFromBranch(await session.getBranch()).messages.length, count + 1);
  assert.match(
    recallVcc({ kind: "recall", branch: await session.getBranch(), query: "database v2" }),
    /database v2/,
  );
});

test("imported summary-only gaps survive VCC without using its LLM-summary parser", async () => {
  const { session, input } = await fixture();
  await session.moveTo(null);
  await session.appendCompaction({
    id: "imported",
    summary: "## Goal\nPreserve database schema v2.\n## Progress\nMigration was already completed.",
    retainedTail: [],
    tokensBefore: 40000,
  });
  for (const entry of input.branch)
    if (entry.type === "message") await session.appendMessage(entry.message);
  const branch = await session.getBranch();
  const prepared = prepareCompaction(branch, settings);
  assert.ok(prepared.ok && prepared.value);
  const result = compileVcc({ branch, preparation: prepared.value, contextWindow: 16000 });
  assert.match(result.summary, /Migration was already completed/);
  assert.match(result.summary, /Preserve database schema v2/);
});

test("recall references survive checkpoints and exclude sibling branches", async () => {
  const { session, input } = await fixture();
  const original = input.branch[0].id;
  const leaf = await session.getLeafId();
  await session.appendMessage({ role: "user", content: "sibling-private-value", timestamp: 90 });
  await session.moveTo(leaf);
  await session.appendCompaction({ id: "checkpoint", ...compileVcc(input) });
  const branch = await session.getBranch();
  assert.match(recallVcc({ kind: "recall", branch, reference: original }), /Goal 0/);
  assert.doesNotMatch(
    recallVcc({ kind: "recall", branch, query: "sibling-private-value" }),
    /sibling-private-value/,
  );
  const tool = createVccRecallTool(async () => session);
  const response = await tool.execute("recall", { reference: original });
  assert.match(JSON.stringify(response), /Goal 0/);
  assert.equal(response.details, null);
});

test("projection omits hidden reasoning, signatures, binary data and credentials", () => {
  const message = fauxAssistantMessage("public");
  message.content = [
    {
      type: "thinking",
      thinking: "hidden-private-reasoning",
      thinkingSignature: "secret-signature",
    },
    {
      type: "toolCall",
      id: "tool-1",
      name: "run_command",
      arguments: { command: "npm test", password: "secret-password" },
    },
    { type: "text", text: "public" },
  ];
  const output = JSON.stringify(compilerMessage(message));
  assert.doesNotMatch(output, /hidden-private-reasoning|secret-signature|secret-password/);
  assert.match(output, /npm test/);
  const image = compilerMessage({
    role: "user",
    content: [{ type: "image", data: "private-base64", mimeType: "image/png" }],
    timestamp: 1,
  });
  assert.match(JSON.stringify(image), /image\/png/);
  assert.doesNotMatch(JSON.stringify(image), /private-base64/);
});

test("unknown boundaries, tiny windows and unusable summaries fail without truncating the tail", async () => {
  const { input } = await fixture();
  assert.throws(
    () => compileVcc({ ...input, contextWindow: 100 }),
    /could not reduce|no usable summary/,
  );
  assert.throws(
    () =>
      sourceForPreparation(input.branch, {
        ...input.preparation,
        retainedTail: [{ role: "user", content: "not in this branch", timestamp: 1 }],
      }),
    /safe history boundary/,
  );
});

test("VCC → LLM remains compatible and recall continues to resolve old references", async () => {
  const { session, models, model, faux } = await fixture();
  const reference = (await session.getBranch())[0].id;
  assert.equal(
    (
      await new PiCompactionCoordinator({
        session,
        models,
        model,
        settings,
        thinkingLevel: "off",
        engine: "vcc",
      }).compact()
    ).compacted,
    true,
  );
  await session.appendMessage({
    role: "user",
    content: "Continue documentation work ".repeat(300),
    timestamp: 70,
  });
  const summary =
    "## Goal\nPreserve database v2.\n\n## Constraints & Preferences\n- Keep compatibility\n\n## Progress\n### Done\n- [x] reviewed\n### In Progress\n- [ ] documentation\n### Blocked\n- none\n\n## Key Decisions\n- keep schema\n\n## Next Steps\n1. Finish documentation\n\n## Critical Context\n- database v2";
  faux.setResponses([fauxAssistantMessage(summary)]);
  assert.equal(
    (
      await new PiCompactionCoordinator({
        session,
        models,
        model,
        settings,
        thinkingLevel: "off",
        engine: "llm",
      }).compact()
    ).compacted,
    true,
  );
  assert.match(
    recallVcc({ kind: "recall", branch: await session.getBranch(), reference }),
    /Goal 0/,
  );
});

test("a changed journal leaf during compilation cannot receive a stale checkpoint", async () => {
  const { session, models, model, input } = await fixture();
  const result = await new PiCompactionCoordinator({
    session,
    models,
    model,
    settings,
    thinkingLevel: "off",
    engine: "vcc",
    compileVcc: async () => {
      await session.appendMessage({
        role: "user",
        content: "A newer owner wrote this",
        timestamp: 100,
      });
      return compileVcc(input);
    },
  }).compact();
  assert.equal(result.compacted, false);
  assert.equal(
    (await session.getBranch()).filter((entry) => entry.type === "compaction").length,
    0,
  );
});

test("tool-heavy transcripts use stable refs and Aiden run_command commit evidence", async () => {
  const { session } = await fixture();
  const message = fauxAssistantMessage("");
  message.timestamp = 70;
  message.content = [
    {
      type: "toolCall",
      id: "commit",
      name: "run_command",
      arguments: { command: "git commit -m 'Fix refresh tokens'" },
    },
  ];
  const reference = await session.appendMessage(message);
  await session.appendMessage({
    role: "toolResult",
    toolCallId: "commit",
    toolName: "run_command",
    content: [{ type: "text", text: "[main a1b2c3d] Fix refresh tokens" }],
    details: null,
    isError: false,
    timestamp: 71,
  });
  await session.appendMessage({
    role: "user",
    content: "Update documentation ".repeat(600),
    timestamp: 72,
  });
  const branch = await session.getBranch();
  const prepared = prepareCompaction(branch, settings);
  assert.ok(prepared.ok && prepared.value);
  const compiled = compileVcc({ branch, preparation: prepared.value, contextWindow: 16000 });
  assert.match(compiled.summary, /a1b2c3d: Fix refresh tokens/);
  assert.ok(compiled.summary.includes(`ref:${reference}`));
  assert.doesNotMatch(compiled.summary, /\(#\d+\)/);
});

test("synthetic replay reports semantic retention separately from searchable history", async () => {
  const { runVccReplayCases } = await import("./evaluation.js");
  const report = await runVccReplayCases();
  assert.equal(report.measurements.length, 2);
  for (const measurement of report.measurements) {
    assert.ok(measurement.estimatedTokensAfter < measurement.tokensBefore);
    assert.ok(measurement.facts.every((fact) => fact.recalled));
    assert.ok(measurement.durationMs > 0);
    assert.ok(measurement.processPeakRssBytes > 0);
  }
});

test("v4 restart preserves the VCC checkpoint and exact recall references; deletion removes its source", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createCurrentPiSessionRepository } = await import("../pi-session-repository-port.js");
  const root = await mkdtemp(path.join(tmpdir(), "aiden-vcc-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = createCurrentPiSessionRepository(root);
  const session = await repo.create({ id: "vcc-restart", cwd: root, metadata: {} });
  const { input, models, model } = await fixture();
  for (const entry of input.branch)
    if (entry.type === "message") await session.appendMessage(entry.message);
  const reference = (await session.getBranch())[0].id;
  assert.equal(
    (
      await new PiCompactionCoordinator({
        session,
        models,
        model,
        settings,
        engine: "vcc",
        thinkingLevel: "off",
      }).compact()
    ).compacted,
    true,
  );
  const metadata = await session.getMetadata();
  const reopened = await createCurrentPiSessionRepository(root).open(metadata);
  assert.deepEqual(await reopened.buildContext(), await session.buildContext());
  assert.match(
    recallVcc({ kind: "recall", branch: await reopened.getBranch(), reference }),
    /Goal 0/,
  );
  await repo.delete(metadata);
  assert.equal((await repo.list()).length, 0);
});

test("worker queue cancels waiting work without blocking other chats", async () => {
  const { input } = await fixture();
  const first = compileVccInWorker(input);
  const second = compileVccInWorker(input);
  const controller = new AbortController();
  const queued = compileVccInWorker(input, controller.signal);
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await compileVccInWorker(input), results[0]);
});

test("recall locates facts late in large tool results, including exact-ref queries", async () => {
  const { session } = await fixture();
  const reference = await session.appendMessage({
    role: "toolResult",
    toolName: "run_command",
    toolCallId: "long-output",
    timestamp: 80,
    content: [
      {
        type: "text",
        text:
          "Unrelated output. ".repeat(6000) + "Late evidence: deployment finished successfully.",
      },
    ],
    details: null,
    isError: false,
  });
  for (const ref of [undefined, reference]) {
    const recalled = recallVcc({
      kind: "recall",
      branch: await session.getBranch(),
      reference: ref,
      query: "deployment",
    });
    assert.match(recalled, /deployment finished successfully/);
    assert.ok(recalled.length < 7000);
  }
});

test("VCC overflow recovery retries once without a summary provider call", async () => {
  const { session, models, model } = await fixture();
  models.completeSimple = () => {
    throw new Error("No paid summary fallback");
  };
  const overflow = fauxAssistantMessage("");
  overflow.stopReason = "error";
  overflow.errorMessage = "Request exceeds the context window.";
  overflow.provider = model.provider;
  overflow.model = model.id;
  overflow.timestamp = Date.now();
  await session.appendMessage(overflow);
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    settings,
    engine: "vcc",
    thinkingLevel: "off",
  });
  const first = await coordinator.check(overflow);
  assert.equal(first.compacted, true);
  assert.equal(first.shouldRetry, true);
  assert.equal(
    first.messages?.some(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
    false,
  );
  await session.appendMessage({ ...overflow, timestamp: Date.now() + 100 });
  const second = await coordinator.check({ ...overflow, timestamp: Date.now() + 100 });
  assert.equal(second.compacted, false);
  assert.equal(second.shouldRetry, false);
  assert.equal(
    (await session.getBranch()).filter((entry) => entry.type === "compaction").length,
    1,
  );
});

test("tool arguments and text omit inline binary payloads while keeping attachment markers", () => {
  const message = fauxAssistantMessage("");
  message.content = [
    {
      type: "toolCall",
      id: "image",
      name: "display_image",
      arguments: {
        image: { type: "image", data: "private-small-binary", mimeType: "image/png" },
        dataUrl: "data:image/png;base64,cHJpdmF0ZQ==",
        bytes: new Uint8Array([12, 34, 56]),
        caption: "Diagram for the architecture",
      },
    },
  ];
  const projected = JSON.stringify(compilerMessage(message));
  assert.doesNotMatch(projected, /private-small-binary|cHJpdmF0ZQ|12,34,56/);
  assert.match(projected, /attachment omitted/);
  assert.match(projected, /Diagram for the architecture/);
});

test("worker preserves safe compilation failure reasons and gives recall-specific errors", async () => {
  const { input } = await fixture();
  await assert.rejects(
    compileVccInWorker({ ...input, contextWindow: 1 }),
    /produced no usable summary/,
  );
  await assert.rejects(
    compileVccInWorker({
      ...input,
      preparation: {
        ...input.preparation,
        retainedTail: [{ role: "user", content: "missing boundary", timestamp: -1 }],
      },
    }),
    /safe history boundary/,
  );
  const { session: imported } = await fixture();
  await imported.moveTo(null);
  await imported.appendCompaction({
    id: "opaque-gap",
    summary: "An imported decision must survive.",
    retainedTail: [],
    tokensBefore: 40000,
  });
  await assert.rejects(
    compileVccInWorker({
      ...input,
      branch: [...(await imported.getBranch()), ...input.branch],
      contextWindow: 1,
    }),
    /could not reduce context enough/,
  );
  // Small entries exercise the bound without allocating a large transcript.
  const branch = Array.from({ length: 100001 }, () => input.branch[input.branch.length - 1]);
  await assert.rejects(compileVccInWorker({ ...input, branch }), /bounded processing limit/);
  await assert.rejects(
    runVccWorker({ kind: "recall", branch, query: "history" }),
    /bounded local recall processing limit/,
  );
  await assert.rejects(
    runVccWorker({ kind: "recall", branch: [], query: "" }),
    /Missing recall query. Provide keywords or a history reference/,
  );
});

test("unknown worker errors cannot reflect private content or suggest compaction for recall", () => {
  const privateText = "PRIVATE_HISTORY_AND_CREDENTIALS";
  assert.equal(vccFailureCode(new Error(privateText)), "worker_failed");
  assert.equal(vccFailureCode(new VccError("unsafe_boundary")), "unsafe_boundary");
  for (const code of [
    privateText,
    "__proto__",
    "insufficient_reduction",
    "worker_failed",
    "timeout",
  ]) {
    const message = vccErrorMessage("recall", code);
    assert.doesNotMatch(message, /PRIVATE|compact-LLM|larger-context/);
    assert.match(message, /recall/);
  }
});
