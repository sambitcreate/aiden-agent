import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_AVATAR_SYSTEM_PROMPT,
  BOT_AVATAR_RESPONSE_CHARS,
  botAvatarTerminalContentWithinBudget,
  botAvatarTerminalMessageWithinBudget,
  botAvatarTextDeltaTotal,
  botAvatarGenerationFailureMessage,
  boundedBotAvatarText,
  buildBotAvatarPrompt,
  consumeBoundedBotAvatarResult,
  fallbackBotAvatarSuggestion,
  finishBotAvatarAccounting,
  parseGeneratedBotAvatar,
  waitForBotAvatarBoundary,
} from "./bot-avatar-generator-core.js";
import {
  DEFAULT_BOT_AVATAR,
  BOT_AVATAR_GENERATION_FAILURE_MESSAGES,
  botAvatarSuggestionErrorMessage,
  isBotAvatar,
  resolveBotAvatar,
  type BotAvatarSuggestion,
} from "../../renderer/shared/bots.js";

const generated = {
  avatar: {
    version: 1,
    shape: "capsule",
    color: "aqua",
    eyes: "focus",
    detail: "antenna",
  },
  rationale: "A crisp, attentive recipe for a systems bot.",
} satisfies BotAvatarSuggestion;

test("avatar generation projects only the bounded layered recipe", () => {
  assert.deepEqual(parseGeneratedBotAvatar(JSON.stringify(generated)), generated);
  assert.deepEqual(
    parseGeneratedBotAvatar(`\`\`\`json\n${JSON.stringify(generated)}\n\`\`\``),
    generated,
  );
  assert.deepEqual(
    parseGeneratedBotAvatar(
      JSON.stringify({
        avatar: { shape: "Triangle", color: "Purple", eyes: "Calm", mouth: "smile" },
        explanation: " A gentle choice. ",
        svg: "<svg onload=alert(1)>",
      }),
      generated.avatar,
    ),
    {
      avatar: {
        version: 1,
        shape: "peak",
        color: "lilac",
        eyes: "sleepy",
        detail: "antenna",
      },
      rationale: "A gentle choice.",
    },
  );
  assert.deepEqual(
    parseGeneratedBotAvatar(
      JSON.stringify({ avatar: { color: "#ff00ff", eyes: "wide" }, rationale: "x".repeat(281) }),
      generated.avatar,
    ),
    {
      avatar: { ...generated.avatar, eyes: "wide" },
      rationale: "x".repeat(280),
    },
  );
  assert.equal(parseGeneratedBotAvatar('{"message":"no avatar fields"}'), null);
  assert.equal(
    parseGeneratedBotAvatar(
      JSON.stringify({
        avatar: {
          shape: "constructor",
          color: "constructor",
          eyes: "constructor",
          detail: "constructor",
        },
      }),
    ),
    null,
  );
  assert.deepEqual(
    parseGeneratedBotAvatar(
      JSON.stringify({
        avatar: {
          shape: null,
          bodyShape: "orb",
          color: false,
          pastel: "mint",
        },
        rationale: null,
        explanation: "The usable fallback fields win.",
      }),
      generated.avatar,
    ),
    {
      avatar: {
        ...generated.avatar,
        shape: "orb",
        color: "mint",
      },
      rationale: "The usable fallback fields win.",
    },
  );
  const unicodeRationale = parseGeneratedBotAvatar(
    JSON.stringify({
      avatar: generated.avatar,
      rationale: `${"x".repeat(279)}😀trailing`,
    }),
  );
  assert.equal(unicodeRationale?.rationale, `${"x".repeat(279)}😀`);
  assert.equal(unicodeRationale?.rationale.includes("�"), false);
});

test("malformed model output falls back to a deterministic safe face", () => {
  const first = fallbackBotAvatarSuggestion("calm and sweet", DEFAULT_BOT_AVATAR, "not json");
  const second = fallbackBotAvatarSuggestion("calm and sweet", DEFAULT_BOT_AVATAR, "not json");
  assert.deepEqual(first, second);
  assert.deepEqual(first.avatar, {
    version: 1,
    shape: "squircle",
    color: "peach",
    eyes: "happy",
    detail: "halo",
  });
  assert.match(first.rationale, /incompatible format/u);
});

test("fallback matching uses whole words instead of accidental substrings", () => {
  const current = {
    version: 1 as const,
    shape: "capsule" as const,
    color: "coral" as const,
    eyes: "focus" as const,
    detail: "antenna" as const,
  };
  const falsePositive = fallbackBotAvatarSuggestion("function breakfast unkind", current);
  assert.deepEqual(falsePositive.avatar, current);

  const deliberate = fallbackBotAvatarSuggestion("fun, fast, and kind", DEFAULT_BOT_AVATAR);
  assert.equal(deliberate.avatar.eyes, "wink");
  assert.equal(deliberate.avatar.detail, "bolts");
  assert.equal(deliberate.avatar.shape, "squircle");
});

test("fallback preserves current traits and recognizes compatibility Unicode words", () => {
  const current = {
    version: 1 as const,
    shape: "capsule" as const,
    color: "coral" as const,
    eyes: "focus" as const,
    detail: "antenna" as const,
  };
  assert.deepEqual(fallbackBotAvatarSuggestion("unrecognized aesthetic", current).avatar, current);
  assert.deepEqual(fallbackBotAvatarSuggestion("𝐂𝐀𝐋𝐌", current).avatar, {
    version: 1,
    shape: "cloud",
    color: "periwinkle",
    eyes: "sleepy",
    detail: "halo",
  });
});

test("provider failures expose only fixed renderer-safe messages", () => {
  const secret = "https://api.example.test?key=super-secret";
  for (const kind of ["cancelled", "provider", "timeout"] as const) {
    const message = botAvatarGenerationFailureMessage(kind);
    assert.equal(message.includes(secret), false);
    assert.ok(message.length > 0);
  }
  const wrapped = new Error(
    `Error invoking remote method 'bots:suggestAvatar': Error: ${BOT_AVATAR_GENERATION_FAILURE_MESSAGES.provider} ${secret}`,
  );
  assert.equal(
    botAvatarSuggestionErrorMessage(wrapped),
    BOT_AVATAR_GENERATION_FAILURE_MESSAGES.provider,
  );
  assert.equal(botAvatarSuggestionErrorMessage(wrapped).includes("super-secret"), false);
});

test("provider text is bounded before joining or JSON parsing", () => {
  assert.equal(
    botAvatarTextDeltaTotal(0, "x".repeat(BOT_AVATAR_RESPONSE_CHARS)),
    BOT_AVATAR_RESPONSE_CHARS,
  );
  assert.equal(botAvatarTextDeltaTotal(BOT_AVATAR_RESPONSE_CHARS, "x"), null);
  assert.equal(
    boundedBotAvatarText([{ type: "text", text: "x".repeat(BOT_AVATAR_RESPONSE_CHARS + 1) }]),
    null,
  );
  assert.equal(
    boundedBotAvatarText([
      { type: "thinking", thinking: "private" },
      { type: "text", text: " usable " },
    ]),
    "usable",
  );
});

test("oversized streaming output aborts once and never asks for a terminal result", async () => {
  let aborts = 0;
  let resultReads = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "x".repeat(BOT_AVATAR_RESPONSE_CHARS),
        partial: {},
      };
      yield { type: "text_delta", contentIndex: 0, delta: "y", partial: {} };
    },
    async result() {
      resultReads += 1;
      throw new Error("terminal result must not be read");
    },
  };
  await assert.rejects(
    consumeBoundedBotAvatarResult(stream as never, () => {
      aborts += 1;
    }),
    /safe size limit/u,
  );
  assert.equal(aborts, 1);
  assert.equal(resultReads, 0);
});

test("hidden streaming output shares the same aggregate response budget", async () => {
  for (const type of ["thinking_delta", "toolcall_delta"] as const) {
    let aborts = 0;
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield {
          type,
          contentIndex: 0,
          delta: "x".repeat(BOT_AVATAR_RESPONSE_CHARS + 1),
          partial: {},
        };
      },
      async result() {
        throw new Error("terminal result must not be read");
      },
    };
    await assert.rejects(
      consumeBoundedBotAvatarResult(stream as never, () => {
        aborts += 1;
      }),
      /safe size limit/u,
    );
    assert.equal(aborts, 1, type);
  }
});

test("terminal-only thinking and tool arguments cannot bypass the response budget", async () => {
  const oversizedContent = [
    [{ type: "thinking", thinking: "x".repeat(BOT_AVATAR_RESPONSE_CHARS + 1) }],
    [
      {
        type: "toolCall",
        id: "call-1",
        name: "hidden",
        arguments: { payload: "x".repeat(BOT_AVATAR_RESPONSE_CHARS + 1) },
      },
    ],
  ];
  for (const content of oversizedContent) {
    assert.equal(botAvatarTerminalContentWithinBudget(content), false);
    let aborts = 0;
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: { content } };
      },
      async result() {
        throw new Error("terminal result must not be read");
      },
    };
    await assert.rejects(
      consumeBoundedBotAvatarResult(stream as never, () => {
        aborts += 1;
      }),
      /safe size limit/u,
    );
    assert.equal(aborts, 1);
  }
});

test("terminal budgeting accepts real optional Pi signature fields", () => {
  const message = {
    content: [
      { type: "thinking", thinking: "considering", thinkingSignature: undefined },
      { type: "text", text: "{}", textSignature: undefined },
      {
        type: "toolCall",
        id: "call-1",
        name: "unused",
        arguments: {},
        thoughtSignature: undefined,
      },
    ],
    responseModel: undefined,
  };
  assert.equal(botAvatarTerminalContentWithinBudget(message.content), true);
  assert.equal(botAvatarTerminalMessageWithinBudget(message), true);
});

test("oversized terminal metadata cannot enter usage accounting", async () => {
  let aborts = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "done",
        reason: "stop",
        message: {
          content: [{ type: "text", text: "{}" }],
          responseModel: "x".repeat(BOT_AVATAR_RESPONSE_CHARS + 1),
        },
      };
    },
    async result() {
      throw new Error("terminal result must not be read");
    },
  };
  await assert.rejects(
    consumeBoundedBotAvatarResult(stream as never, () => {
      aborts += 1;
    }),
    /safe size limit/u,
  );
  assert.equal(aborts, 1);
});

test("a provider cannot complete after an exact request cancellation", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = {
    async *[Symbol.asyncIterator]() {
      await delayed;
      yield {
        type: "done",
        reason: "stop",
        message: { content: [{ type: "text", text: "{}" }] },
      };
    },
    async result() {
      throw new Error("terminal result must not be read");
    },
  };
  const pending = consumeBoundedBotAvatarResult(stream as never, () => {}, controller.signal);
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
});

test("cancellation releases a request even when the provider iterator never settles", async () => {
  const controller = new AbortController();
  let closes = 0;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<never>(() => {}),
        async return() {
          closes += 1;
          return { done: true as const, value: undefined };
        },
      };
    },
    async result() {
      throw new Error("terminal result must not be read");
    },
  };
  const pending = consumeBoundedBotAvatarResult(stream as never, () => {}, controller.signal).then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  controller.abort();
  const outcome = await Promise.race([
    pending,
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 100);
    }),
  ]);
  assert.notEqual(outcome, "still-pending");
  assert.equal((outcome as { name?: unknown }).name, "AbortError");
  assert.equal(closes, 1);
});

test("cancellation cannot cross delayed usage accounting", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const persistence = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = finishBotAvatarAccounting(persistence, controller.signal).then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  controller.abort();
  const outcome = await pending;
  release();
  assert.equal((outcome as { name?: unknown }).name, "AbortError");
});

test("cancellation releases a request across a never-settling catalog boundary", async () => {
  const controller = new AbortController();
  const pending = waitForBotAvatarBoundary(
    new Promise<never>(() => {}),
    controller.signal,
  ).then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  controller.abort();
  const outcome = await Promise.race([
    pending,
    new Promise<"still-pending">((resolve) => {
      setTimeout(() => resolve("still-pending"), 100);
    }),
  ]);
  assert.notEqual(outcome, "still-pending");
  assert.equal((outcome as { name?: unknown }).name, "AbortError");
});

test("avatar prompting keeps the Pi response tool-free, mouthless, and schema constrained", () => {
  assert.match(BOT_AVATAR_SYSTEM_PROMPT, /eyes only/u);
  assert.match(BOT_AVATAR_SYSTEM_PROMPT, /never add a mouth, nose, eyebrows/u);
  assert.match(BOT_AVATAR_SYSTEM_PROMPT, /Return only one JSON object/u);
  assert.match(BOT_AVATAR_SYSTEM_PROMPT, /lowercase enum values exactly/u);
  const prompt = buildBotAvatarPrompt({
    prompt: "calm and precise",
    currentAvatar: DEFAULT_BOT_AVATAR,
  });
  assert.match(prompt, /calm and precise/u);
  assert.match(prompt, /"shape":"wisp"/u);
});

test("legacy ids stay valid and resolve to fresh versioned appearances", () => {
  assert.equal(isBotAvatar("spark"), true);
  assert.equal(isBotAvatar(DEFAULT_BOT_AVATAR), true);
  const first = resolveBotAvatar("orbit");
  const second = resolveBotAvatar("orbit");
  assert.deepEqual(first, {
    version: 1,
    shape: "orb",
    color: "sky",
    eyes: "wide",
    detail: "orbit",
  });
  assert.notEqual(first, second);
});
