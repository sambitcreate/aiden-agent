import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryObserver } from "@tanstack/react-query";

import type { ModelPaceSummary } from "../shared/model-pace.js";
import { clearModelPaceSummaries, queryKeys } from "./queries.js";

test("clearing measured speeds removes them from every mounted Pad read", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let stored: Record<string, ModelPaceSummary> = {
    "openai::gpt": { medianTtftMs: 400, medianTokensPerSecond: 55, sampleCount: 3, lastSampledAt: 1 },
  };
  const observer = new QueryObserver(queryClient, {
    queryKey: queryKeys.modelPaceSummaries,
    queryFn: async () => structuredClone(stored),
  });
  const seen: Array<Record<string, ModelPaceSummary> | undefined> = [];
  const unsubscribe = observer.subscribe((result) => seen.push(result.data));
  await queryClient.fetchQuery({ queryKey: queryKeys.modelPaceSummaries, queryFn: async () => structuredClone(stored) });
  assert.equal(Object.keys(observer.getCurrentResult().data ?? {}).length, 1);

  let cleared = 0;
  await clearModelPaceSummaries(queryClient, async () => {
    cleared += 1;
    stored = {};
  });

  assert.equal(cleared, 1);
  assert.deepEqual(observer.getCurrentResult().data, {});
  assert.deepEqual(seen[seen.length - 1], {});
  unsubscribe();
  queryClient.clear();
});

test("a failed clear leaves the measured speeds visible and reports the failure", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const summaries = {
    "openai::gpt": { medianTtftMs: 400, medianTokensPerSecond: 55, sampleCount: 3, lastSampledAt: 1 },
  };
  queryClient.setQueryData(queryKeys.modelPaceSummaries, summaries);
  await assert.rejects(
    clearModelPaceSummaries(queryClient, async () => {
      throw new Error("locked");
    }),
    /locked/u,
  );
  assert.deepEqual(queryClient.getQueryData(queryKeys.modelPaceSummaries), summaries);
  queryClient.clear();
});
