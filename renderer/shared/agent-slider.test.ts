import assert from "node:assert/strict";
import test from "node:test";
import {
  activeStopIndex,
  normalizeAgentSlider,
  parseAgentSliderPatch,
  parseAgentSliderSettingsPatch,
  remapAgentSliderProvider,
  resolveAgentSliderStop,
  seedAgentSlider,
  type AgentSliderInventory,
  type AgentSliderSettings,
} from "./agent-slider.js";

const stop = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id.toUpperCase(), ...extra });

const slider = (stops: unknown[], homeStopId = "b"): unknown => ({ version: 1, stops, homeStopId });

function counterIds(): () => string {
  let next = 0;
  return () => `stop_${(next++).toString(16).padStart(8, "0")}`;
}

test("stored sliders drop malformed stops and keep the rest", () => {
  const normalized = normalizeAgentSlider(
    slider([
      stop("a", { providerId: "anthropic", model: "claude", thinkingLevel: "high" }),
      stop("bad id!"),
      { id: "empty-label", label: "   " },
      { id: "long-label", label: "x".repeat(25) },
      { id: "control", label: `Fast${String.fromCharCode(7)}` },
      { id: "bidi", label: `Fast${String.fromCharCode(0x202e)}` },
      stop("half", { providerId: "anthropic" }),
      stop("long-model", { providerId: "openai", model: "m".repeat(2_000) }),
      stop("b", { providerId: "openai", model: "gpt", thinkingLevel: "extreme" }),
      { id: "c", label: "  Smart  " },
    ]),
  );
  assert.deepEqual(normalized, {
    version: 1,
    stops: [
      { id: "a", label: "A", providerId: "anthropic", model: "claude", thinkingLevel: "high" },
      { id: "b", label: "B", providerId: "openai", model: "gpt" },
      { id: "c", label: "Smart" },
    ],
    homeStopId: "b",
  });
});

test("stored sliders keep the first of repeated ids, hold at most 7 stops, and need 3", () => {
  const ids = ["a", "b", "a", "c", "d", "e", "f", "g", "h"];
  const normalized = normalizeAgentSlider(slider(ids.map((id, index) => stop(id, { label: `S${index}` }))));
  assert.deepEqual(
    normalized?.stops.map((entry) => [entry.id, entry.label]),
    [["a", "S0"], ["b", "S1"], ["c", "S3"], ["d", "S4"], ["e", "S5"], ["f", "S6"], ["g", "S7"]],
  );
  assert.equal(normalizeAgentSlider(slider([stop("a"), stop("b"), stop("b")])), undefined);
  assert.equal(normalizeAgentSlider(slider([stop("a"), stop("b"), { id: "c" }])), undefined);
  assert.equal(normalizeAgentSlider({ version: 2, stops: [stop("a"), stop("b"), stop("c")], homeStopId: "a" }), undefined);
  assert.equal(normalizeAgentSlider(null), undefined);
});

test("a home stop that names no stop moves to the middle one", () => {
  assert.equal(normalizeAgentSlider(slider([stop("a"), stop("b"), stop("c")], "gone"))?.homeStopId, "b");
  assert.equal(
    normalizeAgentSlider(slider(["a", "b", "c", "d", "e"].map((id) => stop(id)), "gone"))?.homeStopId,
    "c",
  );
});

test("a slider sent for saving is refused when it has 2 or 8 stops, repeated ids, a bad stop or a stray home", () => {
  const three = [stop("a"), stop("b"), stop("c")];
  assert.deepEqual(parseAgentSliderPatch(slider(three)).stops.map((entry) => entry.id), ["a", "b", "c"]);
  assert.throws(() => parseAgentSliderPatch(slider(three.slice(0, 2))), /3 to 7 stops/u);
  assert.throws(
    () => parseAgentSliderPatch(slider(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => stop(id)))),
    /3 to 7 stops/u,
  );
  assert.throws(() => parseAgentSliderPatch(slider([stop("a"), stop("b"), stop("b")])), /share an id/u);
  assert.throws(
    () => parseAgentSliderPatch(slider([stop("a"), stop("b", { thinkingLevel: "turbo" }), stop("c")])),
    /thinking level/u,
  );
  assert.throws(
    () => parseAgentSliderPatch(slider([stop("a"), stop("b", { model: "gpt" }), stop("c")])),
    /both a provider and a model/u,
  );
  assert.throws(() => parseAgentSliderPatch(slider(three, "gone")), /home stop/u);
  assert.throws(() => parseAgentSliderPatch({ stops: three, homeStopId: "a" }), /Invalid Agent Slider/u);
});

test("remapping a provider re-homes only its stops and leaves the original slider alone", () => {
  const original = parseAgentSliderPatch(
    slider([
      stop("a", { providerId: "custom:old", model: "qwen" }),
      stop("b", { providerId: "openai", model: "gpt", thinkingLevel: "low" }),
      stop("c"),
    ]),
  );
  const remapped = remapAgentSliderProvider(original, "custom:old", "custom:new");
  assert.deepEqual(
    remapped.stops.map((entry) => entry.providerId),
    ["custom:new", "openai", undefined],
  );
  assert.equal(remapped.stops[1]?.thinkingLevel, "low");
  assert.equal(original.stops[0]?.providerId, "custom:old");
});

test("a stop resolves only when its provider is signed in and its model is present and shown", () => {
  const inventory: AgentSliderInventory = {
    providers: [
      { id: "anthropic", models: ["claude"], needsKey: true, hasKey: true },
      { id: "openai", models: ["gpt"], needsKey: true, hasKey: false },
      { id: "lmstudio", models: ["qwen", "llama"], needsKey: false },
    ],
    hiddenModelsByProvider: { lmstudio: ["llama"] },
  };
  const resolve = (extra: Record<string, unknown>) =>
    resolveAgentSliderStop({ id: "s", label: "S", ...extra }, inventory);
  assert.deepEqual(resolve({ providerId: "anthropic", model: "claude", thinkingLevel: "max" }), {
    ok: true,
    providerId: "anthropic",
    model: "claude",
    thinkingLevel: "max",
  });
  assert.deepEqual(resolve({ providerId: "lmstudio", model: "qwen" }), {
    ok: true,
    providerId: "lmstudio",
    model: "qwen",
  });
  assert.deepEqual(resolve({}), { ok: false, reason: "unassigned" });
  assert.deepEqual(resolve({ providerId: "google", model: "gemini" }), { ok: false, reason: "provider-missing" });
  assert.deepEqual(resolve({ providerId: "openai", model: "gpt" }), { ok: false, reason: "not-signed-in" });
  assert.deepEqual(resolve({ providerId: "anthropic", model: "claude-old" }), { ok: false, reason: "model-missing" });
  assert.deepEqual(resolve({ providerId: "lmstudio", model: "llama" }), { ok: false, reason: "hidden" });
});

test("the active stop matches provider, model and level; anything else is Custom", () => {
  const settings = parseAgentSliderPatch(
    slider([
      stop("a"),
      stop("b", { providerId: "openai", model: "gpt", thinkingLevel: "low" }),
      stop("c", { providerId: "openai", model: "gpt", thinkingLevel: "high" }),
      stop("d", { providerId: "lmstudio", model: "qwen" }),
      stop("e", { providerId: "openai", model: "gpt", thinkingLevel: "high" }),
    ]),
  );
  assert.equal(activeStopIndex(settings, { providerId: "openai", model: "gpt", thinkingLevel: "low" }), 1);
  assert.equal(activeStopIndex(settings, { providerId: "openai", model: "gpt", thinkingLevel: "high" }), 2, "the first match wins");
  assert.equal(activeStopIndex(settings, { providerId: "openai", model: "gpt", thinkingLevel: "medium" }), -1);
  assert.equal(activeStopIndex(settings, { providerId: "openai", model: "gpt" }), -1, "no level is not a level");
  assert.equal(activeStopIndex(settings, { providerId: "lmstudio", model: "qwen", thinkingLevel: null }), 3);
  assert.equal(activeStopIndex(settings, { providerId: "lmstudio", model: "qwen", thinkingLevel: "low" }), -1);
  assert.equal(activeStopIndex(settings, { providerId: "", model: "" }), -1, "an unassigned stop never matches");
});

test("a model with three or more levels seeds its own effort ladder with home on the current level", () => {
  const seeded = seedAgentSlider(
    { providerId: "anthropic", model: "claude", thinkingLevel: "high" },
    ["low", "medium", "high", "xhigh", "max"],
    counterIds(),
  );
  assert.deepEqual(
    seeded.stops.map((entry) => [entry.label, entry.providerId, entry.model, entry.thinkingLevel]),
    [
      ["Low", "anthropic", "claude", "low"],
      ["Medium", "anthropic", "claude", "medium"],
      ["High", "anthropic", "claude", "high"],
      ["Extra high", "anthropic", "claude", "xhigh"],
      ["Maximum", "anthropic", "claude", "max"],
    ],
  );
  assert.equal(seeded.homeStopId, seeded.stops[2]?.id);
  assert.equal(activeStopIndex(seeded, { providerId: "anthropic", model: "claude", thinkingLevel: "high" }), 2);
  assert.deepEqual(parseAgentSliderPatch(seeded), seeded, "a seed is a slider the settings patch accepts");

  const noLevel = seedAgentSlider({ providerId: "anthropic", model: "claude" }, ["off", "low", "medium", "high"], counterIds());
  assert.equal(noLevel.homeStopId, noLevel.stops[1]?.id, "without a current level home is the middle stop");
});

test("a model with fewer than three levels sits in the middle between two empty stops", () => {
  const seeded = seedAgentSlider(
    { providerId: "openai", model: "gpt", thinkingLevel: "high" },
    ["off", "high"],
    counterIds(),
  );
  assert.deepEqual(seeded, {
    version: 1,
    stops: [
      { id: "stop_00000000", label: "Fast" },
      { id: "stop_00000001", label: "Balanced", providerId: "openai", model: "gpt", thinkingLevel: "high" },
      { id: "stop_00000002", label: "Smart" },
    ],
    homeStopId: "stop_00000001",
  } satisfies AgentSliderSettings);
  const plain = seedAgentSlider({ providerId: "lmstudio", model: "qwen" }, []);
  assert.deepEqual(plain.stops.map((entry) => entry.model), [undefined, "qwen", undefined]);
  assert.equal(plain.homeStopId, plain.stops[1]?.id);
  for (const entry of plain.stops) assert.match(entry.id, /^stop_[0-9a-f]{8}$/u);
  assert.equal(new Set(plain.stops.map((entry) => entry.id)).size, 3);
});

test("settings:set takes the new-chat level, clears it with null, and refuses the slider itself", () => {
  assert.deepEqual(parseAgentSliderSettingsPatch({ lastThinkingLevel: "high" }), { lastThinkingLevel: "high" });
  const cleared = parseAgentSliderSettingsPatch({ lastThinkingLevel: null });
  assert.ok(Object.prototype.hasOwnProperty.call(cleared, "lastThinkingLevel"));
  assert.equal(cleared.lastThinkingLevel, undefined);
  assert.deepEqual(parseAgentSliderSettingsPatch({ lastModel: "gpt" }), {}, "an absent level is left alone");
  assert.throws(() => parseAgentSliderSettingsPatch({ lastThinkingLevel: "turbo" }), /Invalid thinking level/u);
  assert.throws(
    () => parseAgentSliderSettingsPatch({ agentSlider: slider([stop("a"), stop("b"), stop("c")]) }),
    /its own settings call/u,
  );
});
