/** Offline synthetic performance probe; no provider calls or production policy changes.
 * Prepare the pinned baseline when comparing before/after: python3 docs/research/experiments/prepare-context-compaction-baseline.py
 * Run: node --import tsx docs/research/experiments/context-compaction-scaling.ts > docs/research/experiments/context-compaction-scaling-results.json
 * Each sample runs in a fresh process, forcibly bounded at 30 seconds including startup.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, release } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { compactGenerationContext } from "../../../main/services/generation-context.js";

const selectedCompactor: typeof compactGenerationContext = process.argv[2] === "--case" && process.argv[4]
  ? (await import(pathToFileURL(resolve(process.argv[4])).href)).compactGenerationContext
  : compactGenerationContext;

interface Sample { historicalPairs: number; textChars: number; contextWindow: number; usage: "zero" | "matching-anchor"; }
function dataset(sample: Sample): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < sample.historicalPairs; i += 1) {
    const text = `${i}:`.padEnd(sample.textChars, "x");
    messages.push({ role: "user", content: text, timestamp: i * 2 + 1 });
    const input = sample.usage === "matching-anchor" && i === sample.historicalPairs - 1
      ? Math.ceil(sample.historicalPairs * sample.textChars / 2) : 0;
    const answer: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text }], timestamp: i * 2 + 2,
      api: "openai-completions", provider: "synthetic-scaling", model: "synthetic-scaling", stopReason: "stop",
      usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    messages.push(answer);
  }
  messages.push({ role: "user", content: "CURRENT-CONSTRAINT-719: preserve the active request", timestamp: sample.historicalPairs * 2 + 1 });
  return messages;
}
function runSample(sample: Sample) {
  const messages = dataset(sample);
  const snapshot = JSON.stringify(messages);
  const options = { contextWindow: sample.contextWindow, systemPrompt: "Synthetic scaling probe", tools: [],
    providerId: "synthetic-scaling", modelId: "synthetic-scaling" };
  const start = performance.now();
  const result = selectedCompactor(messages, options);
  const durationMs = performance.now() - start;
  assert.equal(JSON.stringify(messages), snapshot, "compaction must not mutate input");
  assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens, "request must fit after compaction");
  assert.equal(JSON.stringify(result.messages[result.messages.length - 1]), JSON.stringify(messages[messages.length - 1]), "active user must survive");
  return { ...sample, status: "completed", durationMs, inputMessages: messages.length,
    inputSha256: createHash("sha256").update(snapshot).digest("hex"),
    outputSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    outputMessages: result.messages.length, removedHistoryMessages: result.removedHistoryMessages,
    estimatedTokensBefore: result.estimatedTokensBefore, estimatedTokensAfter: result.estimatedTokensAfter,
    inputBudgetTokens: result.inputBudgetTokens, emergencyKind: result.emergencyProjection.kind,
    peakRssKiB: process.resourceUsage().maxRSS, rssBytesAtEnd: process.memoryUsage().rss };
}
if (process.argv[2] === "--case") {
  console.log(JSON.stringify(runSample(JSON.parse(process.argv[3]) as Sample)));
} else {
  const samples: Sample[] = [];
  for (const textChars of [64, 512]) for (const usage of ["zero", "matching-anchor"] as const)
    for (const contextWindow of [16_000, 64_000]) for (const historicalPairs of [100, 1_000, 5_000, 10_000, 20_000])
      samples.push({ historicalPairs, textChars, contextWindow, usage });
  const rows = samples.map((sample) => {
    const start = performance.now();
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--case", JSON.stringify(sample)],
      { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
    const processWallMs = performance.now() - start;
    const row = child.status === 0
      ? { ...JSON.parse(child.stdout), processWallMs }
      : { ...sample, status: child.error && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "failed",
        processWallMs, exitCode: child.status, signal: child.signal, error: child.error?.message ?? child.stderr.slice(-2_000) };
    console.error(JSON.stringify({ ...sample, status: row.status, durationMs: row.durationMs, processWallMs }));
    return row;
  });
  console.log(JSON.stringify({ version: 1, evidenceKind: "synthetic-local-performance", generatedAt: new Date().toISOString(),
    sourceSha256: createHash("sha256").update(readFileSync(new URL("../../../main/services/generation-context.ts", import.meta.url))).digest("hex"),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model },
    processTimeoutMs: 30_000, sampleCount: rows.length,
    dataset: "N alternating historical user+assistant text pairs of fixed character length plus one protected current user; matching-anchor sets only final historical assistant usage to estimated N*chars/2",
    limitations: ["One cold-process sample per matrix cell; duration isolates compactGenerationContext and excludes import/dataset/hash overhead.", "Peak RSS includes process startup, dependencies, dataset, validation and serialization; it is not incremental compaction memory.", "Timeout includes startup and teardown; a timeout is censored rather than a measured transform duration.", "Synthetic histories and usage, no model traffic, no billing or task-quality claims."], rows }, null, 2));
}
