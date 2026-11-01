import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createGenerationHarness } from "./generation-harness.js";
import { convertToLlm } from "./pi-legacy-harness.js";
import {
  PiAgentRuntimeHarness,
  type PiAgentRuntimeExtension,
  type PiAgentRuntimeHarnessOptions,
} from "./pi-agent-runtime-harness.js";

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
  };
}

const searchExtension: PiAgentRuntimeExtension = { id: "aiden.example.search", tools: [tool("web_search")] };

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

test("the default profile builds with any tool set", () => {
  const { options } = harnessOptions({ extensions: [searchExtension] }, [tool("bash"), tool("read")]);
  assert.ok(createGenerationHarness(options) instanceof PiAgentRuntimeHarness);
});
