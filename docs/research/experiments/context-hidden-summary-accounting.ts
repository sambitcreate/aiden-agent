/** Offline accounting wrapper observations; no credentials or inference. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, fauxAssistantMessage, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createPiCompactionModels } from "../../../main/services/pi-compaction-core.js";
import type { ResolvedModelRuntime } from "../../../main/services/model-runtime-core.js";
const rows = [];
for (const registered of [false, true]) for (const reason of ["stop", "error", "aborted"] as const) {
  let releaseAccounting!: () => void;
  const gate = new Promise<void>((resolve) => { releaseAccounting = resolve; });
  let started = 0;
  let finished = 0;
  let dispatched = 0;
  const model = { id: "offline", provider: "offline", api: "openai-completions" } as ResolvedModelRuntime["model"];
  const message: AssistantMessage = { ...fauxAssistantMessage("synthetic summary"), stopReason: reason,
    usage: { input: 23, output: 7, cacheRead: 11, cacheWrite: 3, totalTokens: 44, cost: { input: 0.023, output: 0.007, cacheRead: 0.0011, cacheWrite: 0.003, total: 0.0341 } } };
  const stream = (): AssistantMessageEventStream => {
    dispatched += 1;
    const result = createAssistantMessageEventStream();
    if (reason === "stop") result.push({ type: "done", reason, message });
    else result.push({ type: "error", reason, error: message });
    result.end(message); return result;
  };
  const runtime = { model, models: { getModel: () => registered ? model : undefined, streamSimple: stream }, streams: { streamSimple: stream }, apiKey: "offline-noncredential" } as unknown as ResolvedModelRuntime;
  const accounted = createPiCompactionModels(runtime, async (response) => {
    started += 1;
    assert.equal(response.usage.totalTokens, 44);
    await gate;
    finished += 1;
  });
  const result = accounted.streamSimple(model, { messages: [] });
  let published = false;
  const first = result.result().then((value) => { published = true; return value; });
  const second = result.result();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(started, 1);
  assert.equal(published, false, "terminal result cannot finish before accounting completes");
  releaseAccounting();
  const messages = await Promise.all([first, second]);
  assert.equal(messages[0], messages[1]);
  assert.equal(messages[0].stopReason, reason);
  assert.equal(dispatched, 1);
  assert.equal(finished, 1);
  rows.push({ registered, reason, dispatched, accountingStarted: started, accountingFinished: finished, repeatedResultReads: 2, recordedTokens: message.usage.totalTokens, syntheticReportedCost: message.usage.cost.total });
}
console.log(JSON.stringify({ sourceSha256: createHash("sha256").update(readFileSync(new URL("../../../main/services/pi-compaction-core.ts", import.meta.url))).digest("hex"), piAiVersion: JSON.parse(readFileSync(new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8")).version, generatedAt: new Date().toISOString(), evidenceKind: "offline-hidden-summary-accounting-boundary", node: process.version, rows,
  limitations: ["Synthetic terminal messages and controlled accounting sink, not provider billing or durable storage measurement.", "Error and aborted observations cover terminal responses carrying usage; a transport rejection without usage cannot establish consumed tokens."] }, null, 2));
