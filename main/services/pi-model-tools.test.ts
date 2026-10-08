import assert from "node:assert/strict";
import { createPiModelImageReferences } from "./pi-model-image-references.js";
import type { Attachment } from "./types.js";
import test from "node:test";
import type {
  AssistantImages,
  ClassifierResult,
  ImageContent,
  Usage,
} from "@earendil-works/pi-ai";
import {
  createPiModelTools,
  classifierApprovalFor,
  piModelOperationProviderLabel,
  piModelOperationUsage,
  resolvePiModelImageInputs,
  type PiModelToolsHost,
} from "./pi-model-tools.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
const image: ImageContent = { type: "image", mimeType: "image/png", data: PNG };
const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
const questionSet = {
  category: {
    type: "choice",
    instructions: "Choose the topic",
    criteria: { code: "Software", other: "Other topics" },
  },
  urgency: {
    type: "score",
    instructions: "Rate urgency",
    criteria: ["Low", "High"],
  },
  relevant: {
    type: "bool",
    instructions: "Is it relevant?",
    criteria: { true: "Relevant", false: "Irrelevant" },
  },
};
function fixture() {
  const catalog = [
    {
      type: "image",
      input: ["text", "image"],
      provider: "fixture",
      id: "image",
      name: "Image",
      api: "fixture-images",
      baseUrl: "https://secret.invalid",
      headers: { Authorization: "must-never-leak" },
    },
    {
      type: "classifier",
      provider: "fixture",
      id: "classifier",
      name: "Classifier",
      api: "fixture-classifier",
      baseUrl: "https://secret.invalid",
    },
  ];
  const controls = {
    catalog,
    spoof: false,
    imageCalls: 0,
    classifyCalls: 0,
    listed: 0,
    imageSignal: undefined as AbortSignal | undefined,
    imageContext: undefined as unknown,
    classifierContext: undefined as unknown,
    classifierSignal: undefined as AbortSignal | undefined,
    imageEffect: undefined as (() => void) | undefined,
    imageResult: {
      api: "fixture-images",
      provider: "fixture",
      model: "image",
      output: [image],
      usage,
      stopReason: "stop",
      timestamp: 1,
    } as AssistantImages,
    classifierResult: {
      api: "fixture-classifier",
      provider: "fixture",
      model: "classifier",
      answers: {
        category: {
          type: "choice",
          choice: "code",
          probabilities: { code: 0.9, other: 0.1 },
          confidence: 0.9,
        },
        urgency: { type: "score", score: 0.7, confidence: 0.8 },
        relevant: { type: "bool", probability: 0.95 },
      },
      usage,
      stopReason: "stop",
      timestamp: 1,
    } as ClassifierResult,
  };
  const models = {
    getAvailableOfType: async (type: string) => {
      controls.listed++;
      return catalog.filter((entry) => entry.type === type);
    },
    getModelOfType: (type: string, provider: string, id: string) =>
      controls.spoof
        ? catalog[1]
        : catalog.find(
            (entry) =>
              entry.type === type &&
              entry.provider === provider &&
              entry.id === id,
          ),
    generateImages: async (
      _model: unknown,
      _context: unknown,
      options: { signal?: AbortSignal },
    ) => {
      controls.imageCalls++;
      controls.imageSignal = options.signal;
      controls.imageContext = _context;
      controls.imageEffect?.();
      return controls.imageResult;
    },
    classify: async (
      _model: unknown,
      _context: unknown,
      options: { signal?: AbortSignal },
    ) => {
      controls.classifyCalls++;
      controls.classifierContext = _context;
      controls.classifierSignal = options.signal;
      return controls.classifierResult;
    },
  } as unknown as PiModelToolsHost["models"];
  const staged: ImageContent[] = [];
  const tools = createPiModelTools({
    models,
    onImage: async (_id, item) => {
      staged.push(item);
    },
  });
  const get = (name: string) => tools.find((tool) => tool.name === name)!;
  return { controls, models, tools, get, staged };
}
const imageRequest = {
  provider: "fixture",
  model: "image",
  prompt: "Draw a small lighthouse",
};
const classifierRequest = {
  provider: "fixture",
  model: "classifier",
  state: { subject: "Please review this code", count: 2 },
  questions: questionSet,
};

test("operation inventory includes only projected image/classifier metadata, never credentials or endpoints", async () => {
  const { get, controls } = fixture();
  const result = await get("list_operation_models").execute("list", {});
  assert.deepEqual(result.structuredContent, {
    models: [
      {
        provider: "fixture",
        model: "image",
        label: "Image",
        type: "image",
        acceptsReferenceImages: true,
      },
      {
        provider: "fixture",
        model: "classifier",
        label: "Classifier",
        type: "classifier",
      },
    ],
    truncated: false,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret.invalid|Authorization|must-never-leak/,
  );
  assert.equal(controls.imageCalls + controls.classifyCalls, 0);
  const single = await get("list_operation_models").execute("list", {
    type: "classifier",
  });
  assert.equal(
    (single.structuredContent as { models: unknown[] }).models.length,
    1,
  );
  controls.catalog.push(
    ...Array.from({ length: 105 }, (_, i) => ({
      ...controls.catalog[0]!,
      id: `image-${i}`,
    })),
  );
  const bounded = await get("list_operation_models").execute("list", {
    type: "image",
  });
  assert.equal(
    (bounded.structuredContent as { models: unknown[] }).models.length,
    100,
  );
  assert.equal(
    (bounded.structuredContent as { truncated: boolean }).truncated,
    true,
  );
});

test("image generation validates an entire batch before staging and carries usage", async () => {
  const { get, staged, controls } = fixture();
  const signal = new AbortController().signal;
  const result = await get("generate_image").execute(
    "generate",
    imageRequest,
    signal,
  );
  assert.equal(result.isError, undefined);
  assert.equal(
    result.content.filter((part) => part.type === "image").length,
    1,
  );
  assert.deepEqual(staged, [image]);
  assert.deepEqual(result.usage, usage);
  assert.equal(controls.imageSignal, signal);
  staged.length = 0;
  controls.imageResult.output = [image, { ...image, data: "!!!!" }];
  const invalid = await get("generate_image").execute("invalid", imageRequest);
  assert.equal(invalid.isError, true);
  assert.deepEqual(invalid.usage, usage);
  assert.deepEqual(
    staged,
    [],
    "a later malformed image must not leave earlier images staged",
  );
});

test("model type and request validation reject endpoints, credentials, oversized input and wrong inventories before requests", async () => {
  const { get, controls } = fixture();
  for (const args of [
    { ...imageRequest, endpoint: "https://attacker.invalid" },
    { ...imageRequest, apiKey: "secret" },
    { ...imageRequest, prompt: "x".repeat(16_385) },
    { ...imageRequest, model: "classifier" },
  ]) {
    await assert.rejects(get("generate_image").execute("invalid", args));
  }
  controls.spoof = true;
  await assert.rejects(
    get("generate_image").execute("wrong-kind", imageRequest),
    /Unknown image model/,
  );
  assert.equal(controls.imageCalls, 0);
});

test("image errors, cancellation, output limits and artifact failures retain billed usage without success artifacts", async () => {
  const { get, controls, staged, models } = fixture();
  for (const stopReason of ["error", "aborted"] as const) {
    controls.imageResult.stopReason = stopReason;
    const result = await get("generate_image").execute("failed", imageRequest);
    assert.equal(result.isError, true);
    assert.deepEqual(result.usage, usage);
    assert.equal(staged.length, 0);
  }
  controls.imageResult.stopReason = "stop";
  for (const output of [
    Array.from({ length: 5 }, () => image),
    [{ ...image, data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }],
    [{ ...image, mimeType: "image/jpeg" }],
    [],
  ]) {
    controls.imageResult.output = output;
    const result = await get("generate_image").execute(
      "oversized",
      imageRequest,
    );
    assert.equal(result.isError, true);
    assert.deepEqual(result.usage, usage);
    assert.equal(staged.length, 0);
  }
  controls.imageResult.output = [image];
  const controller = new AbortController();
  controls.imageEffect = () => controller.abort();
  const cancelled = await get("generate_image").execute(
    "cancelled",
    imageRequest,
    controller.signal,
  );
  assert.equal(cancelled.isError, true);
  assert.deepEqual(cancelled.usage, usage);
  assert.equal(staged.length, 0);
  controls.imageEffect = undefined;
  const failingArtifact = createPiModelTools({
    models,
    onImage: async () => {
      throw new Error("Disk full");
    },
  }).find((tool) => tool.name === "generate_image")!;
  const result = await failingArtifact.execute("disk", imageRequest);
  assert.equal(result.isError, true);
  assert.deepEqual(result.usage, usage);
});

test("classification supports choice, score and bool answers with bounded structured state and usage", async () => {
  const { get, controls } = fixture();
  const signal = new AbortController().signal;
  const result = await get("classify").execute(
    "classification",
    classifierRequest,
    signal,
  );
  assert.deepEqual(result.structuredContent, {
    answers: controls.classifierResult.answers,
  });
  assert.deepEqual(result.usage, usage);
  assert.equal(controls.classifierSignal, signal);
  assert.equal(controls.classifyCalls, 1);
});

test("malformed classifier questions/state cannot trigger requests or evaluate accessors", async () => {
  const { get, controls } = fixture();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let accessed = false;
  for (const state of [
    [],
    cycle,
    { text: "x".repeat(32_769) },
    {
      get secret() {
        accessed = true;
        return "private";
      },
    },
  ]) {
    await assert.rejects(
      get("classify").execute("invalid", { ...classifierRequest, state }),
    );
  }
  for (const questions of [
    {},
    { q: { type: "boolean", instructions: "x", criteria: {} } },
    { q: { type: "bool", instructions: "x", criteria: { true: "yes" } } },
    { q: { type: "score", instructions: "x", criteria: ["one"] } },
    {
      q: {
        type: "choice",
        instructions: "x",
        criteria: { only: "One" },
        endpoint: "extra",
      },
    },
  ]) {
    await assert.rejects(
      get("classify").execute("invalid", { ...classifierRequest, questions }),
    );
  }
  assert.equal(accessed, false);
  assert.equal(controls.classifyCalls, 0);
});

test("classifier provider failures and invalid answer identities preserve usage and never present partial answers", async () => {
  const { get, controls } = fixture();
  controls.classifierResult.stopReason = "error";
  const failure = await get("classify").execute("error", classifierRequest);
  assert.equal(failure.isError, true);
  assert.deepEqual(failure.usage, usage);
  controls.classifierResult.stopReason = "stop";
  controls.classifierResult.answers.category = {
    type: "choice",
    choice: "unrequested",
    probabilities: { unrequested: 1 },
    confidence: 1,
  };
  const invalid = await get("classify").execute("invalid", classifierRequest);
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  assert.deepEqual(invalid.usage, usage);
  await assert.rejects(
    get("classify").execute("aborted", classifierRequest, AbortSignal.abort()),
    /abort/i,
  );
  assert.equal(controls.classifyCalls, 2);
});

test("provider accounting is once per paid call and survives failed rendering and provider results", async () => {
  const { models, controls } = fixture();
  const records: Parameters<NonNullable<PiModelToolsHost["onUsage"]>>[0][] = [];
  const tools = createPiModelTools({
    models,
    onImage: async () => {
      throw new Error("staging unavailable");
    },
    onUsage: async (record) => {
      records.push(record);
    },
  });
  const generated = await tools[1]!.execute("render-failure", imageRequest);
  assert.equal(generated.isError, true);
  assert.deepEqual(generated.usage, usage);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.model, "image");
  assert.equal(records[0]!.status, "completed"); // Paid inference succeeded even though presentation failed.
  controls.classifierResult.stopReason = "error";
  await tools[2]!.execute("provider-failure", classifierRequest);
  assert.equal(records.length, 2);
  assert.equal(records[1]!.status, "failed");
  assert.deepEqual(records[1]!.usage, usage);
  await tools[0]!.execute("inventory", {});
  assert.equal(records.length, 2);
  models.classify = async () => {
    throw new Error("network failed");
  };
  await assert.rejects(
    tools[2]!.execute("network", classifierRequest),
    /network failed/,
  );
  assert.equal(records.length, 3);
  assert.equal(records[2]!.status, "failed");
  assert.equal(records[2]!.usage, undefined);
});

test("real codemode nested paid calls retain host disclosure admission and bill once", async () => {
  const { createFauxCore, fauxAssistantMessage, fauxToolCall } =
    await import("@earendil-works/pi-ai/providers/faux");
  const { PiAgentRuntimeHarness } =
    await import("./pi-agent-runtime-harness.js");
  const { createPiCodemodeTool } = await import("./pi-codemode.js");
  const { DISCLOSURE_APPROVAL_TOOL_NAMES } = await import("./coding-tools.js");
  const { convertToLlm } = await import("./pi-legacy-harness.js");
  for (const allow of [false, true]) {
    const { models, controls } = fixture();
    let charged = 0,
      prompts = 0;
    const modelTools = createPiModelTools({
      models,
      onImage: async () => {},
      onUsage: async () => {
        charged++;
      },
    });
    const core = createFauxCore({ provider: `model-operations-${allow}` });
    core.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `const r = await tools.generate_image(${JSON.stringify(imageRequest)}); text(r.isError);`,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    let harness!: InstanceType<typeof PiAgentRuntimeHarness>;
    const codemode = createPiCodemodeTool({
      tools: () => harness.getCallableTools(),
      executeTool: (...args) => harness.executeNestedToolCall(...args),
    });
    harness = new PiAgentRuntimeHarness({
      convertToLlm,
      streamFn: core.streamSimple,
      initialState: {
        model: core.getModel(),
        systemPrompt: "Test",
        thinkingLevel: "off",
        messages: [],
        tools: [...modelTools, codemode],
      },
      beforeToolCall: async ({ toolCall }) => {
        if (!DISCLOSURE_APPROVAL_TOOL_NAMES.has(toolCall.name)) return;
        prompts++;
        return allow
          ? undefined
          : { block: true, reason: "User declined disclosure" };
      },
    });
    let countedTokens = 0;
    harness.subscribe((event) => {
      if (event.type === "tool_execution_end")
        countedTokens +=
          piModelOperationUsage(event.toolName, event.result)?.totalTokens ?? 0;
    });
    try {
      await harness.prompt("run");
      assert.equal(countedTokens, allow ? 15 : 0);
      assert.equal(prompts, 1);
      assert.equal(controls.imageCalls, allow ? 1 : 0);
      assert.equal(charged, allow ? 1 : 0);
      const parent = harness.state.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "codemode",
      );
      assert.ok(parent?.role === "toolResult");
      assert.equal(
        (parent.content[0] as { text: string }).text,
        allow ? "false" : "true",
      );
    } finally {
      await harness.dispose();
    }
  }
});

test("accounting failures cannot erase paid result usage or mask provider errors", async () => {
  const { models } = fixture();
  let presented = 0;
  const tools = createPiModelTools({
    models,
    onImage: async () => {
      presented++;
    },
    onUsage: async () => {
      throw new Error("local ledger unavailable");
    },
  });
  const generated = await tools[1]!.execute("paid", imageRequest);
  assert.equal(generated.isError, undefined);
  assert.deepEqual(generated.usage, usage);
  assert.equal(presented, 1);
  models.classify = async () => {
    throw new Error("original provider failure");
  };
  await assert.rejects(
    tools[2]!.execute("failed", classifierRequest),
    /original provider failure/,
  );
});

function referenceAttachment(id = "chat-image"): Attachment {
  return {
    id,
    name: "Original.png",
    kind: "image",
    mimeType: "image/png",
    size: Buffer.from(PNG, "base64").length,
    data: PNG,
  };
}

test("image references list metadata only and edit with current-chat images after explicit disclosure", async () => {
  const attachment = referenceAttachment();
  const generated = referenceAttachment("generated-image");
  let current = [attachment];
  let chatReads = 0;
  const references = createPiModelImageReferences({
    snapshot: current,
    readCurrent: async () => {
      chatReads++;
      return current;
    },
    generated: () => [generated],
  });
  const { models, controls } = fixture();
  let accounted = 0;
  const tools = createPiModelTools({
    models,
    ...references,
    onUsage: async () => {
      accounted++;
    },
    onImage: async () => {},
  });
  const listed = await tools
    .find((tool) => tool.name === "list_image_references")!
    .execute("list", {});
  assert.deepEqual(
    (listed.structuredContent as { images: { id: string }[] }).images.map(
      (item) => item.id,
    ),
    ["chat-image", "generated-image"],
  );
  assert.doesNotMatch(JSON.stringify(listed), /iVBOR/);
  const args = {
    ...imageRequest,
    referenceImageIds: ["chat-image", "generated-image"],
  };
  chatReads = 0;
  const summary = await references.disclosure(args);
  assert.match(summary, /2 reference images \(140 bytes total\)/);
  assert.match(summary, /Original.png \[chat-image\]/);
  assert.equal(chatReads, 1, "disclosure reads the chat once for the whole batch");
  const result = await tools[1]!.execute("edit", args);
  assert.equal(result.isError, undefined);
  assert.equal(chatReads, 2, "execution re-checks authority with one more read");
  assert.deepEqual(controls.imageContext, {
    input: [{ type: "text", text: imageRequest.prompt }, image, image],
  });
  assert.equal(accounted, 1);
  current = [];
  await assert.rejects(
    tools[1]!.execute("removed-after-approval", args),
    /missing, changed/,
  );
  assert.equal(controls.imageCalls, 1);
  assert.equal(accounted, 1);
});

test("blank sanitized image names remain usable through listing, disclosure and image editing", async () => {
  for (const name of ["   ", "\u0000\t\n\u007f", " ".repeat(64) + "outside-truncation.png"]) {
    const attachment = { ...referenceAttachment(), name };
    const references = createPiModelImageReferences({ snapshot: [attachment], readCurrent: async () => [attachment], generated: () => [] });
    const { models, controls } = fixture();
    const tools = createPiModelTools({ models, ...references, onImage: async () => {} });
    const listed = await tools.find(tool => tool.name === "list_image_references")!.execute("list", {});
    assert.equal((listed.structuredContent as { images: { name: string }[] }).images[0]?.name, "Image");
    const args = { ...imageRequest, referenceImageIds: [attachment.id] };
    assert.match(await references.disclosure(args), /Image \[chat-image\] — 70 bytes/u);
    const result = await tools.find(tool => tool.name === "generate_image")!.execute("edit", args);
    assert.equal(result.isError, undefined);
    assert.equal(controls.imageCalls, 1);
    assert.deepEqual(controls.imageContext, { input: [{ type: "text", text: imageRequest.prompt }, image] });
  }
});

test("reference authority rejects foreign, changed, ambiguous or malformed images before paid dispatch", async () => {
  const original = referenceAttachment();
  let current = [original];
  const references = createPiModelImageReferences({
    snapshot: current,
    readCurrent: async () => current,
    generated: () => [],
  });
  const { models, controls } = fixture();
  const tool = createPiModelTools({
    models,
    ...references,
    onImage: async () => {},
  })[1]!;
  for (const referenceImageIds of [
    ["other-chat"],
    ["file:///secret.png"],
    ["chat-image", "chat-image"],
    Array.from({ length: 5 }, (_, i) => `image-${i}`),
  ]) {
    await assert.rejects(
      tool.execute("invalid", { ...imageRequest, referenceImageIds }),
    );
  }
  current = [{ ...original, data: "AAAA" }];
  await assert.rejects(
    references.resolveImage(original.id),
    /missing, changed/,
  );
  current = [original, { ...original, data: "AAAA" }];
  assert.deepEqual(await references.listImages(), []);
  const malformed = createPiModelTools({
    models,
    resolveImage: async () => ({
      name: "broken.png",
      image: { ...image, data: "!!!!" },
    }),
    onImage: async () => {},
  })[1]!;
  await assert.rejects(
    malformed.execute("malformed", {
      ...imageRequest,
      referenceImageIds: ["known"],
    }),
    /Invalid generated image/,
  );
  assert.equal(controls.imageCalls, 0);
});

test("reference decoding, aggregate pixels, cancellation and model input capability are checked before requests", async () => {
  const { models, controls } = fixture();
  const bytes = Buffer.from(PNG, "base64");
  bytes.writeUInt32BE(4000, 16);
  bytes.writeUInt32BE(5000, 20);
  const large = { ...image, data: bytes.toString("base64") };
  await assert.rejects(
    resolvePiModelImageInputs(
      { resolveImage: async () => ({ name: "large.png", image: large }) },
      ["a", "b", "c"],
    ),
    /decoded-pixel limit/,
  );
  const tooBig = {
    ...image,
    data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
  };
  await assert.rejects(
    resolvePiModelImageInputs(
      { resolveImage: async () => ({ name: "huge.png", image: tooBig }) },
      ["large"],
    ),
    /image/,
  );
  const controller = new AbortController();
  const aborting = createPiModelTools({
    models,
    resolveImage: async () => {
      controller.abort();
      return { name: "input.png", image };
    },
    onImage: async () => {},
  })[1]!;
  await assert.rejects(
    aborting.execute(
      "abort",
      { ...imageRequest, referenceImageIds: ["one"] },
      controller.signal,
    ),
    /abort/i,
  );
  (controls.catalog[0] as { input?: string[] }).input = ["text"];
  const textOnly = createPiModelTools({
    models,
    resolveImage: async () => ({ name: "input.png", image }),
    onImage: async () => {},
  })[1]!;
  await assert.rejects(
    textOnly.execute("text-only", {
      ...imageRequest,
      referenceImageIds: ["one"],
    }),
    /does not support reference images/,
  );
  assert.equal(controls.imageCalls, 0);
});


test("classification approval includes the exact complete dispatched state and questions", async () => {
  const { get, controls } = fixture();
  const request = { ...classifierRequest, state: { first: "x".repeat(25_000), last: "PRIVATE-LATE-FIELD\u202e", html: "<script>private()</script>" } };
  const details = classifierApprovalFor(request, "Research provider");
  assert.equal(details.providerLabel, "Research provider");
  assert.ok(details.stateJson.includes("PRIVATE-LATE-FIELD"));
  assert.ok(!details.stateJson.includes("\u202e"));
  await get("classify").execute("complete", request);
  assert.deepEqual(JSON.parse(JSON.stringify(controls.classifierContext)), { state: JSON.parse(details.stateJson), questions: JSON.parse(details.questionsJson) });
  assert.equal(details.stateBytes, Buffer.byteLength(JSON.stringify(request.state)));
  assert.throws(() => classifierApprovalFor({ ...request, state: { data: "x".repeat(32_768) } }), /large|bytes|size|exceed/iu);
});

test("cross-provider operation accounting uses configured or built-in display names", async () => {
  const { models } = fixture();
  const labels: string[] = [];
  const tools = createPiModelTools({ models, onImage: async () => {},
    providerLabel: id => piModelOperationProviderLabel(id, [{ id: "fixture", label: "Research team" }], "Built-in name"),
    onUsage: async record => { labels.push(record.providerLabel); } });
  await tools.find(tool => tool.name === "classify")!.execute("paid", classifierRequest);
  assert.deepEqual(labels, ["Research team"]);
  assert.equal(piModelOperationProviderLabel("builtin", [], "Readable provider"), "Readable provider");
});

test("denying or cancelling full classifier approval dispatches no provider request", async () => {
  const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { PiAgentRuntimeHarness } = await import("./pi-agent-runtime-harness.js");
  const { ToolApprovalCoordinator } = await import("./tool-approval.js");
  const { convertToLlm } = await import("./pi-legacy-harness.js");
  for (const outcome of ["deny", "cancel"] as const) {
    const { tools, controls } = fixture();
    const core = createFauxCore({ provider: `classifier-${outcome}` });
    core.setResponses([fauxAssistantMessage([fauxToolCall("classify", classifierRequest)], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    let displayed = 0;
    const coordinator = new ToolApprovalCoordinator(prompt => {
      assert.equal(prompt.details?.kind, "model-classification");
      if (prompt.details?.kind === "model-classification") assert.deepEqual(JSON.parse(prompt.details.stateJson), classifierRequest.state);
      displayed++;
      queueMicrotask(() => outcome === "deny" ? coordinator.decide(prompt.approvalId, false) : coordinator.cancelStream("classification"));
    });
    const harness = new PiAgentRuntimeHarness({ convertToLlm, streamFn: core.streamSimple,
      initialState: { model: core.getModel(), systemPrompt: "Test", thinkingLevel: "off", messages: [], tools },
      beforeToolCall: async ({ toolCall, args }) => {
        const approval = await coordinator.request({ streamId: "classification", toolCallId: toolCall.id, toolName: toolCall.name, summary: "Classification", details: classifierApprovalFor(args) });
        return approval === "allowed" ? undefined : { block: true, reason: "User did not approve classification" };
      } });
    try { await harness.prompt("classify"); assert.equal(displayed, 1); assert.equal(controls.classifyCalls, 0); }
    finally { await harness.dispose(); }
  }
});


test("long image prompts are disclosed before approval and dispatched only after Allow", async () => {
  const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { PiAgentRuntimeHarness } = await import("./pi-agent-runtime-harness.js");
  const { ToolApprovalCoordinator } = await import("./tool-approval.js");
  const { summarizeToolCall } = await import("./coding-tools.js");
  const { convertToLlm } = await import("./pi-legacy-harness.js");
  const prompt = "x".repeat(3000) + "PRIVATE-LATE-PROMPT\nEnd of exact prompt";
  for (const outcome of ["allow", "deny", "cancel"] as const) {
    const { tools, controls } = fixture();
    const core = createFauxCore({ provider: `image-${outcome}` });
    core.setResponses([fauxAssistantMessage([fauxToolCall("generate_image", { ...imageRequest, prompt })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    let displayed = 0;
    const coordinator = new ToolApprovalCoordinator(approval => {
      assert.equal(controls.imageCalls, 0, "approval must precede any provider dispatch");
      assert.ok(approval.summary.endsWith(JSON.stringify(prompt)), "the complete exact prompt must be inspectable");
      assert.match(approval.summary, /fixture\/image.*charges/);
      displayed++;
      queueMicrotask(() => outcome === "cancel" ? coordinator.cancelStream("image") : coordinator.decide(approval.approvalId, outcome === "allow"));
    });
    const harness = new PiAgentRuntimeHarness({ convertToLlm, streamFn: core.streamSimple,
      initialState: { model: core.getModel(), systemPrompt: "Test", thinkingLevel: "off", messages: [], tools },
      beforeToolCall: async ({ toolCall, args }) => {
        const approval = await coordinator.request({ streamId: "image", toolCallId: toolCall.id, toolName: toolCall.name, summary: summarizeToolCall(toolCall.name, args) });
        return approval === "allowed" ? undefined : { block: true, reason: "User did not approve image generation" };
      } });
    try {
      await harness.prompt("generate image");
      assert.equal(displayed, 1);
      assert.equal(controls.imageCalls, outcome === "allow" ? 1 : 0);
      if (outcome === "allow") assert.deepEqual(controls.imageContext, { input: [{ type: "text", text: prompt }] });
    } finally { await harness.dispose(); }
  }
});
