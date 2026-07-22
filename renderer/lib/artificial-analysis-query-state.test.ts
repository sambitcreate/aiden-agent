import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  beginArtificialAnalysisAction,
  commitArtificialAnalysisState,
  queryKeys,
  refreshArtificialAnalysisState,
} from "./queries.js";
import type { ArtificialAnalysisStatus } from "./types.js";

function status(
  patch: Partial<ArtificialAnalysisStatus> = {},
): ArtificialAnalysisStatus {
  return {
    state: "not_connected",
    hasKey: false,
    cleanupNeeded: false,
    ready: false,
    cachedModelCount: 0,
    rankedModelCount: 0,
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true, "Timed out waiting for query activity");
}

test("an action result wins over stale status and model-info reads", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const staleStatus = deferred<ArtificialAnalysisStatus>();
  const modelRequests: Array<ReturnType<typeof deferred<Record<string, string>>>> = [];

  const statusObserver = new QueryObserver(queryClient, {
    queryKey: queryKeys.artificialAnalysisStatus,
    queryFn: () => staleStatus.promise,
  });
  const modelObserver = new QueryObserver(queryClient, {
    queryKey: queryKeys.modelInfo("openrouter"),
    queryFn: () => {
      const request = deferred<Record<string, string>>();
      modelRequests.push(request);
      return request.promise;
    },
  });
  const unsubscribeStatus = statusObserver.subscribe(() => undefined);
  const unsubscribeModel = modelObserver.subscribe(() => undefined);
  await waitFor(() => modelRequests.length === 1);

  await beginArtificialAnalysisAction(queryClient);
  const authoritative = status({
    state: "ready",
    hasKey: true,
    ready: true,
    cachedModelCount: 12,
    rankedModelCount: 10,
  });
  const commit = commitArtificialAnalysisState(queryClient, authoritative);
  await waitFor(() => modelRequests.length === 2);

  staleStatus.resolve(status());
  modelRequests[0].resolve({ source: "stale" });
  modelRequests[1].resolve({ source: "current" });
  await commit;

  assert.deepEqual(queryClient.getQueryData(queryKeys.artificialAnalysisStatus), authoritative);
  assert.deepEqual(queryClient.getQueryData(queryKeys.modelInfo("openrouter")), {
    source: "current",
  });
  unsubscribeStatus();
  unsubscribeModel();
  queryClient.clear();
});

test("failed actions can reconcile authoritative local status and refresh model info", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const ready = status({
    state: "ready",
    hasKey: true,
    ready: true,
    cachedModelCount: 4,
    rankedModelCount: 3,
  });
  queryClient.setQueryData(queryKeys.artificialAnalysisStatus, ready);
  queryClient.setQueryData(queryKeys.modelInfo("openrouter"), { source: "before" });
  let modelReads = 0;
  const modelObserver = new QueryObserver(queryClient, {
    queryKey: queryKeys.modelInfo("openrouter"),
    queryFn: async () => {
      modelReads += 1;
      return { source: "after" };
    },
  });
  const unsubscribeModel = modelObserver.subscribe(() => undefined);

  const disconnected = status();
  assert.deepEqual(
    await refreshArtificialAnalysisState(queryClient, async () => disconnected),
    disconnected,
  );

  assert.deepEqual(queryClient.getQueryData(queryKeys.artificialAnalysisStatus), disconnected);
  assert.deepEqual(queryClient.getQueryData(queryKeys.modelInfo("openrouter")), {
    source: "after",
  });
  assert.equal(modelReads, 1);
  unsubscribeModel();
  queryClient.clear();
});
