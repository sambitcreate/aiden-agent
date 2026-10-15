/** Bounded shared-load investigation of the remaining active-tool pressure path.
 * node --import tsx docs/research/experiments/context-active-tool-scaling.ts > docs/research/experiments/context-active-tool-scaling-results.json
 * Each fresh process has a 15s wall deadline. No application session/model calls.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { compactGenerationContext } from "../../../main/services/generation-context.js";
const modulePath = resolve(process.argv[2] === "--case" ? (process.argv[4] ?? "main/services/generation-context.ts") : (process.argv[2] ?? "main/services/generation-context.ts"));
const compactor = (await import(pathToFileURL(modulePath).href)).compactGenerationContext as typeof compactGenerationContext;
interface Input { batches: number; resultChars: number; }
function sample(input: Input) {
  const messages: AgentMessage[] = [{ role: "user", content: "Finish the active investigation", timestamp: 1 }];
  for (let index = 0; index < input.batches; index += 1) {
    const id = `call-${index}`;
    const message: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id, name: "read_file", arguments: { path: `${index}.txt` } }],
      api: "openai-completions", provider: "research", model: "fixture", stopReason: "toolUse", timestamp: index * 2 + 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    messages.push(message, { role: "toolResult", toolCallId: id, toolName: "read_file", isError: false, timestamp: index * 2 + 3,
      content: [{ type: "text", text: `${id}:`.padEnd(input.resultChars, "x") }] });
  }
  const snapshot = JSON.stringify(messages);
  const start = performance.now();
  const result = compactor(messages, { contextWindow: 16_000, systemPrompt: "Active investigation", tools: [] });
  const durationMs = performance.now() - start;
  assert.equal(JSON.stringify(messages), snapshot);
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
  const calls = result.messages.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []) : []);
  const results = result.messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []);
  assert.deepEqual(calls, results);
  return { ...input, status: "completed", durationMs, inputMessages: messages.length, outputMessages: result.messages.length, outputSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    compactedToolResults: result.compactedToolResults, removedCurrentTurnMessages: result.removedCurrentTurnMessages,
    removedHistoryMessages: result.removedHistoryMessages, estimatedTokensBefore: result.estimatedTokensBefore,
    estimatedTokensAfter: result.estimatedTokensAfter, emergencyKind: result.emergencyProjection.kind, peakRssKiB: process.resourceUsage().maxRSS };
}
if (process.argv[2] === "--case") console.log(JSON.stringify(sample(JSON.parse(process.argv[3]) as Input)));
else {
  const rows = [];
  for (const resultChars of [128, 4_096]) for (const batches of [100, 1_000, 5_000, 10_000]) {
    const input = { batches, resultChars };
    const start = performance.now();
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--case", JSON.stringify(input), modulePath], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 100_000 });
    const row = child.status === 0 ? { ...JSON.parse(child.stdout), processWallMs: performance.now() - start }
      : { ...input, status: (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "timeout" : "failed", processWallMs: performance.now() - start, error: child.error?.message ?? child.stderr.slice(-1_000) };
    rows.push(row); console.error(JSON.stringify(row));
  }
  console.log(JSON.stringify({ evidenceKind: "synthetic-shared-load-active-tool-scaling", generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    sourceSha256: createHash("sha256").update(readFileSync(modulePath)).digest("hex"), processTimeoutMs: 15_000, contextWindow: 16_000,
    limitations: ["One shared-load sample per cell; not a controlled timing comparison.", "Peak RSS includes the whole process and fixture serialization.", "No history turns are available to the optimized historical-pruning path; this isolates a long active tool loop.", "Timeout includes startup and is a censored observation, not transform time.", "No live-model task quality, recall or UI latency measured."], rows }, null, 2));
}
