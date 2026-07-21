import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { logoutCodexProvider, queryKeys, refreshCodexProviderState } from "./queries.js";
import type { CodexProviderSnapshot } from "./types.js";

function snapshot(configured: boolean): CodexProviderSnapshot {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    authName: "ChatGPT",
    configured,
    models: [],
  };
}

test("logout keeps its returned snapshot authoritative over a stale status request", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let resolveStatus = (_value: CodexProviderSnapshot): void => undefined;
  const staleRequest = queryClient
    .fetchQuery({
      queryKey: queryKeys.codexProviderStatus,
      queryFn: () =>
        new Promise<CodexProviderSnapshot>((resolve) => {
          resolveStatus = resolve;
        }),
    })
    .catch(() => undefined);

  const loggedOut = snapshot(false);
  await logoutCodexProvider(queryClient, async () => loggedOut);
  resolveStatus(snapshot(true));
  await staleRequest;

  assert.deepEqual(queryClient.getQueryData(queryKeys.codexProviderStatus), loggedOut);
  queryClient.clear();
});

test("terminal refresh replaces a data-less pending status read", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const pending: Array<(value: CodexProviderSnapshot) => void> = [];
  let calls = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: queryKeys.codexProviderStatus,
    queryFn: () => {
      calls += 1;
      return new Promise<CodexProviderSnapshot>((resolve) => pending.push(resolve));
    },
  });
  const unsubscribe = observer.subscribe(() => undefined);

  while (calls < 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const refresh = refreshCodexProviderState(queryClient);
  while (calls < 2) await new Promise<void>((resolve) => setImmediate(resolve));

  pending[0](snapshot(false));
  pending[1](snapshot(true));
  await refresh;

  assert.deepEqual(queryClient.getQueryData(queryKeys.codexProviderStatus), snapshot(true));
  unsubscribe();
  queryClient.clear();
});
