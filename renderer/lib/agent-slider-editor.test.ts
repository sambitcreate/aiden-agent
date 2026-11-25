import assert from "node:assert/strict";
import test from "node:test";
import {
  addAgentSliderStop,
  agentSliderLabelError,
  assignAgentSliderStop,
  effortLadderTemplate,
  localToCloudTemplate,
  moveAgentSliderStop,
  removeAgentSliderStop,
  renameAgentSliderStop,
} from "./agent-slider-editor";
import { parseAgentSliderPatch, type AgentSliderSettings } from "../shared/agent-slider";

function ids(prefix: string) {
  let next = 0;
  return () => `${prefix}_${(next += 1)}`;
}

const base: AgentSliderSettings = {
  version: 1,
  homeStopId: "b",
  stops: [
    { id: "a", label: "Fast", providerId: "p", model: "fast" },
    { id: "b", label: "Stop 4", providerId: "p", model: "mid" },
    { id: "c", label: "Smart", providerId: "p", model: "smart", thinkingLevel: "high" },
  ],
};

test("every edit gives a slider main's parser accepts as it is", () => {
  const edits = [
    addAgentSliderStop(base, ids("new")),
    removeAgentSliderStop(addAgentSliderStop(base, ids("new")), "b"),
    moveAgentSliderStop(base, "a", 1),
    renameAgentSliderStop(base, "a", "  Quick  "),
    assignAgentSliderStop(base, "a", { providerId: "q", model: "m", levels: ["low", "high"], defaultLevel: "low" }),
    effortLadderTemplate({ providerId: "p", model: "smart", levels: ["low", "medium", "high"] }, ids("lad"))!,
    localToCloudTemplate({ local: undefined, cloud: { providerId: "p", model: "mid" } }, ids("ltc")),
  ];
  for (const slider of edits) assert.deepEqual(parseAgentSliderPatch(slider), slider);
});

test("a new stop gets the next free Stop number and no model", () => {
  const added = addAgentSliderStop(base, ids("new"));
  // "Stop 4" is taken by a renamed stop, so the fourth stop is "Stop 5".
  assert.deepEqual(added.stops[3], { id: "new_1", label: "Stop 5" });
});

test("stop counts stay within 3 to 7", () => {
  assert.equal(removeAgentSliderStop(base, "a"), base);
  let full = base;
  for (let count = 0; count < 6; count += 1) full = addAgentSliderStop(full, ids(`n${count}`));
  assert.equal(full.stops.length, 7);
  assert.equal(addAgentSliderStop(full, ids("more")), full);
});

test("removing the home stop moves home to the middle of what is left", () => {
  const four = addAgentSliderStop(base, ids("new"));
  const removed = removeAgentSliderStop(four, "b");
  assert.deepEqual(removed.stops.map((stop) => stop.id), ["a", "c", "new_1"]);
  assert.equal(removed.homeStopId, "c");
});

test("moves stop at the ends", () => {
  assert.equal(moveAgentSliderStop(base, "a", -1), base);
  assert.equal(moveAgentSliderStop(base, "c", 1), base);
  assert.deepEqual(moveAgentSliderStop(base, "c", -1).stops.map((stop) => stop.id), ["a", "c", "b"]);
});

test("an invalid name says why and leaves the slider alone", () => {
  assert.equal(agentSliderLabelError(""), "Give this stop a name.");
  assert.equal(agentSliderLabelError("x".repeat(25)), "Use 24 characters or fewer.");
  assert.equal(agentSliderLabelError("bad\u0007"), "Remove the control characters from this name.");
  assert.equal(agentSliderLabelError("x".repeat(24)), undefined);
  assert.equal(renameAgentSliderStop(base, "a", "  "), base);
});

test("a reassigned stop keeps its effort when the new model has it, else takes the default", () => {
  const kept = assignAgentSliderStop(base, "c", {
    providerId: "q",
    model: "other",
    levels: ["low", "medium", "high"],
    defaultLevel: "medium",
  });
  assert.equal(kept.stops[2]?.thinkingLevel, "high");
  const defaulted = assignAgentSliderStop(base, "c", {
    providerId: "q",
    model: "other",
    levels: ["low", "medium"],
    defaultLevel: "medium",
  });
  assert.equal(defaulted.stops[2]?.thinkingLevel, "medium");
  const none = assignAgentSliderStop(base, "c", { providerId: "q", model: "plain", levels: [] });
  assert.equal("thinkingLevel" in none.stops[2]!, false);
});

test("the effort ladder needs three levels and puts home in the middle", () => {
  assert.equal(effortLadderTemplate({ providerId: "p", model: "m", levels: ["low", "high"] }), undefined);
  const ladder = effortLadderTemplate(
    { providerId: "p", model: "m", levels: ["off", "low", "medium", "high", "xhigh"] },
    ids("lad"),
  )!;
  assert.deepEqual(ladder.stops.map((stop) => stop.thinkingLevel), ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(ladder.homeStopId, ladder.stops[2]!.id);
});

test("Local to cloud leaves a stop empty when there is no model for it", () => {
  const slider = localToCloudTemplate({ local: undefined, cloud: undefined }, ids("ltc"));
  assert.deepEqual(
    slider.stops.map((stop) => [stop.label, stop.model]),
    [
      ["Local", undefined],
      ["Balanced", undefined],
      ["Cloud", undefined],
    ],
  );
  assert.equal(slider.homeStopId, slider.stops[1]!.id);
});
