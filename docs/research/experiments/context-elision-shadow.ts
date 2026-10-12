/** Offline research only. No provider calls, journal writes, or rollout receipts.
 * Run: node --import tsx docs/research/experiments/context-elision-shadow.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { compactGenerationContext, projectNextContextUsage, type GenerationContextOptions } from "../../../main/services/generation-context.js";

const windows = [8_000, 16_000, 32_000, 128_000, 272_000];
const suffix = "[Output preview. Read retained output with read_tool_output handle=12345678-1234-4234-8234-123456789abc; offsets are UTF-16 characters. Retained 180000 of 180000 characters, for up to 7 days subject to storage limits.]";
const recoveryPattern = /(?:^|\n)(\[Output preview\. Read retained output with read_tool_output handle=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}; offsets are UTF-16 characters\. Retained [0-9]{1,10} of [0-9]{1,10} characters, for up to 7 days subject to storage limits\.\])$/u;
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
function assistant(id?: string, usage = 0): AssistantMessage {
  return {
    role: "assistant", content: id ? [{ type: "toolCall", id, name: "read_file", arguments: { path: `${id}.ts` } }] : [{ type: "text", text: "Observed results." }],
    api: "openai-completions", provider: "shadow", model: "shadow", stopReason: id ? "toolUse" : "stop", timestamp: 2,
    usage: { input: usage, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function result(id: string, body: string, recoverable = true, isError = false): ToolResultMessage {
  const marker = suffix.replace(/180000/gu, String(body.length));
  return { role: "toolResult", toolCallId: id, toolName: "read_file", timestamp: 3, isError,
    content: [{ type: "text", text: body + (recoverable ? `\n${marker}` : "") }], details: { fixture: true } };
}
const body = "source line\n".repeat(8_000);
function transcript(payload = body): AgentMessage[] {
  return [user("Earlier constraint: use SCHEMA-V2; preserve exact identifier TASK-417."),
    assistant("old-1"), result("old-1", payload + "\nMIDDLE-DECISION-991\n" + payload),
    assistant("old-2"), result("old-2", payload),
    assistant("recent-1"), result("recent-1", "recent decisive assertion"),
    assistant("recent-2"), result("recent-2", "latest decisive result"), user("Continue TASK-417; do not change SCHEMA-V2.")];
}
interface Fixture { id: string; messages: AgentMessage[]; identity?: boolean; staticPrompt?: string; }
const fixtures: Fixture[] = [
  { id: "recoverable-history-unanchored", messages: transcript() },
  { id: "recoverable-history-anchored", messages: [...transcript(), assistant(undefined, 120_000)], identity: true },
  { id: "recoverable-history-low-anchor", messages: [...transcript(), assistant(undefined, 5_000)], identity: true },
  { id: "provider-switch", messages: [...transcript(), assistant(undefined, 120_000)] },
  { id: "unicode", messages: transcript("证据😀 café\n".repeat(8_000)) },
  { id: "no-recovery", messages: transcript().map((m) => m.role === "toolResult" ? { ...m, content: [{ type: "text" as const, text: body }] } : m) },
  { id: "errors", messages: transcript().map((m) => m.role === "toolResult" ? { ...m, isError: true } : m) },
  { id: "small-context", messages: transcript("small output") },
  { id: "orphan-result", messages: transcript().filter((m) => !(m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && p.id === "old-1"))) },
  { id: "system-update", messages: [createInitialSystemMessage("Research system", [])!, user("begin"),
    { role: "system", content: "", sections: { instructions: "Old constraint. ".repeat(500) }, timestamp: 4 },
    { role: "system", content: "", sections: { instructions: "Updated constraint: never change DATABASE-V3." }, timestamp: 5 }, ...transcript()] },
  { id: "queued-large-user", messages: [...transcript(), user("Accepted queued correction: "+"preserve this evidence ".repeat(20_000))] },
  { id: "mixed-image-result", messages: transcript().map((m) => m.role === "toolResult" ? { ...m, content: [...m.content, { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }] } : m) },
  { id: "static-pressure", messages: transcript("small output"), staticPrompt: "Stable tool guidance. ".repeat(10_000) },
  { id: "pending-call", messages: [...transcript(), assistant("pending")] },
  { id: "active-tool-loop", messages: transcript().slice(0, -1) },
  { id: "large-recent-results", messages: transcript().map((m) => m.role === "toolResult" && m.toolCallId.startsWith("recent-") ? result(m.toolCallId, body) : m) },
  { id: "anchor-before-tail", messages: [user("Start with existing context"), assistant(undefined, 5_000), ...transcript()], identity: true },
];
// Hand-authored fixture oracles, independent of the candidate eligibility predicate.
const expectedChangedIds: Record<string, string[]> = {
  "recoverable-history-unanchored": ["old-1", "old-2"],
  "recoverable-history-anchored": ["old-1", "old-2"],
  "recoverable-history-low-anchor": ["old-1", "old-2"],
  "provider-switch": ["old-1", "old-2"], unicode: ["old-1", "old-2"],
  "no-recovery": [], errors: [], "small-context": [], "orphan-result": ["old-2"],
  "system-update": ["old-1", "old-2"], "queued-large-user": ["old-1", "old-2"],
  "mixed-image-result": [], "static-pressure": [], "pending-call": ["old-1", "old-2"],
  "active-tool-loop": ["old-1", "old-2"],
  "large-recent-results": ["old-1", "old-2"], "anchor-before-tail": ["old-1", "old-2"],
};

function recovery(message: ToolResultMessage): string | undefined {
  if (message.content.length !== 1 || message.content[0]?.type !== "text") return undefined;
  return recoveryPattern.exec(message.content[0].text.slice(-400))?.[1];
}
function eligible(messages: AgentMessage[], index: number): boolean {
  const m = messages[index];
  if (m?.role !== "toolResult" || m.isError || !recovery(m)) return false;
  const laterResults = messages.slice(index + 1).filter((entry) => entry.role === "toolResult");
  if (laterResults.length < 2) return false;
  if ((m.content[0]?.type === "text" ? m.content[0].text.length : 0) < 2_000) return false;
  return messages.slice(0, index).some((entry) => entry.role === "assistant" && entry.content.some((part) => part.type === "toolCall" && part.id === m.toolCallId && part.name === m.toolName));
}
/** Conservative candidate changes only recoverable old non-error tool-result envelopes. */
function elide(messages: AgentMessage[]): AgentMessage[] {
  return structuredClone(messages).map((m, index) => eligible(messages, index) && m.role === "toolResult"
    ? { ...m, content: [{ type: "text", text: `[Earlier ${m.toolName} result payload omitted in this research projection. The call completed; use the retained output if needed.]\n${recovery(m)}` }] }
    : m);
}
function assertInvariant(before: AgentMessage[], after: AgentMessage[]): void {
  assert.equal(after.length, before.length, "candidate must preserve message count");
  for (const [index, original] of before.entries()) {
    const current = after[index]!;
    if (!eligible(before, index)) assert.deepEqual(current, original, `protected message ${index}`);
    else {
      assert.equal(current.role, "toolResult");
      const { content: _oldContent, ...oldEnvelope } = original as ToolResultMessage;
      const { content: _newContent, ...newEnvelope } = current as ToolResultMessage;
      assert.deepEqual(newEnvelope, oldEnvelope, `tool envelope ${index}`);
      assert.equal(recovery(current as ToolResultMessage), recovery(original as ToolResultMessage), `recoverable output ${index}`);
    }
  }
}
// Independent negative controls prove the checker rejects actual information loss.
const control = transcript();
const deletedUser = elide(control); deletedUser[0] = user("constraint lost");
assert.throws(() => assertInvariant(control, deletedUser), /protected message/u);
const lostRecovery = elide(control); (lostRecovery[2] as ToolResultMessage).content = [{ type: "text", text: "omitted" }];
assert.throws(() => assertInvariant(control, lostRecovery), /recoverable output/u);
const lostCall = elide(control); (lostCall[1] as AssistantMessage).content = [];
assert.throws(() => assertInvariant(control, lostCall), /protected message/u);
const lostError = structuredClone(fixtures.find((f) => f.id === "errors")!.messages);
(lostError[2] as ToolResultMessage).content = [{ type: "text", text: `Error payload corrupted\n${recovery(lostError[2] as ToolResultMessage)}` }];
assert.throws(() => assertInvariant(fixtures.find((f) => f.id === "errors")!.messages, lostError), /protected message/u);

const measurements = [];
for (const fixture of fixtures) {
  for (const contextWindow of windows) {
    const snapshot = JSON.stringify(fixture.messages);
    const candidate = elide(fixture.messages);
    assert.equal(JSON.stringify(fixture.messages), snapshot, "projection must not mutate its input");
    assertInvariant(fixture.messages, candidate);
    const changedIds = candidate.flatMap((message, index) => JSON.stringify(message) !== JSON.stringify(fixture.messages[index])
      ? [message.role === "toolResult" ? message.toolCallId : `unexpected-${message.role}`] : []);
    assert.deepEqual(changedIds, expectedChangedIds[fixture.id], `independent fixture oracle: ${fixture.id}`);
    const options: GenerationContextOptions = { contextWindow, systemPrompt: fixture.staticPrompt ?? (fixture.id === "system-update"
      ? getCurrentSystemPrompt(fixture.messages as Parameters<typeof getCurrentSystemPrompt>[0]) : "Research shadow context."), tools: [], retainsSystemUpdates: true,
      ...(fixture.identity ? { providerId: "shadow", modelId: "shadow" } : { providerId: "other", modelId: "other" }) };
    const measure = (messages: AgentMessage[]) => {
      const beforeProjection = JSON.stringify(messages);
      const start = performance.now();
      const pressure = projectNextContextUsage(messages, options);
      const emergency = compactGenerationContext(messages, options);
      assert.equal(JSON.stringify(messages), beforeProjection, "production projectors must not mutate input");
      return { pressure, emergency: { compacted: emergency.compacted, estimatedTokensBefore: emergency.estimatedTokensBefore,
        estimatedTokensAfter: emergency.estimatedTokensAfter, kind: emergency.emergencyProjection.kind, removedHistoryMessages: emergency.removedHistoryMessages,
        removedCurrentTurnMessages: emergency.removedCurrentTurnMessages, truncatedToolResults: emergency.truncatedToolResults, compactedToolResults: emergency.compactedToolResults,
        recoveryMarkersAfter: emergency.messages.filter((m) => m.role === "toolResult" && recovery(m)).length },
        localDurationMs: performance.now() - start };
    };
    const baseline = measure(structuredClone(fixture.messages));
    const treatment = measure(candidate);
    const elidedResults = changedIds.length;
    measurements.push({ fixture: fixture.id, inputSha256: createHash("sha256").update(snapshot).digest("hex"), contextWindow, elidedResults,
      observationInvariantsPassed: true, baseline, candidate: treatment,
      estimatedMessageTokenDelta: treatment.pressure.messageTokens - baseline.pressure.messageTokens,
      projectedContextTokenDelta: treatment.pressure.contextTokens - baseline.pressure.contextTokens,
      counterfactualShouldCompactAvoided: baseline.pressure.shouldCompact && !treatment.pressure.shouldCompact,
      counterfactualShouldCompactIntroduced: !baseline.pressure.shouldCompact && treatment.pressure.shouldCompact });
  }
}
assert.ok(measurements.every((row) => !row.counterfactualShouldCompactIntroduced));
assert.ok(measurements.some((row) => row.elidedResults > 0 && row.counterfactualShouldCompactAvoided));
assert.ok(measurements.some((row) => row.fixture === "recoverable-history-anchored" && row.estimatedMessageTokenDelta < 0 && row.projectedContextTokenDelta === 0), "usage anchors must not be discarded to manufacture savings");
assert.ok(measurements.filter((row) => row.fixture === "active-tool-loop").every((row) => row.baseline.pressure.compressibleHistoryMessages === 0));
for (const id of ["no-recovery", "errors", "small-context", "mixed-image-result"]) {
  assert.ok(measurements.filter((row) => row.fixture === id).every((row) => row.elidedResults === 0 && row.projectedContextTokenDelta === 0));
}
console.log(JSON.stringify({ version: 1, evidenceKind: "synthetic-shadow", generatedAt: new Date().toISOString(),
  baselinePolicy: "current production projectors", candidatePolicy: "research recoverable old non-error-envelope text-only elision, newest two results protected",
  windows, fixtureCount: fixtures.length, pairCount: measurements.length, negativeControlsPassed: 4,
  limitations: ["No model calls, live task success, billed-token savings, or actual recall-store reads measured.", "isError=false describes only a tool-result envelope; it does not establish command exit success or task correctness.", "Counterfactual trigger avoidance means projected shouldCompact changes; no native lifecycle integration is implemented.", "Synthetic recovery handles describe fixture evidence only; they are not actual retained store objects.", "Provider usage anchors remain authoritative and can prevent projected savings despite smaller observation text.", "Emergency projection may remove histories; candidate observation invariants apply before that existing fallback.", "Local one-shot durations are diagnostics, not statistically controlled performance estimates."],
  measurements }, null, 2));
