import assert from "node:assert/strict";
import test from "node:test";
import type { HostModelCatalog } from "./host-resources";
import { resolveRemoteTurnSelection } from "./remote-turn-selection";

const catalog: HostModelCatalog = {
  providers: [
    {
      id: "acme",
      label: "Acme",
      models: [
        { id: "deep", label: "Deep", supportsImages: false, thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium", thinkingCanDisable: false, hidden: false },
        { id: "fast", label: "Fast", supportsImages: true, thinkingLevels: [], thinkingCanDisable: true, hidden: false },
        { id: "old", label: "Old", supportsImages: false, thinkingLevels: [], thinkingCanDisable: true, hidden: true },
      ],
    },
  ],
  defaults: {},
};
const deep = { providerId: "acme", modelId: "deep" };
const fast = { providerId: "acme", modelId: "fast" };

test("with no pick, the chat shows its own model and the host's default effort, and a turn sends neither", () => {
  const selection = resolveRemoteTurnSelection(catalog, deep, {});
  assert.deepEqual(selection.model, deep);
  assert.equal(selection.hostModel?.label, "Deep");
  assert.deepEqual(selection.levels, ["low", "medium", "high"]);
  assert.equal(selection.thinkingLevel, "medium");
  assert.equal(selection.canDisable, false);
  assert.deepEqual(selection.extras, {}, "the host keeps running the chat as it is");
});

test("a picked model and effort go with the next turn; picking the chat's own model sends no change", () => {
  const picked = resolveRemoteTurnSelection(catalog, fast, { model: deep, thinkingLevel: "high" });
  assert.deepEqual(picked.extras, { model: deep, thinkingLevel: "high" });
  const same = resolveRemoteTurnSelection(catalog, deep, { model: deep });
  assert.deepEqual(same.extras, {});
});

test("an effort the shown model doesn't run at is dropped, and a model without levels hides the control", () => {
  const switched = resolveRemoteTurnSelection(catalog, deep, { model: fast, thinkingLevel: "high" });
  assert.deepEqual(switched.levels, []);
  assert.equal(switched.thinkingLevel, undefined);
  assert.deepEqual(switched.extras, { model: fast });
  const unknownLevel = resolveRemoteTurnSelection(catalog, deep, { thinkingLevel: "max" });
  assert.equal(unknownLevel.thinkingLevel, "medium");
  assert.deepEqual(unknownLevel.extras, {});
});

test("a pick the host no longer lists falls back to the chat's model; a hidden model still shows for its chat", () => {
  const gone = resolveRemoteTurnSelection(catalog, deep, { model: { providerId: "acme", modelId: "removed" } });
  assert.deepEqual(gone.model, deep);
  assert.deepEqual(gone.extras, {});
  const hidden = resolveRemoteTurnSelection(catalog, { providerId: "acme", modelId: "old" }, {});
  assert.equal(hidden.hostModel?.label, "Old");
});

test("before the host's models arrive, or on a host that doesn't say the chat's model, nothing is guessed", () => {
  const loading = resolveRemoteTurnSelection(undefined, deep, { thinkingLevel: "high" });
  assert.deepEqual(loading.model, deep);
  assert.deepEqual(loading.levels, []);
  assert.deepEqual(loading.extras, {}, "an effort is never sent for a model whose levels are unknown");
  const unknownChat = resolveRemoteTurnSelection(catalog, undefined, {});
  assert.equal(unknownChat.model, undefined);
  assert.deepEqual(unknownChat.extras, {});
});
