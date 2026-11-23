import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSliderSettings } from "../shared/agent-slider";
import type { Provider } from "./types";
import { agentSliderComposerState, agentSliderStepTarget, agentSliderStopSetsEffort } from "./agent-slider-view";

const acme = {
  id: "acme",
  kind: "openai",
  label: "Acme",
  baseUrl: "https://acme.invalid/v1",
  models: ["fast", "mid", "smart"],
  needsKey: false,
  hasKey: true,
} as Provider;

const slider: AgentSliderSettings = {
  version: 1,
  homeStopId: "mid",
  stops: [
    { id: "fast", label: "Fast", providerId: "acme", model: "fast" },
    { id: "mid", label: "Balanced", providerId: "acme", model: "mid", thinkingLevel: "medium" },
    { id: "gone", label: "Gone", providerId: "acme", model: "retired" },
    { id: "smart", label: "Smart", providerId: "acme", model: "smart", thinkingLevel: "high" },
  ],
};

const inventory = { providers: [acme] };

test("the step shortcuts land on the next stop that can run, with its effort", () => {
  const onBalanced = agentSliderComposerState(slider, inventory, {
    providerId: "acme",
    model: "mid",
    thinkingLevel: "medium",
  });
  assert.equal(onBalanced?.position.custom, false);
  assert.equal(agentSliderStepTarget(onBalanced, 1)?.id, "smart");
  assert.equal(agentSliderStepTarget(onBalanced, 1)?.thinkingLevel, "high");
  assert.equal(agentSliderStepTarget(onBalanced, -1)?.id, "fast");

  const onSmart = agentSliderComposerState(slider, inventory, {
    providerId: "acme",
    model: "smart",
    thinkingLevel: "high",
  });
  assert.equal(agentSliderStepTarget(onSmart, 1), undefined, "nothing past the last stop");
  assert.equal(agentSliderStepTarget(onSmart, -1)?.id, "mid", "the missing model is skipped");
});

test("Custom steps from the home stop, and with no slider there is nothing to step", () => {
  // The home stop's model at another effort is not on the slider.
  const custom = agentSliderComposerState(slider, inventory, {
    providerId: "acme",
    model: "mid",
    thinkingLevel: "low",
  });
  assert.equal(custom?.position.custom, true);
  assert.equal(agentSliderStepTarget(custom, 1)?.id, "smart");
  assert.equal(agentSliderStepTarget(custom, -1)?.id, "fast");

  const none = agentSliderComposerState(undefined, inventory, { providerId: "acme", model: "mid" });
  assert.equal(none, undefined);
  assert.equal(agentSliderStepTarget(none, 1), undefined);
});

test("with the home stop the only one that can run, a step from Custom lands on it", () => {
  const lonely: AgentSliderSettings = {
    version: 1,
    homeStopId: "mid",
    stops: [
      { id: "a", label: "A" },
      { id: "mid", label: "Balanced", providerId: "acme", model: "mid" },
      { id: "b", label: "B", providerId: "nowhere", model: "x" },
    ],
  };
  const custom = agentSliderComposerState(lonely, inventory, { providerId: "acme", model: "smart" });
  assert.equal(agentSliderStepTarget(custom, 1)?.id, "mid");
  assert.equal(agentSliderStepTarget(custom, -1)?.id, "mid");
});

test("only a stop with its own effort takes over the effort control", () => {
  const onBalanced = agentSliderComposerState(slider, inventory, {
    providerId: "acme",
    model: "mid",
    thinkingLevel: "medium",
  });
  assert.equal(agentSliderStopSetsEffort(onBalanced), true);
  // Fast has no level: the model's own effort setting applies and stays adjustable.
  const onFast = agentSliderComposerState(slider, inventory, { providerId: "acme", model: "fast" });
  assert.equal(onFast?.position.custom, false);
  assert.equal(agentSliderStopSetsEffort(onFast), false);
  const custom = agentSliderComposerState(slider, inventory, { providerId: "acme", model: "mid", thinkingLevel: "low" });
  assert.equal(custom?.position.custom, true);
  assert.equal(agentSliderStopSetsEffort(custom), false);
  assert.equal(agentSliderStopSetsEffort(undefined), false, "no slider, no stop");
});
