import assert from "node:assert/strict";
import test from "node:test";
import { runArtificialAnalysisAction } from "./artificial-analysis-action-core.js";
import {
  ArtificialAnalysisFetchError,
  ArtificialAnalysisInputError,
  ArtificialAnalysisStateError,
  type ArtificialAnalysisStatus,
} from "./artificial-analysis-runtime-core.js";

const ready: ArtificialAnalysisStatus = {
  state: "ready",
  hasKey: true,
  cleanupNeeded: false,
  ready: true,
  cachedModelCount: 3,
  rankedModelCount: 2,
};

test("returns successful status as a plain IPC-safe value", async () => {
  assert.deepEqual(
    await runArtificialAnalysisAction(async () => ready, { fallbackMessage: "fallback" }),
    { ok: true, status: ready },
  );
});

test("preserves stable input, state, and fetch error codes across IPC", async () => {
  const errors = [
    new ArtificialAnalysisInputError("bad input"),
    new ArtificialAnalysisStateError("not connected"),
    new ArtificialAnalysisFetchError("rate_limited", "quota reached"),
  ];
  for (const error of errors) {
    const result = await runArtificialAnalysisAction(
      async () => {
        throw error;
      },
      { fallbackMessage: "fallback" },
    );
    assert.deepEqual(result, { ok: false, code: error.code, message: error.message });
  }
});

test("hides unexpected local error details while retaining a diagnostic hook", async () => {
  const unexpected = new Error("/Users/private/path and secret");
  const observed: unknown[] = [];
  const result = await runArtificialAnalysisAction(
    async () => {
      throw unexpected;
    },
    {
      fallbackMessage: "Aiden could not save model data.",
      onUnexpected: (error) => observed.push(error),
    },
  );
  assert.deepEqual(result, {
    ok: false,
    code: "local_error",
    message: "Aiden could not save model data.",
  });
  assert.deepEqual(observed, [unexpected]);
});

test("does not let a diagnostic callback break the IPC-safe fallback", async () => {
  const result = await runArtificialAnalysisAction(
    async () => {
      throw new Error("disk failure");
    },
    {
      fallbackMessage: "Could not save.",
      onUnexpected: () => {
        throw new Error("logger failure");
      },
    },
  );
  assert.deepEqual(result, { ok: false, code: "local_error", message: "Could not save." });
});
