import assert from "node:assert/strict";
import test from "node:test";
import {
  addModelPaceSample,
  emptyModelPaceDocument,
  ModelPaceRecorder,
  type ModelPaceDocument,
} from "../services/model-pace-core.js";
import { registerModelPaceHandlers } from "./model-pace.js";

test("pace IPC returns device-local summaries and clears them", async () => {
  let stored: ModelPaceDocument = addModelPaceSample(emptyModelPaceDocument(), "openai::gpt", {
    ttftMs: 420,
    tokensPerSecond: 60,
    at: 1_700_000_000_000,
  });
  const recorder = new ModelPaceRecorder(
    {
      load: async () => structuredClone(stored),
      save: async (document) => { stored = structuredClone(document); },
      remove: async () => { stored = emptyModelPaceDocument(); },
    },
    { schedule: () => 1, cancel: () => {} },
  );
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerModelPaceHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); }, recorder });

  assert.deepEqual(await handlers.get("modelPace:summaries")!({}), {
    "openai::gpt": {
      medianTtftMs: 420,
      medianTokensPerSecond: 60,
      sampleCount: 1,
      lastSampledAt: 1_700_000_000_000,
    },
  });
  assert.equal(await handlers.get("modelPace:clear")!({}), undefined);
  assert.deepEqual(await handlers.get("modelPace:summaries")!({}), {});
  assert.deepEqual(stored.models, {});
});
