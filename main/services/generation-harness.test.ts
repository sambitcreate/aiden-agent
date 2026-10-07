import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createGenerationHarness } from "./generation-harness.js";
import { resolveGenerationProfile } from "./generation-profile.js";
import { convertToLlm } from "./pi-legacy-harness.js";
import {
  PiAgentRuntimeHarness,
  resolvePiAgentRuntimeContributionSnapshot,
  type PiAgentRuntimeExtension,
  type PiAgentRuntimeHarnessOptions,
} from "./pi-agent-runtime-harness.js";

const design = resolveGenerationProfile(
  { owner: { kind: "design-project", projectId: "project-1" } },
  { designRun: { projectId: "project-1", runId: "run-1" } },
);

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
  };
}

const designExtension: PiAgentRuntimeExtension = { id: "aiden.design.render", tools: [tool("render_artifact")] };

function harnessOptions(overrides: Partial<PiAgentRuntimeHarnessOptions>, tools: AgentTool[] = []) {
  const core = createFauxCore({ provider: `aiden-profile-${Math.random().toString(36).slice(2)}` });
  core.setResponses([fauxAssistantMessage("must not run")]);
  const options: PiAgentRuntimeHarnessOptions = {
    convertToLlm,
    streamFn: core.streamSimple,
    initialState: { systemPrompt: "", thinkingLevel: "off", tools, messages: [], model: core.getModel() },
    ...overrides,
  };
  return { core, options };
}

test("a design harness builds with render_artifact alone", () => {
  const { options } = harnessOptions({ extensions: [designExtension] });
  assert.ok(createGenerationHarness(design, options) instanceof PiAgentRuntimeHarness);
});

test("any other contributed tool refuses to build a design harness before a provider request", () => {
  const cases: Array<[string, ReturnType<typeof harnessOptions>]> = [
    ["an extension tool", harnessOptions({ extensions: [designExtension, { id: "aiden.memory", tools: [tool("memory_search")] }] })],
    ["a base tool", harnessOptions({ extensions: [designExtension] }, [tool("bash")])],
    [
      "a contribution snapshot",
      harnessOptions({ contributions: resolvePiAgentRuntimeContributionSnapshot("", [tool("read")], {}, [designExtension]) }),
    ],
  ];
  for (const [label, { core, options }] of cases) {
    assert.throws(() => createGenerationHarness(design, options), /design profile cannot expose/u, label);
    assert.equal(core.state.callCount, 0, label);
  }
});

test("the default profile builds with any tool set", () => {
  const { options } = harnessOptions({ extensions: [designExtension] }, [tool("bash"), tool("read")]);
  assert.ok(createGenerationHarness({ kind: "default" }, options) instanceof PiAgentRuntimeHarness);
});
