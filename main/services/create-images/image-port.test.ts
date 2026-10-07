import assert from "node:assert/strict";
import test from "node:test";
import {
  pickDefaultImageModel,
  type ImageGenerationRequest,
  type ImageModelOption,
} from "../../../renderer/shared/images/port.js";
import { pngBytes } from "../studio-assets/test-fixture.js";
import { createPiImageGenerationPort, type ImageOperationUsage } from "./image-port.js";
import { fakeImageModels, type FakeImageReply } from "./test-fixture.js";

const NANO = "google/gemini-3.1-flash-image";

function port(reply?: (index: number) => FakeImageReply, models?: NonNullable<Parameters<typeof fakeImageModels>[0]>["models"]) {
  const fake = fakeImageModels({ ...(models ? { models } : {}), ...(reply ? { reply: (_call, index) => reply(index) } : {}) });
  const usage: ImageOperationUsage[] = [];
  const instance = createPiImageGenerationPort({
    models: fake.models,
    providerLabel: (id) => (id === "openrouter" ? "OpenRouter" : id),
    onUsage: async (record) => {
      usage.push(record);
    },
  });
  return { ...fake, usage, port: instance };
}
const request = (overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest => ({
  provider: "openrouter",
  model: NANO,
  prompt: "A red bicycle at dawn",
  references: [],
  signal: new AbortController().signal,
  ...overrides,
});

test("listModels lists configured image models and hides auto routers", async () => {
  const { port: images } = port(undefined, [
    { id: "openrouter/auto", name: "Auto Router" },
    { id: "openrouter/auto-beta", name: "Auto Beta" },
    { id: NANO, name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)" },
    { id: "black-forest-labs/flux.2-pro", name: "FLUX.2 Pro", input: ["text"] },
  ]);
  assert.deepEqual(await images.listModels(), [
    { provider: "openrouter", providerLabel: "OpenRouter", model: "black-forest-labs/flux.2-pro", label: "FLUX.2 Pro", acceptsReferences: false, textOutput: true },
    { provider: "openrouter", providerLabel: "OpenRouter", model: NANO, label: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", acceptsReferences: true, textOutput: true },
  ]);
});

test("one generate is one provider call with maxRetries 0 and one usage record", async () => {
  const fake = port();
  const result = await fake.port.generate(request());
  assert.equal(result.kind, "images");
  assert.equal(result.kind === "images" ? result.images.length : 0, 1);
  assert.deepEqual(
    result.kind === "images" ? result.images.map(({ mimeType, width, height }) => ({ mimeType, width, height })) : [],
    [{ mimeType: "image/png", width: 16, height: 16 }],
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.prompt, "A red bicycle at dawn");
  assert.equal(fake.calls[0]?.options?.maxRetries, 0);
  assert.equal(fake.usage.length, 1);
  assert.deepEqual(Object.keys(fake.usage[0]!).sort(), ["model", "modelLabel", "provider", "providerLabel", "status", "usage"]);
  assert.equal(fake.usage[0]?.status, "completed");
  assert.equal(fake.usage[0]?.usage?.cost.total, 0.039);
});

test("references reach the provider as image inputs, and text-only models refuse them unsent", async () => {
  const fake = port(undefined, [{ id: NANO }, { id: "flux", input: ["text"] }]);
  const reference = { mimeType: "image/png", bytes: pngBytes(8, 8, 1) };
  await fake.port.generate(request({ references: [reference, reference] }));
  assert.equal(fake.calls[0]?.references, 2);
  const refused = await fake.port.generate(request({ model: "flux", references: [reference] }));
  assert.deepEqual(refused.kind === "failed" ? refused.code : refused.kind, "references-unsupported");
  const oversized = await fake.port.generate(request({ references: Array.from({ length: 5 }, () => reference) }));
  assert.deepEqual(
    oversized.kind === "failed" ? [oversized.code, oversized.message] : oversized.kind,
    ["references-unsupported", "This image request has 5 reference images. Aiden sends at most 4."],
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.usage.length, 1);
});

test("provider errors and aborts are outcomes, accounted exactly once", async () => {
  const fake = port((index) => (index === 0 ? { kind: "error", message: "Rate limited (429)" } : { kind: "hold" }));
  const failed = await fake.port.generate(request());
  assert.deepEqual(failed.kind === "failed" ? [failed.code, failed.message] : [], ["provider-error", "Rate limited (429)"]);
  const controller = new AbortController();
  const pending = fake.port.generate(request({ signal: controller.signal }));
  while (fake.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.kind === "failed" ? aborted.code : aborted.kind, "aborted");
  assert.deepEqual(fake.usage.map((record) => record.status), ["failed", "cancelled"]);
});

test("more than four images are truncated, not failed; undecodable output is output-invalid", async () => {
  const fake = port((index) => (index === 0 ? { kind: "images", count: 6 } : { kind: "images", data: "AAAA" }));
  const many = await fake.port.generate(request());
  assert.deepEqual(many.kind === "images" ? [many.images.length, many.truncated] : [], [4, true]);
  const broken = await fake.port.generate(request());
  assert.equal(broken.kind === "failed" ? broken.code : broken.kind, "output-invalid");
  assert.deepEqual(fake.usage.map((record) => record.status), ["completed", "completed"]);
});

test("unknown and auto-router models are refused without a request", async () => {
  const fake = port(undefined, [{ id: NANO }, { id: "openrouter/auto" }]);
  for (const model of ["openrouter/auto", "missing/model"]) {
    const result = await fake.port.generate(request({ model }));
    assert.equal(result.kind === "failed" ? result.code : result.kind, "unknown-model");
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.usage.length, 0);
});

test("the default model is Nano Banana 2 when available, otherwise the first available", () => {
  const option = (provider: string, model: string): ImageModelOption =>
    ({ provider, providerLabel: provider, model, label: model, acceptsReferences: true, textOutput: true });
  assert.deepEqual(pickDefaultImageModel([option("openrouter", "flux"), option("openrouter", NANO)]), { provider: "openrouter", id: NANO });
  assert.deepEqual(pickDefaultImageModel([option("openrouter", "flux")]), { provider: "openrouter", id: "flux" });
  assert.equal(pickDefaultImageModel([]), undefined);
});

test("a finished result wins over an abort observed later, and a failing accounting hook never hides it", async () => {
  const controller = new AbortController();
  const fake = fakeImageModels({
    reply: () => {
      controller.abort();
      return { kind: "images" };
    },
  });
  const images = createPiImageGenerationPort({
    models: fake.models,
    providerLabel: (id) => id,
    onUsage: async () => {
      throw new Error("usage store closed");
    },
  });
  const result = await images.generate(request({ signal: controller.signal }));
  assert.equal(result.kind, "images");
  assert.equal(result.kind === "images" ? result.images.length : 0, 1);
});

test("listing hydrates offline catalogs first and gives up when the caller aborts", async () => {
  const order: string[] = [];
  const fake = fakeImageModels();
  const images = createPiImageGenerationPort({
    models: fake.models,
    providerLabel: (id) => id,
    beforeList: async () => {
      order.push("beforeList");
    },
  });
  assert.equal((await images.listModels()).length, 1);
  assert.deepEqual(order, ["beforeList"]);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(images.listModels(stopped.signal));
});
