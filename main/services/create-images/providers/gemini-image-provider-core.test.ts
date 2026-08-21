import assert from "node:assert/strict";
import test from "node:test";
import type { AuthResult } from "@earendil-works/pi-ai";
import type { ValidatedImageGenerationRequest } from "../provider-contract.js";
import {
  GEMINI_IMAGE_MAX_RESPONSE_BYTES,
  GEMINI_IMAGE_MAX_RETRY_AFTER_MS,
  GeminiImageProvider,
} from "./gemini-image-provider-core.js";
import { GEMINI_INTERACTIONS_ENDPOINT } from "./gemini-interactions-core.js";

const SECRET_KEY = "AIzaSy_TEST_GEMINI_KEY_NEVER_LEAK";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const JPEG_BASE64 = Buffer.from(
  Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63,
    0, 1, 2, 3, 0xff, 0xd9,
  ]),
).toString("base64");

function auth(overrides: Partial<AuthResult["auth"]> = {}): AuthResult {
  return {
    auth: {
      apiKey: SECRET_KEY,
      ...overrides,
    },
    source: "configured API key",
  };
}

function request(
  overrides: Partial<ValidatedImageGenerationRequest> = {},
): ValidatedImageGenerationRequest {
  return {
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    prompt: "Draw a quiet harbor at dawn.",
    aspectRatio: "16:9",
    imageSize: "2K",
    outputMime: "image/png",
    count: 1,
    references: [],
    ...overrides,
  };
}

function context(signal = new AbortController().signal) {
  return { runId: "run-1", nodeId: "generate-1", signal };
}

function interaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "interactions/interaction-1",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "image", mime_type: "image/png", data: PNG_BASE64 }],
      },
    ],
    usage: {
      total_input_tokens: 10,
      total_output_tokens: 20,
      total_thought_tokens: 5,
      total_tokens: 35,
    },
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });
}

function injectedFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return implementation as typeof globalThis.fetch;
}

test("uses only the fixed endpoint and main-owned API-key header, with bounded inline stateless input", async () => {
  let capturedUrl: string | URL | Request | undefined;
  let capturedInit: RequestInit | undefined;
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(interaction());
    }),
  });
  const result = await provider.execute(
    auth({
      baseUrl: "http://127.0.0.1:9999/private",
      headers: { Authorization: "Bearer inherited-secret" },
    }),
    request({
      references: [
        {
          assetId: "reference-1",
          mimeType: "image/png",
          bytes: Uint8Array.from([1, 2, 3]),
        },
      ],
    }),
    context(),
  );

  assert.equal(result.kind, "success");
  assert.equal(capturedUrl, GEMINI_INTERACTIONS_ENDPOINT);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal(capturedInit?.headers?.["x-goog-api-key" as never], SECRET_KEY);
  assert.deepEqual(capturedInit?.headers, {
    "content-type": "application/json",
    "x-goog-api-key": SECRET_KEY,
  });
  const serialized = String(capturedInit?.body);
  assert.doesNotMatch(serialized, /(?:127\.0\.0\.1|Authorization|inherited-secret|api.?key)/iu);
  assert.deepEqual(JSON.parse(serialized).response_format, {
    type: "image",
    aspect_ratio: "16:9",
    image_size: "2K",
  });
  assert.equal(JSON.parse(serialized).store, false);
  assert.equal(JSON.parse(serialized).background, false);
});

test("returns validated path-free image and aggregate usage metadata", async () => {
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () => jsonResponse(interaction())),
  });
  const result = await provider.execute(auth(), request(), context());
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(result.output.images.length, 1);
  assert.equal(Buffer.from(result.output.images[0].bytes).toString("base64"), PNG_BASE64);
  assert.deepEqual(result.output.images[0].metadata, {
    source: "gemini-interactions",
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteLength: 68,
    outputIndex: 0,
  });
  assert.deepEqual(result.output.metadata, {
    source: "gemini-interactions",
    providerId: "gemini",
    modelId: "gemini-3.1-flash-image",
    count: 1,
    totalByteLength: 68,
    interactionId: "interactions/interaction-1",
    usage: {
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalThoughtTokens: 5,
      totalTokens: 35,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /(?:AIza|quiet harbor|file:|https?:\/\/|absolute|path)/iu,
  );
});

test("never follows redirects or accepts an unexpected/private response URL", async () => {
  const calls: string[] = [];
  const redirectProvider = new GeminiImageProvider({
    fetch: injectedFetch(async (url) => {
      calls.push(String(url));
      return jsonResponse(
        {},
        {
          status: 302,
          headers: { location: "http://127.0.0.1/internal" },
        },
      );
    }),
  });
  const redirect = await redirectProvider.execute(auth(), request(), context());
  assert.equal(redirect.kind, "failure");
  assert.equal(redirect.providerErrorCode, "redirect-rejected");
  assert.deepEqual(calls, [GEMINI_INTERACTIONS_ENDPOINT]);

  const unexpectedResponse = jsonResponse(interaction());
  Object.defineProperty(unexpectedResponse, "url", { value: "http://[::1]/internal" });
  const originProvider = new GeminiImageProvider({
    fetch: injectedFetch(async () => unexpectedResponse),
  });
  const origin = await originProvider.execute(auth(), request(), context());
  assert.equal(origin.kind, "failure");
  assert.equal(origin.providerErrorCode, "redirect-rejected");
});

test("redacts credentials and raw network errors while preserving post-send ambiguity", async () => {
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () => {
      throw new Error(`socket failed for ${SECRET_KEY}: raw provider response`);
    }),
  });
  const result = await provider.execute(auth(), request(), context());
  assert.deepEqual(result, {
    kind: "ambiguous-submit",
    providerErrorCode: "offline",
    error: "A network error left the Gemini request's submission state unknown.",
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_KEY, "u"));
  assert.doesNotMatch(JSON.stringify(result), /raw provider response/u);
});

test("rejects missing credentials and invalid requests before calling fetch", async () => {
  let calls = 0;
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () => {
      calls += 1;
      return jsonResponse(interaction());
    }),
  });
  assert.deepEqual(await provider.execute(undefined, request(), context()), {
    kind: "failure",
    providerErrorCode: "authentication-required",
    error: "Connect a Google Gemini API key before creating remote images.",
    retrySafety: "confirmed-not-submitted",
  });
  const invalid = await provider.execute(
    auth(),
    request({ modelId: "http://127.0.0.1/private-model" }),
    context(),
  );
  assert.equal(invalid.kind, "failure");
  assert.equal(invalid.providerErrorCode, "invalid-request");
  assert.equal(invalid.retrySafety, "confirmed-not-submitted");
  assert.equal(calls, 0);
});

test("normalizes auth, permission, rate limit, provider, and request status without body leakage", async () => {
  const cases = [
    [401, "authentication-required"],
    [403, "permission-denied"],
    [500, "provider-unavailable"],
    [400, "request-rejected"],
  ] as const;
  for (const [status, code] of cases) {
    const provider = new GeminiImageProvider({
      fetch: injectedFetch(async () =>
        jsonResponse({ error: { message: `secret ${SECRET_KEY}` } }, { status }),
      ),
    });
    const result = await provider.execute(auth(), request(), context());
    assert.equal(result.kind, "failure");
    assert.equal(result.providerErrorCode, code);
    assert.equal(result.retrySafety, "never");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_KEY, "u"));
  }

  const invalidKey = new GeminiImageProvider({
    fetch: injectedFetch(async () =>
      jsonResponse(
        {
          error: {
            status: "INVALID_ARGUMENT",
            message: `credential ${SECRET_KEY}`,
            details: [{ reason: "API_KEY_INVALID", metadata: { key: SECRET_KEY } }],
          },
        },
        { status: 400 },
      ),
    ),
  });
  const invalidKeyResult = await invalidKey.execute(auth(), request(), context());
  assert.equal(invalidKeyResult.kind, "failure");
  assert.equal(invalidKeyResult.providerErrorCode, "authentication-required");
  assert.doesNotMatch(JSON.stringify(invalidKeyResult), new RegExp(SECRET_KEY, "u"));

  const limited = new GeminiImageProvider({
    now: () => 1_000,
    fetch: injectedFetch(async () =>
      jsonResponse({}, { status: 429, headers: { "retry-after": "999999" } }),
    ),
  });
  assert.deepEqual(await limited.execute(auth(), request(), context()), {
    kind: "rate-limited",
    providerErrorCode: "rate-limited",
    error: "Gemini is rate limiting image requests.",
    retrySafety: "never",
    retryAfterMs: GEMINI_IMAGE_MAX_RETRY_AFTER_MS,
  });
});

test("requires an exact JSON response type and bounded complete body", async () => {
  const wrongType = new GeminiImageProvider({
    fetch: injectedFetch(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    ),
  });
  const wrongTypeResult = await wrongType.execute(auth(), request(), context());
  assert.equal(wrongTypeResult.kind, "failure");
  assert.equal(wrongTypeResult.providerErrorCode, "response-malformed");

  const huge = new GeminiImageProvider({
    maxResponseBytes: 1_024,
    fetch: injectedFetch(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(GEMINI_IMAGE_MAX_RESPONSE_BYTES),
          },
        }),
    ),
  });
  const hugeResult = await huge.execute(auth(), request(), context());
  assert.equal(hugeResult.kind, "failure");
  assert.equal(hugeResult.providerErrorCode, "response-too-large");

  const truncated = new GeminiImageProvider({
    fetch: injectedFetch(
      async () =>
        new Response('{"status":"completed"', {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "999" },
        }),
    ),
  });
  const truncatedResult = await truncated.execute(auth(), request(), context());
  assert.equal(truncatedResult.kind, "failure");
  assert.equal(truncatedResult.providerErrorCode, "response-malformed");
  assert.equal(truncatedResult.retrySafety, "never");
});

test("rejects malformed, truncated, non-canonical, and oversized base64", async () => {
  const values = ["%%%%", PNG_BASE64.slice(0, -1), "AA=A"];
  for (const data of values) {
    const provider = new GeminiImageProvider({
      fetch: injectedFetch(async () =>
        jsonResponse(
          interaction({
            steps: [
              { type: "model_output", content: [{ type: "image", mime_type: "image/png", data }] },
            ],
          }),
        ),
      ),
    });
    const result = await provider.execute(auth(), request(), context());
    assert.equal(result.kind, "failure");
    assert.equal(result.providerErrorCode, "response-malformed");
  }

  const oversized = new GeminiImageProvider({
    maxOutputBytes: 32,
    fetch: injectedFetch(async () => jsonResponse(interaction())),
  });
  const oversizedResult = await oversized.execute(auth(), request(), context());
  assert.equal(oversizedResult.kind, "failure");
  assert.equal(oversizedResult.providerErrorCode, "response-malformed");
});

test("uses the last generated image and accepts its validated PNG or JPEG media type", async () => {
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () =>
      jsonResponse(
        interaction({
          steps: [
            {
              type: "model_output",
              content: [{ type: "image", mime_type: "image/png", data: PNG_BASE64 }],
            },
            {
              type: "model_output",
              content: [
                { type: "text", text: "Final image follows." },
                { type: "image", mime_type: "image/jpeg", data: JPEG_BASE64 },
              ],
            },
          ],
        }),
      ),
    ),
  });
  const result = await provider.execute(auth(), request({ outputMime: "image/png" }), context());
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(result.output.images.length, 1);
  assert.equal(result.output.images[0].metadata.mimeType, "image/jpeg");
  assert.equal(Buffer.from(result.output.images[0].bytes).toString("base64"), JPEG_BASE64);
});

test("infers a missing final MIME from validated image bytes", async () => {
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () =>
      jsonResponse(
        interaction({
          steps: [
            {
              type: "model_output",
              content: [{ type: "image", data: PNG_BASE64 }],
            },
          ],
        }),
      ),
    ),
  });
  const result = await provider.execute(auth(), request(), context());
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(result.output.images[0].metadata.mimeType, "image/png");
});

test("rejects missing, remote-final, unsupported, and declared-MIME-mismatched images", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      interaction({ steps: [{ type: "model_output", content: [{ type: "text", text: "none" }] }] }),
      "response-malformed",
    ],
    [
      interaction({
        steps: [
          {
            type: "model_output",
            content: [{ type: "image", mime_type: "image/png", uri: "http://127.0.0.1/x" }],
          },
        ],
      }),
      "response-malformed",
    ],
    [
      interaction({
        steps: [
          {
            type: "model_output",
            content: [{ type: "image", mime_type: "image/webp", data: PNG_BASE64 }],
          },
        ],
      }),
      "response-mime-mismatch",
    ],
    [
      interaction({
        steps: [
          {
            type: "model_output",
            content: [{ type: "image", mime_type: "image/jpeg", data: PNG_BASE64 }],
          },
        ],
      }),
      "response-mime-mismatch",
    ],
  ];
  for (const [response, code] of cases) {
    const provider = new GeminiImageProvider({
      fetch: injectedFetch(async () => jsonResponse(response)),
    });
    const result = await provider.execute(auth(), request(), context());
    assert.equal(result.kind, "failure");
    assert.equal(result.providerErrorCode, code);
    assert.equal(result.retrySafety, "never");
  }
});

test("normalizes content-policy refusal without exposing the provider message", async () => {
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () =>
      jsonResponse(
        interaction({
          status: "failed",
          steps: [
            {
              type: "model_output",
              error: { status: "SAFETY", message: `blocked ${SECRET_KEY}` },
              content: [],
            },
          ],
        }),
      ),
    ),
  });
  const result = await provider.execute(auth(), request(), context());
  assert.deepEqual(result, {
    kind: "failure",
    providerErrorCode: "refused",
    error: "Gemini declined this image request under its content policy.",
    retrySafety: "never",
  });
});

test("pre-send abort is definitely cancelled without touching the transport", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  let called = false;
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () => {
      called = true;
      return jsonResponse(interaction());
    }),
  });
  assert.deepEqual(await provider.execute(auth(), request(), context(controller.signal)), {
    kind: "cancelled",
    providerErrorCode: "cancelled-before-send",
    error: "The Gemini image request was cancelled before it was sent.",
  });
  assert.equal(called, false);
});

test("abort after transport invocation is ambiguous even before headers arrive", async () => {
  const controller = new AbortController();
  let invoked!: () => void;
  const invokedPromise = new Promise<void>((resolve) => {
    invoked = resolve;
  });
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async (_url, init) => {
      invoked();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }),
  });
  const pending = provider.execute(auth(), request(), context(controller.signal));
  await invokedPromise;
  controller.abort(new Error("user cancelled"));
  assert.deepEqual(await pending, {
    kind: "ambiguous-submit",
    providerErrorCode: "cancelled-after-send",
    error: "The Gemini request was cancelled after submission; completion is unknown.",
  });
});

test("timeout remains active while waiting for headers", async () => {
  const provider = new GeminiImageProvider({
    timeoutMs: 10,
    fetch: injectedFetch(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        }),
    ),
  });
  const result = await provider.execute(auth(), request(), context());
  assert.equal(result.kind, "ambiguous-submit");
  assert.equal(result.providerErrorCode, "timeout");
});

test("timeout remains active through a stalled response body", async () => {
  const provider = new GeminiImageProvider({
    timeoutMs: 10,
    fetch: injectedFetch(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  });
  const result = await provider.execute(auth(), request(), context());
  assert.equal(result.kind, "ambiguous-submit");
  assert.equal(result.providerErrorCode, "timeout");
});

test("user abort during a stalled response body remains post-send ambiguous", async () => {
  const controller = new AbortController();
  let bodyStarted!: () => void;
  const bodyStartedPromise = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              bodyStarted();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  });
  const pending = provider.execute(auth(), request(), context(controller.signal));
  await bodyStartedPromise;
  controller.abort(new Error("stop"));
  const result = await pending;
  assert.equal(result.kind, "ambiguous-submit");
  assert.equal(result.providerErrorCode, "cancelled-after-send");
});

test("nonterminal synchronous response is never silently resubmitted", async () => {
  const provider = new GeminiImageProvider({
    fetch: injectedFetch(async () =>
      jsonResponse(interaction({ status: "in_progress", steps: [] })),
    ),
  });
  assert.deepEqual(await provider.execute(auth(), request(), context()), {
    kind: "ambiguous-submit",
    providerErrorCode: "submission-ambiguous",
    error: "Gemini accepted the request but did not return a terminal response.",
  });
});
