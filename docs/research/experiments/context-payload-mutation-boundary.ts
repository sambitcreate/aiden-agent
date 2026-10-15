/** Real managed runtime + Responses serializer; final payload intercepted offline. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { PiAgentRuntimeHarness } from "../../../main/services/pi-agent-runtime-harness.js";
import { createGenerationContextTransform } from "../../../main/services/generation-context.js";
import { convertToLlm } from "../../../main/services/pi-legacy-harness.js";
import { createPiSessionPort } from "../../../main/services/pi-session-port.js";
import { InMemorySessionRepo } from "../../../main/services/pi-session-repository-port.js";
import { appendPiMessages } from "../../../main/services/pi-compaction-session-store.js";
const rows = [];
let networkDispatches = 0;
for (const payloadExpansion of [0, 40_000]) {
  const model = { id: "offline", name: "Offline", api: "openai-responses", provider: "offline", baseUrl: "https://offline.invalid/v1", input: ["text"], reasoning: false,
    contextWindow: 16_000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
  const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: `payload-boundary-${payloadExpansion}` }));
  const generationOptions = { contextWindow: model.contextWindow, systemPrompt: "Trusted initial policy", tools: [], providerId: model.provider, modelId: model.id };
  const transform = createGenerationContextTransform(generationOptions);
  const trace: string[] = [];
  const projections: number[] = [];
  let captured = "";
  let streamCalls = 0;
  const streams = openAIResponsesApi();
  const harness = new PiAgentRuntimeHarness({
    initialState: { systemPrompt: generationOptions.systemPrompt, model, tools: [], messages: [], thinkingLevel: "off" },
    convertToLlm, transformContext: transform,
    durability: { session, initialMessages: [], appendMessages: appendPiMessages, compaction: { models: createModels(), model, thinkingLevel: "off", settings: { enabled: false }, retryDelayMs: 0 } },
    onContextProjection: (projection) => projections.push(projection.contextTokens),
    extensions: [{ id: "trusted-research-payload-mutator", beforeProviderPayload: async ({ payload }) => {
      trace.push("extension-payload");
      const current = payload as { input: unknown[] };
      return payloadExpansion === 0 ? payload : { ...current, input: [...current.input, { role: "user", content: [{ type: "input_text", text: "POST_PROJECTION_PAYLOAD".padEnd(payloadExpansion, "x") }] }] };
    } }],
    onPayload: (payload) => { trace.push("host-payload"); captured = JSON.stringify(payload); throw new Error("Offline final payload capture"); },
    streamFn: (selected, context, options) => {
      streamCalls += 1;
      return streams.streamSimple(selected, context, { ...options, apiKey: "offline-noncredential", env: {}, maxRetries: 0,
        fetch: async () => { networkDispatches += 1; throw new Error("Unexpected dispatch"); } });
    },
  });
  const outcome = await harness.runManaged({ kind: "append-and-run", message: { role: "user", content: "ORIGINAL_USER_REQUEST", timestamp: 1 } });
  assert.equal(streamCalls, 1, JSON.stringify(outcome));
  assert.deepEqual(trace, ["extension-payload", "host-payload"]);
  assert.ok(captured.includes("ORIGINAL_USER_REQUEST"));
  assert.equal(captured.includes("POST_PROJECTION_PAYLOAD"), payloadExpansion > 0);
  const journal = await session.getEntries();
  assert.equal(JSON.stringify(journal).includes("POST_PROJECTION_PAYLOAD"), false, "wire-only extension content is not durable user input");
  rows.push({ payloadExpansion, projections, streamCalls, trace, capturedChars: captured.length, payloadSha256: createHash("sha256").update(captured).digest("hex"), outcomeKind: outcome.kind });
}
assert.deepEqual(rows[0].projections, rows[1].projections, "pre-serialization projection is unaffected by later payload hooks");
assert.ok(rows[1].capturedChars - rows[0].capturedChars >= 40_000);
assert.equal(networkDispatches, 0);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), evidenceKind: "offline-managed-postprojection-payload-mutation", node: process.version,
  sourceSha256: createHash("sha256").update(readFileSync(new URL("../../../main/services/pi-agent-runtime-harness.ts", import.meta.url))).digest("hex"), rows, networkDispatches,
  limitations: ["Trusted synthetic extension exercises an existing intentional capability, not an untrusted prompt injection or newly established production defect.", "Final capture deliberately causes a provider failure before dispatch; no successful inference, token count, or billing result measured.", "Payload character count is not a provider tokenizer; opaque payload-transform strata require distinct accounting before staged-elision savings claims."] }, null, 2));
