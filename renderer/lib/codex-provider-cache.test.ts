import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  logoutCodexProvider,
  logoutBuiltinProvider,
  queryKeys,
  refreshCodexProviderState,
  subscribeCodexProviderState,
} from "./queries.js";
import type { CodexProviderSnapshot, CodexProviderStatusChanged, Provider } from "./types.js";

function snapshot(configured: boolean): CodexProviderSnapshot {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    authName: "ChatGPT",
    configured,
    needsAttention: false,
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
  queryClient.setQueryData<Provider[]>(queryKeys.providers, [
    {
      id: "openai-codex",
      kind: "openai",
      label: "ChatGPT",
      baseUrl: "https://example.invalid",
      models: [],
      needsKey: true,
      hasKey: true,
    },
  ]);
  await logoutCodexProvider(queryClient, async () => loggedOut);
  resolveStatus(snapshot(true));
  await staleRequest;

  assert.deepEqual(queryClient.getQueryData(queryKeys.codexProviderStatus), loggedOut);
  assert.equal(queryClient.getQueryData<Provider[]>(queryKeys.providers)?.[0]?.hasKey, false);
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

test("builtin provider logout uses the authoritative post-delete status without Codex state", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData<Provider[]>(queryKeys.providers, [
    {
      id: "anthropic",
      kind: "openai",
      label: "Anthropic",
      baseUrl: "",
      models: [],
      needsKey: true,
      isBuiltin: true,
      hasKey: true,
      canLogout: true,
    },
  ]);
  const calls: string[] = [];
  const result = await logoutBuiltinProvider(queryClient, "anthropic", async (providerId) => {
    calls.push(providerId);
    return { id: "anthropic", hasKey: true, canLogout: false };
  });
  assert.deepEqual(calls, ["anthropic"]);
  assert.deepEqual(result, { remainingAuthenticated: true });
  assert.equal(queryClient.getQueryData<Provider[]>(queryKeys.providers)?.[0]?.hasKey, true);
  assert.equal(queryClient.getQueryData<Provider[]>(queryKeys.providers)?.[0]?.canLogout, false);
  assert.equal(queryClient.getQueryData(queryKeys.codexProviderStatus), undefined);
  queryClient.clear();
});

test("committed logout clears removal authority when ambient auth status cannot refresh", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData<Provider[]>(queryKeys.providers, [
    {
      id: "anthropic",
      kind: "openai",
      label: "Anthropic",
      baseUrl: "",
      models: [],
      needsKey: true,
      isBuiltin: true,
      hasKey: true,
      canLogout: true,
    },
  ]);

  const result = await logoutBuiltinProvider(queryClient, "anthropic", async () => ({
    id: "anthropic",
    hasKey: null,
    canLogout: false,
  }));

  assert.deepEqual(result, { remainingAuthenticated: null });
  assert.equal(queryClient.getQueryData<Provider[]>(queryKeys.providers)?.[0]?.hasKey, true);
  assert.equal(queryClient.getQueryData<Provider[]>(queryKeys.providers)?.[0]?.canLogout, false);
  queryClient.clear();
});

test("builtin logout wins over a provider list request started before deletion", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData<Provider[]>(queryKeys.providers, [
    {
      id: "anthropic",
      kind: "openai",
      label: "Anthropic",
      baseUrl: "",
      models: [],
      needsKey: true,
      isBuiltin: true,
      hasKey: true,
      canLogout: true,
    },
  ]);
  let resolveProviders = (_providers: Provider[]): void => undefined;
  const staleRequest = queryClient
    .fetchQuery({
      queryKey: queryKeys.providers,
      queryFn: () =>
        new Promise<Provider[]>((resolve) => {
          resolveProviders = resolve;
        }),
    })
    .catch(() => undefined);

  await logoutBuiltinProvider(queryClient, "anthropic", async () => ({
    id: "anthropic",
    hasKey: false,
    canLogout: false,
  }));
  resolveProviders([
    {
      id: "anthropic",
      kind: "openai",
      label: "Anthropic",
      baseUrl: "",
      models: [],
      needsKey: true,
      isBuiltin: true,
      hasKey: true,
      canLogout: true,
    },
  ]);
  await staleRequest;

  assert.equal(queryClient.getQueryData<Provider[]>(queryKeys.providers)?.[0]?.hasKey, false);
  assert.equal(queryClient.getQueryData<Provider[]>(queryKeys.providers)?.[0]?.canLogout, false);
  queryClient.clear();
});

test("main-originated Codex health changes reconcile status and provider caches", async () => {
  const queryClient = new QueryClient();
  let notification = (_event: CodexProviderStatusChanged): void => undefined;
  let unsubscribed = false;
  const refreshes: QueryClient[] = [];
  const unsubscribe = subscribeCodexProviderState(
    queryClient,
    (handler) => {
      notification = handler;
      return () => {
        unsubscribed = true;
      };
    },
    async (client) => {
      refreshes.push(client);
    },
  );

  notification({ providerId: "openai-codex", needsAttention: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(refreshes, [queryClient]);
  unsubscribe();
  assert.equal(unsubscribed, true);
  queryClient.clear();
});
