import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "./pi-legacy-harness.js";
import {
  PiAgentRuntimeHarness,
  type PiAgentRuntimeHarnessOptions,
  type PiHarnessFault,
} from "./pi-agent-runtime-harness.js";

const echo: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo.",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
};

function harness(responses: FauxResponseStep[], options: Partial<PiAgentRuntimeHarnessOptions> = {}) {
  const core = createFauxCore({ provider: `aiden-finish-turn-${Math.random().toString(36).slice(2)}` });
  core.setResponses(responses);
  const instance = new PiAgentRuntimeHarness({
    convertToLlm,
    streamFn: core.streamSimple,
    initialState: { systemPrompt: "Base", thinkingLevel: "off", tools: [echo], messages: [], model: core.getModel() },
    ...options,
  });
  return { core, harness: instance };
}

const toolTurn = () => fauxAssistantMessage([fauxToolCall("echo", {})], { stopReason: "toolUse" });

test("an extension can end the run before Pi spends another provider request", async () => {
  const seen: string[] = [];
  const { core, harness: run } = harness([toolTurn(), fauxAssistantMessage("summary")], {
    extensions: [
      {
        id: "stopper",
        finishTurn: (turn) => {
          seen.push(turn.message.stopReason);
          return { action: "end" };
        },
      },
    ],
  });
  await run.prompt("go");
  assert.equal(core.state.callCount, 1);
  assert.equal(core.getPendingResponseCount(), 1);
  assert.deepEqual(seen, ["toolUse"]);
  assert.ok(run.state.messages.some((message) => message.role === "toolResult"), "the tool result is kept");
});

test("without an end vote Pi keeps its normal scheduling", async () => {
  const { core, harness: run } = harness([toolTurn(), fauxAssistantMessage("summary")], {
    extensions: [{ id: "observer", finishTurn: () => undefined }],
  });
  await run.prompt("go");
  assert.equal(core.state.callCount, 2);
});

test("a run with no finishTurn contributions keeps the default scheduling", async () => {
  const { core, harness: run } = harness([toolTurn(), fauxAssistantMessage("summary")]);
  await run.prompt("go");
  assert.equal(core.state.callCount, 2);
});

test("error and aborted responses never reach extension finishTurn", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    let calls = 0;
    const { harness: run } = harness(
      [fauxAssistantMessage("", { stopReason, errorMessage: `${stopReason} response` })],
      { extensions: [{ id: "counter", finishTurn: () => { calls += 1; return { action: "end" }; } }] },
    );
    await run.prompt("go").catch(() => undefined);
    assert.equal(calls, 0, stopReason);
  }
});

test("an extension end overrides a host continue, and the host still runs", async () => {
  let hostCalls = 0;
  const hostContinueOnce: PiAgentRuntimeHarnessOptions["finishTurn"] = () => {
    hostCalls += 1;
    return hostCalls === 1 ? { action: "continue" } : undefined;
  };
  const passive = harness([fauxAssistantMessage("one"), fauxAssistantMessage("two")], {
    finishTurn: hostContinueOnce,
    extensions: [{ id: "observer", finishTurn: () => undefined }],
  });
  await passive.harness.prompt("go");
  assert.equal(passive.core.state.callCount, 2, "the host continue is honored");

  hostCalls = 0;
  const ending = harness([fauxAssistantMessage("one"), fauxAssistantMessage("two")], {
    finishTurn: hostContinueOnce,
    extensions: [{ id: "stopper", finishTurn: () => ({ action: "end" }) }],
  });
  await ending.harness.prompt("go");
  assert.equal(ending.core.state.callCount, 1);
  assert.equal(hostCalls, 1);
});

test("a throwing finishTurn extension fails the run closed as a policy fault", async () => {
  const faults: PiHarnessFault[] = [];
  const { core, harness: run } = harness([toolTurn(), fauxAssistantMessage("must not run")], {
    extensions: [{ id: "broken", finishTurn: () => { throw new Error("private stop failure"); } }],
    onFault: (fault) => faults.push(fault),
  });
  await assert.rejects(run.prompt("go"));
  assert.equal(core.state.callCount, 1);
  assert.deepEqual(faults.map((fault) => [fault.source, fault.extensionId]), [["extension_finish_turn", "broken"]]);
});
