import assert from "node:assert/strict";
import test from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { DesignRunRequest } from "../../../renderer/shared/design/types.js";
import { createGenerationHarness } from "../generation-harness.js";
import { resolveGenerationProfile } from "../generation-profile.js";
import { convertToLlm } from "../pi-legacy-harness.js";
import {
  createDesignRenderExtension,
  designSystemPrompt,
  type DesignRenderArtifact,
} from "./design-render-extension.js";
import { DesignStoreError } from "./store-core.js";

const design = resolveGenerationProfile(
  { owner: { kind: "design-project", projectId: "project-1" } },
  { designRun: { projectId: "project-1", runId: "run-1" } },
);
const explore = (count: 2 | 3 | 4): DesignRunRequest => ({ op: "explore", count, creativeRange: "balanced", aspects: [] });
const page = (label: string) => `<main><h1>${label}</h1></main>`;
const render = (title: string, html = page(title), id?: string) =>
  fauxToolCall("render_artifact", { title, html }, id === undefined ? undefined : { id });
const invalid = (title: string) => render(title, '<iframe src="https://example.com"></iframe>');
const turn = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

function recorder(failWith?: Error) {
  const accepted: DesignRenderArtifact[] = [];
  return {
    accepted,
    accept: async (artifact: DesignRenderArtifact) => {
      if (failWith) throw failWith;
      accepted.push(artifact);
      return { revisionId: `rev-${accepted.length}` };
    },
  };
}

async function runDesign(
  responses: FauxResponseStep[],
  options: {
    cap: 2 | 3 | 4;
    store?: ReturnType<typeof recorder>;
    contextText?: string;
    existingTitles?: readonly string[];
    revisionForToolCall?: (toolCallId: string) => string | undefined;
  },
) {
  const store = options.store ?? recorder();
  const extension = createDesignRenderExtension({
    request: explore(options.cap),
    cap: options.cap,
    contextText: options.contextText ?? "",
    existingTitles: options.existingTitles ?? [],
    accept: store.accept,
    revisionForToolCall: options.revisionForToolCall ?? (() => undefined),
  });
  const core = createFauxCore({ provider: `aiden-design-render-${Math.random().toString(36).slice(2)}` });
  core.setResponses(responses);
  const harness = createGenerationHarness(design, {
    convertToLlm,
    streamFn: core.streamSimple,
    initialState: { systemPrompt: "", thinkingLevel: "off", tools: [], messages: [], model: core.getModel() },
    extensions: [extension.extension],
  });
  await harness.prompt("Design a pricing page");
  return { core, harness, state: extension.state(), accepted: store.accepted };
}

test("Explore stops at N accepted designs without a summary request", async () => {
  const { core, state, accepted } = await runDesign(
    [turn(render("Calm")), turn(render("Bold")), fauxAssistantMessage("Here are two directions.")],
    { cap: 2 },
  );
  assert.equal(core.state.callCount, 2);
  assert.equal(core.getPendingResponseCount(), 1, "the summary request is never sent");
  assert.deepEqual(accepted.map((artifact) => artifact.title), ["Calm", "Bold"]);
  assert.equal(state.stop, "complete");
});

test("N designs in one response end the run after a single request", async () => {
  const { core, state } = await runDesign([turn(render("A"), render("B"), render("C")), fauxAssistantMessage("unused")], { cap: 3 });
  assert.equal(core.state.callCount, 1);
  assert.equal(state.accepted, 3);
});

test("a runaway model stops at 2N render calls, counting invalid ones", async () => {
  const { core, state, accepted } = await runDesign(
    [turn(invalid("a"), invalid("b"), invalid("c"), invalid("d")), turn(render("late"))],
    { cap: 2 },
  );
  assert.equal(core.state.callCount, 1);
  assert.equal(accepted.length, 0);
  assert.equal(state.renderCalls, 4);
  assert.equal(state.stop, "render-cap");
});

test("the turn cap ends a run whose calls keep failing", async () => {
  const responses = Array.from({ length: 6 }, (_, index) => turn(invalid(`attempt ${index}`)));
  const { core, state } = await runDesign(responses, { cap: 3 });
  assert.equal(core.state.callCount, 5, "N + 2 provider turns");
  assert.equal(state.renderCalls, 5);
  assert.equal(state.stop, "turn-cap");
});

test("a model that stops with text leaves the run short without more requests", async () => {
  const { core, state } = await runDesign(
    [turn(render("Only")), fauxAssistantMessage("That is all I have."), turn(render("never"))],
    { cap: 3 },
  );
  assert.equal(core.state.callCount, 2);
  assert.equal(state.accepted, 1);
  assert.equal(state.stop, undefined);
});

test("calls past N are refused with terminate and never reach the store", async () => {
  const { core, harness, accepted } = await runDesign(
    [turn(render("A"), render("B"), render("C")), fauxAssistantMessage("unused")],
    { cap: 2 },
  );
  assert.equal(core.state.callCount, 1);
  assert.deepEqual(accepted.map((artifact) => artifact.title), ["A", "B"]);
  const results = harness.state.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 3);
  assert.equal(results[2]?.role === "toolResult" ? results[2].isError : undefined, true);
  assert.match(JSON.stringify(results[2]), /Do not render more/u);
});

test("same-title replacement swaps the draft and is bounded per run", async () => {
  const { accepted, state } = await runDesign(
    [
      turn(render("Hero"), render("Hero", page("Hero v2")), render("Hero", page("Hero v3")), render("Hero", page("Hero v4"))),
      fauxAssistantMessage("unused"),
    ],
    { cap: 2 },
  );
  assert.deepEqual(accepted.map((artifact) => artifact.replacesRevisionId), [undefined, "rev-1", "rev-2"]);
  assert.equal(state.accepted, 1);
  assert.equal(state.replacements, 2);
});

test("accepted HTML never reaches the next request and the untrusted context precedes the brief", async () => {
  let seen = "";
  await runDesign(
    [
      turn(render("First", `<main>${"q".repeat(4096)}</main>`, "call_first")),
      (context) => {
        seen = JSON.stringify(context.messages);
        return turn(render("Second"));
      },
      fauxAssistantMessage("unused"),
    ],
    {
      cap: 2,
      contextText: '<design_context trust="untrusted">brand: teal</design_context>',
      revisionForToolCall: (id) => (id === "call_first" ? "rev-1" : undefined),
    },
  );
  assert.equal(seen.includes("qqqq"), false);
  assert.match(seen, /\[design revision rev-1 omitted\]/u);
  assert.ok(seen.indexOf("brand: teal") < seen.indexOf("Design a pricing page"));
});

test("a store refusal is a tool error the model can read", async () => {
  const store = recorder(new DesignStoreError("quota", "This project has reached its 64-Screen limit."));
  const { harness, state } = await runDesign([turn(render("Blocked")), fauxAssistantMessage("Understood.")], { cap: 2, store });
  assert.equal(state.accepted, 0);
  const results = harness.state.messages.filter((message) => message.role === "toolResult");
  assert.match(JSON.stringify(results), /64-Screen limit/u);
});

test("a Resume refuses a title that repeats an existing direction and asks for exactly the missing count", async () => {
  const { core, harness, state, accepted } = await runDesign(
    [turn(render("calm  DAWN"), render("Bold"), render("Night")), fauxAssistantMessage("unused")],
    { cap: 2, existingTitles: ["Calm Dawn"] },
  );
  assert.equal(core.state.callCount, 1);
  assert.deepEqual(accepted.map((artifact) => artifact.title), ["Bold", "Night"], "the duplicate never reaches the store");
  assert.deepEqual([state.accepted, state.renderCalls, state.stop], [2, 3, "complete"]);
  const results = harness.state.messages.filter((message) => message.role === "toolResult");
  assert.equal(results[0]?.role === "toolResult" ? results[0].isError : undefined, true);
  assert.match(JSON.stringify(results[0]), /already exists/u);
  const prompt = designSystemPrompt(explore(3), 2, ["Calm Dawn"]);
  assert.match(prompt, /exactly 2 more/u);
  assert.equal(prompt.includes("Calm Dawn"), false, "model-written titles stay out of the system prompt");
});
