import assert from "node:assert/strict";
import test from "node:test";
import { runImageGenerationAction } from "../services/image-generation/action.js";
import { ImageGenerationError } from "../services/image-generation/runtime.js";
import {
  parseAddCustomModelRequest,
  parseModelRef,
  parseProviderRequest,
  parseSetDefaultModelRequest,
  parseSetKeyRequest,
  parseSetModelEnabledRequest,
} from "./image-generation-parse.js";
import type { ImageGenerationState } from "../../renderer/shared/image-generation/types.js";

const INVALID = /Invalid Image Generation request/u;

test("requests are accepted only in their exact shape", () => {
  assert.deepEqual(parseProviderRequest({ provider: "fal" }), { provider: "fal" });
  assert.deepEqual(parseSetKeyRequest({ provider: "replicate", key: "r8_abc" }), { provider: "replicate", key: "r8_abc" });
  assert.deepEqual(parseSetModelEnabledRequest({ provider: "openrouter", id: "a/b", enabled: false }), {
    provider: "openrouter",
    id: "a/b",
    enabled: false,
  });
  assert.equal(parseSetDefaultModelRequest(null), null);
  assert.deepEqual(parseSetDefaultModelRequest({ provider: "fal", id: "fal-ai/flux/schnell" }), {
    provider: "fal",
    id: "fal-ai/flux/schnell",
  });
  assert.deepEqual(
    parseAddCustomModelRequest({ provider: "fal", id: "acme/model", name: "", editEndpoint: "acme/model/edit" }),
    { provider: "fal", id: "acme/model", editEndpoint: "acme/model/edit" },
  );

  const rejected: [(value: unknown) => unknown, unknown][] = [
    [parseProviderRequest, { provider: "anthropic" }],
    [parseProviderRequest, { provider: "fal", extra: true }],
    [parseProviderRequest, undefined],
    [parseProviderRequest, Object.assign(Object.create({ inherited: 1 }), { provider: "fal" })],
    [parseSetKeyRequest, { provider: "fal" }],
    [parseSetKeyRequest, { provider: "fal", key: 123 }],
    [parseSetKeyRequest, { provider: "fal", key: "x".repeat(2000) }],
    [parseSetModelEnabledRequest, { provider: "fal", id: "a/b", enabled: "yes" }],
    [parseModelRef, { provider: "fal", id: "" }],
    [parseModelRef, { provider: "fal", id: "x".repeat(201) }],
    [parseSetDefaultModelRequest, undefined],
    [parseAddCustomModelRequest, { provider: "fal", id: "a/b", acceptsReferenceImages: "true" }],
    [parseAddCustomModelRequest, { provider: "fal", id: "a/b", unknownField: 1 }],
  ];
  for (const [parse, value] of rejected) assert.throws(() => parse(value), INVALID, JSON.stringify(value));
});

test("action results expose only known codes and messages", async () => {
  const state = { providers: [], models: [], defaultModel: null } satisfies ImageGenerationState;
  assert.deepEqual(await runImageGenerationAction(async () => state), { ok: true, state });

  assert.deepEqual(
    await runImageGenerationAction(async () => {
      throw new ImageGenerationError("rejected_key", "The fal image key was rejected.");
    }),
    { ok: false, code: "rejected_key", message: "The fal image key was rejected." },
  );

  assert.deepEqual(
    await runImageGenerationAction(async () => parseProviderRequest({ provider: "nope" }) as never),
    { ok: false, code: "invalid_request", message: "Invalid Image Generation request." },
  );

  const seen: unknown[] = [];
  const result = await runImageGenerationAction(
    async () => {
      throw new Error("EACCES /Users/me/secret path sk-or-leak");
    },
    (error) => seen.push(error),
  );
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("sk-or-leak"), false);
  assert.equal(seen.length, 1);
});
