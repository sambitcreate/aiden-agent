/** Offline actual Pi adapter serialization, intercepted before any network dispatch.
 * node --import tsx docs/research/experiments/context-provider-payload-cache.ts > docs/research/experiments/context-provider-payload-cache-results.json
 * Capability flags are synthetic adapter fixtures, not claims about any live model.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInitialSystemMessage, getCurrentSystemPrompt, getCurrentTools, normalizeContext, Type, type Api, type Message, type Model, type ProviderStreams, type Tool } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { projectNextContextUsage } from "../../../main/services/generation-context.js";
const tool: Tool = { name: "read_file", description: "Read a workspace file.", parameters: Type.Object({ path: Type.String() }) };
const extra: Tool = { name: "inspect_schema", description: "Inspect a database schema without changes.", parameters: Type.Object({ table: Type.String() }) };
const executableTools: AgentTool[] = [tool, extra].map((declaration) => ({
  ...declaration, label: declaration.name,
  execute: async () => { throw new Error("Serialization fixture tools must never execute"); },
}));
const initial = createInitialSystemMessage("STABLE_POLICY: preserve user intent.", [tool]); assert.ok(initial);
const messages: Message[] = [initial, { role: "user", content: "Inspect files and report evidence.", timestamp: 1 }];
for (let index = 0; index < 6; index += 1) {
  messages.push({ role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "read_file", arguments: { path: `${index}.ts` } }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: index * 2 + 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  { role: "toolResult", toolCallId: `call-${index}`, toolName: "read_file", isError: false, content: [{ type: "text", text: `EVIDENCE_${index}:`.padEnd(8_000, "x") }], timestamp: index * 2 + 3 });
}
const elided = messages.map((message) => message.role === "toolResult" && Number(message.toolCallId.split("-")[1]) < 4 ? { ...message, content: [{ type: "text" as const, text: "[Old successful tool payload omitted; synthetic recovery reference retained.]" }] } : message);
const variants: Record<string, Message[]> = {
  original: messages,
  elided,
  queuedUser: [...elided, { role: "user", content: "QUEUED_STEER: prioritize the final file.", timestamp: 100 }],
  disclosedTool: [...elided, { role: "system", content: "", toolsAdded: [extra], timestamp: 100 }],
  revisedSystem: [...elided, { role: "system", content: "", sections: { guidance: "TRUSTED_REVISION: inspect only; no mutation." }, timestamp: 100 }],
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function prefix(a: string, b: string) { let index = 0; while (index < Math.min(a.length, b.length) && a[index] === b[index]) index += 1; return index; }
const rows: Record<string, unknown>[] = [];
let totalNetworkCalls = 0;
for (const api of ["openai-responses", "anthropic-messages"] as const) for (const nativeUpdates of [false, true]) {
  const streams: ProviderStreams = api === "openai-responses" ? openAIResponsesApi() : anthropicMessagesApi();
  const model = { id: "offline-fixture", name: "Offline fixture", provider: "offline-research", api, baseUrl: "https://offline.invalid/v1", input: ["text"], reasoning: false,
    contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: api === "openai-responses" ? { supportsMidConvoSystemMessages: nativeUpdates, supportsAdditionalTools: nativeUpdates, supportsLongCacheRetention: true }
      : { supportsMidConvoSystemMessages: nativeUpdates, supportsMidConvoToolChanges: nativeUpdates, supportsLongCacheRetention: true },
  } as Model<Api>;
  const payloads: Record<string, Record<string, unknown>> = {};
  for (const [name, variant] of Object.entries(variants)) {
    let payload: Record<string, unknown> | undefined;
    const message = await streams.streamSimple(model, normalizeContext({ messages: variant }), {
      apiKey: "offline-noncredential", sessionId: "synthetic-cache-session", cacheRetention: "long", maxRetries: 0, env: {},
      onPayload: (value) => { payload = structuredClone(value) as Record<string, unknown>; throw new Error("offline payload captured before dispatch"); },
      fetch: async () => { totalNetworkCalls += 1; throw new Error("Unexpected network call"); },
    }).result();
    assert.ok(payload, `${api}/${nativeUpdates}/${name} did not serialize`);
    assert.equal(message.stopReason, "error", "intentional capture error must stop before dispatch");
    payloads[name] = payload;
  }
  const originalWire = JSON.stringify(payloads.original);
  const elidedWire = JSON.stringify(payloads.elided);
  for (const [name, variant] of Object.entries(variants)) {
    const payload = payloads[name]; const wire = JSON.stringify(payload);
    const projection = projectNextContextUsage(variant, { contextWindow: model.contextWindow, systemPrompt: getCurrentSystemPrompt(variant), tools: getCurrentTools(variant).map((declaration) => {
      const executable = executableTools.find((candidate) => candidate.name === declaration.name);
      assert.ok(executable);
      return executable;
    }), retainsSystemUpdates: nativeUpdates });
    const topLevel = (value: Record<string, unknown>) => ({ system: value.system, instructions: value.instructions, tools: value.tools });
    rows.push({ api, nativeUpdates, variant: name, requestChars: wire.length, payloadSha256: hash(payload),
      projectedTokens: projection.contextTokens, projectedHistoryMessages: projection.compressibleHistoryMessages,
      commonJsonPrefixCharsWithOriginal: prefix(originalWire, wire), commonJsonPrefixCharsWithElided: prefix(elidedWire, wire),
      topLevelPolicyAndToolsUnchangedFromElided: hash(topLevel(payload)) === hash(topLevel(payloads.elided)),
      containsQueuedIntent: wire.includes("QUEUED_STEER"), containsDisclosedTool: wire.includes("inspect_schema"), containsTrustedRevision: wire.includes("TRUSTED_REVISION"),
      containsOldEvidence: wire.includes("EVIDENCE_0"), containsNewestEvidence: wire.includes("EVIDENCE_5"),
      promptCacheKey: payload.prompt_cache_key, promptCacheRetention: payload.prompt_cache_retention,
      ephemeralCacheMarkers: (wire.match(/"type":"ephemeral"/gu) ?? []).length,
    });
    assert.equal(wire.includes("EVIDENCE_0"), name === "original");
    assert.equal(wire.includes("EVIDENCE_5"), true);
    assert.equal(wire.includes("QUEUED_STEER"), name === "queuedUser");
    assert.equal(wire.includes("inspect_schema"), name === "disclosedTool");
    assert.equal(wire.includes("TRUSTED_REVISION"), name === "revisedSystem");
  }
}
assert.equal(totalNetworkCalls, 0);
console.log(JSON.stringify({ evidenceKind: "offline-real-adapter-payload-cache-shape", generatedAt: new Date().toISOString(), node: process.version,
  piAiVersion: JSON.parse(readFileSync(new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8")).version,
  networkCalls: totalNetworkCalls, rows,
  limitations: ["Interception intentionally stops before network; no model/tokenizer/cache-hit/billed-cost result is measured.", "Capability flags describe synthetic adapter configurations, not verified live model support.", "JSON common prefix is a serialization diagnostic only; server cache ordering/token boundaries can differ.", "Elision fixture is observation-only, has no real output-store lookup, and is not a proposed production selection policy."] }, null, 2));
