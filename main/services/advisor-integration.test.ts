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
});

test("Advisor no-replay recovery initializes with main handler startup", () => {
  const handler = readFileSync(new URL("../handlers/advisor.ts", import.meta.url), "utf8");
  assert.match(handler, /advisorRuntime\.initialize\(\)\.catch/u);
  assert.ok(handler.indexOf("advisorRuntime.initialize") < handler.indexOf('ipcMain.handle("advisor:get"'));
});
