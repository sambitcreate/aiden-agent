// Test-only. A real Pi Models instance whose only provider is a counting fake
// image API, so tests exercise the real auth and dispatch path.
import {
  createModels,
  createProvider,
  type AssistantImages,
  type ImageApi,
  type ImageModel,
  type ImagesContext,
  type ImagesOptions,
  type MutableModels,
  type Usage,
} from "@earendil-works/pi-ai";
import { pngBytes } from "../studio-assets/test-fixture.js";

export interface FakeImageCall {
  model: string;
  prompt: string;
  references: number;
  options: ImagesOptions | undefined;
}

export type FakeImageReply =
  | { kind: "images"; count?: number; cost?: number; data?: string }
  | { kind: "error"; message: string }
  | { kind: "hold" };

const usage = (total: number): Usage => ({
  input: 12,
  output: 1290,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1302,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

export function fakeImageModels(
  options: {
    provider?: string;
    models?: readonly { id: string; name?: string; input?: ("text" | "image")[] }[];
    reply?: (call: FakeImageCall, index: number) => FakeImageReply;
  } = {},
): { models: MutableModels; calls: FakeImageCall[]; release(): void } {
  const provider = options.provider ?? "openrouter";
  const calls: FakeImageCall[] = [];
  const held = new Set<() => void>();
  const catalog: ImageModel<ImageApi>[] = (
    options.models ?? [{ id: "google/gemini-3.1-flash-image", name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)" }]
  ).map((entry) => ({
    type: "image",
    id: entry.id,
    name: entry.name ?? entry.id,
    api: "fake-images",
    provider,
    baseUrl: "https://images.invalid",
    input: entry.input ?? ["text", "image"],
    output: ["image", "text"],
    cost: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
  }));
  const images = (model: ImageModel<ImageApi>, count: number, cost: number, data?: string): AssistantImages => ({
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId: `fake-${calls.length}`,
    output: Array.from({ length: count }, (_, index) => ({
      type: "image" as const,
      mimeType: "image/png",
      data: data ?? Buffer.from(pngBytes(16, 16, calls.length * 10 + index)).toString("base64"),
    })),
    usage: usage(cost),
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: provider === "openrouter" ? "OpenRouter" : provider,
      auth: { apiKey: { name: "Fake key", resolve: async () => ({ auth: { apiKey: "fake-key" }, source: "test" }) } },
      models: catalog,
      images: {
        "fake-images": {
          async generateImages(model: ImageModel<ImageApi>, context: ImagesContext, requestOptions?: ImagesOptions) {
            const call: FakeImageCall = {
              model: model.id,
              prompt: context.input.flatMap((item) => (item.type === "text" ? [item.text] : [])).join(""),
              references: context.input.filter((item) => item.type === "image").length,
              options: requestOptions,
            };
            calls.push(call);
            const reply = options.reply?.(call, calls.length - 1) ?? { kind: "images" };
            if (reply.kind === "images") return images(model, reply.count ?? 1, reply.cost ?? 0.039, reply.data);
            if (reply.kind === "error") {
              return { ...images(model, 0, 0), output: [], stopReason: "error", errorMessage: reply.message };
            }
            return new Promise<AssistantImages>((resolve) => {
              const release = () => resolve(images(model, 1, 0.039));
              held.add(release);
              requestOptions?.signal?.addEventListener("abort", () => {
                held.delete(release);
                resolve({ ...images(model, 0, 0), output: [], usage: undefined, stopReason: "aborted", errorMessage: "Request aborted." });
              });
            });
          },
        },
      },
    }),
  );
  return {
    models,
    calls,
    release: () => {
      for (const release of [...held]) release();
      held.clear();
    },
  };
}
