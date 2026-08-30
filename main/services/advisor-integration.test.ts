import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");

test("foreground generation adds Advisor per run before freezing runtime contributions", () => {
  const baseIndex = source.indexOf("const baseRuntimeExtensions");
  const advisorIndex = source.indexOf("advisorRuntime.extensionForGeneration");
  const finalIndex = source.indexOf("const runtimeContributions");
  assert.ok(baseIndex >= 0 && advisorIndex > baseIndex && finalIndex > advisorIndex);
  assert.match(
    source,
    /runtimeExtensions: readonly PiAgentRuntimeExtension\[\] = advisorExtension/u,
  );
  assert.match(source, /snapshotAdvisorRuntimeMessages\(candidate\.state, toolCallId\)/u);
});

test("Advisor receives authoritative surface, mode, executor, and tool inventory", () => {
  const hook = source.slice(
    source.indexOf("advisorRuntime.extensionForGeneration"),
    source.indexOf(
      "const runtimeExtensions",
      source.indexOf("advisorRuntime.extensionForGeneration"),
    ),
  );
  assert.match(hook, /usageSource: options\.usageSource,/u);
  assert.doesNotMatch(hook, /usageSource: options\.usageSource \?\?/u);
  assert.match(hook, /interactionSurface: options\.interactionSurface/u);
  assert.match(hook, /mode: authoritativeMode/u);
  assert.match(hook, /bot: preparedBotContext !== undefined/u);
  assert.match(hook, /child: false/u);
  assert.match(hook, /rendererOwner: owner\.id !== 0/u);
  assert.match(hook, /excluded: options\.excludeToolNames\?\.has\(ADVISOR_TOOL_NAME\)/u);
  assert.match(hook, /providerId: runtime\.provider\.id/u);
  assert.match(hook, /modelId: model\.id/u);
  assert.match(hook, /effort: thinkingLevel/u);
  assert.match(hook, /executorTools: toolsBeforeAdvisor/u);
  assert.match(hook, /requestQuestionnaire:/u);
  assert.match(hook, /questionnaires\.request/u);
  assert.match(hook, /owner\.documentId/u);
});

test("Advisor no-replay recovery initializes at app handler startup without settings IPC", () => {
  const registry = readFileSync(new URL("../handlers/index.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("./advisor-runtime-main.ts", import.meta.url), "utf8");
  const rendererIpc = readFileSync(new URL("../../renderer/lib/ipc.ts", import.meta.url), "utf8");
  const modelDataSettings = readFileSync(
    new URL("../../renderer/components/settings/model-data-settings.tsx", import.meta.url),
    "utf8",
  );
  const channels = readFileSync(
    new URL("../../renderer/preload-channels.ts", import.meta.url),
    "utf8",
  );
  assert.match(registry, /initializeAdvisorRuntime\(\)/u);
  assert.match(runtime, /advisorRuntime\.initialize\(\)\.catch/u);
  assert.doesNotMatch(channels, /"advisor:"/u);
  assert.doesNotMatch(registry, /registerAdvisorHandlers/u);
  assert.doesNotMatch(rendererIpc, /advisorApi|advisor:get|advisor:set/u);
  assert.doesNotMatch(modelDataSettings, /AdvisorSettings|advisor-settings/u);
});
