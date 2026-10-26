// Test support: an OpenRouter-shaped Pi provider served from a local endpoint,
// so tests can read the headers a real request sends. Production code never
// imports this module.
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

/** The headers Pi uses to attribute a request to an app on OpenRouter. */
export const OPENROUTER_ATTRIBUTION_HEADERS = ["http-referer", "x-openrouter-title", "x-openrouter-categories"] as const;

/** An OpenRouter-shaped provider served from a local endpoint that records each request's headers. */
export async function recordingOpenRouter(t: { after(fn: () => unknown): void }) {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    request.resume();
    request.on("end", () => {
      const chunk = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "router-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${chunk({ role: "assistant", content: "hello" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const model: Model<"openai-completions"> = {
    id: "router-model",
    name: "Router model",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl,
    models: [model],
    auth: { apiKey: { name: "test key", resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }) } },
    api: openAICompletionsApi(),
  }));
  return { requests, model, models };
}
