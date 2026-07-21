// React Query hooks for providers, chats, and settings.

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  chatsApi,
  exaApi,
  gitApi,
  localVoiceApi,
  mcpApi,
  modelsApi,
  profileApi,
  providersApi,
  settingsApi,
  skillsApi,
  titleProvidersApi,
  usageApi,
  workspacesApi,
} from "./ipc";
import type {
  CodexProviderSnapshot,
  CodexProviderStatusChanged,
  ModelInfo,
  Provider,
  UsageDateRange,
} from "./types";

export const queryKeys = {
  providers: ["providers"] as const,
  chats: ["chats"] as const,
  chatsIn: (workspaceId: string | undefined) => ["chats", workspaceId ?? "all"] as const,
  chat: (id: string) => ["chat", id] as const,
  settings: ["settings"] as const,
  codexProviderStatus: ["codexProviderStatus", "openai-codex"] as const,
  profile: ["profile"] as const,
  usage: (range: UsageDateRange) => ["usage", range] as const,
  foundationModelsConnection: ["foundationModelsConnection"] as const,
  skills: ["skills"] as const,
  mcpServers: ["mcpServers"] as const,
  exa: ["exa"] as const,
  engineStatus: ["engineStatus"] as const,
  localModels: ["localModels"] as const,
  workspaces: ["workspaces"] as const,
  git: (workspaceId: string | undefined) => ["git", workspaceId ?? "none"] as const,
  gitReview: (workspaceId: string | undefined) => ["git-review", workspaceId ?? "none"] as const,
  gitPushCapability: (workspaceId: string | undefined) =>
    ["git-push-capability", workspaceId ?? "none"] as const,
  gitComparisons: (workspaceId: string | undefined) =>
    ["git-comparison", workspaceId ?? "none"] as const,
  gitComparison: (workspaceId: string | undefined, targetRef: string | undefined) =>
    [...queryKeys.gitComparisons(workspaceId), targetRef ?? "none"] as const,
  gitBranches: (workspaceId: string | undefined) => ["gitBranches", workspaceId ?? "none"] as const,
  gitWorktrees: (workspaceId: string | undefined) =>
    ["gitWorktrees", workspaceId ?? "none"] as const,
  discoveredSkills: (folderPath: string | undefined) =>
    ["discoveredSkills", folderPath ?? "none"] as const,
  modelInfo: (providerId: string | undefined) => ["modelInfo", providerId ?? "none"] as const,
};

export function useProviders() {
  return useQuery({ queryKey: queryKeys.providers, queryFn: providersApi.list });
}

export function useCodexProviderStatus() {
  return useQuery({
    queryKey: queryKeys.codexProviderStatus,
    queryFn: () => providersApi.authStatus("openai-codex"),
    retry: false,
    refetchOnWindowFocus: true,
  });
}

async function cancelCodexProviderReads(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queryKeys.codexProviderStatus }),
    queryClient.cancelQueries({ queryKey: queryKeys.providers }),
  ]);
}

/** Cancel stale pre-auth reads before asking active observers for authoritative state. */
export async function refreshCodexProviderState(queryClient: QueryClient): Promise<void> {
  await cancelCodexProviderReads(queryClient);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.codexProviderStatus }),
    queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
  ]);
}

/** Reconcile both caches when any main-process request discovers new Codex auth health. */
export function subscribeCodexProviderState(
  queryClient: QueryClient,
  subscribe: (
    handler: (event: CodexProviderStatusChanged) => void,
  ) => () => void = providersApi.onAuthStatusChanged,
  refresh: (queryClient: QueryClient) => Promise<void> = refreshCodexProviderState,
): () => void {
  return subscribe((event) => {
    if (event.providerId !== "openai-codex") return;
    void refresh(queryClient);
  });
}

export async function logoutCodexProvider(
  queryClient: QueryClient,
  logout: (providerId: "openai-codex") => Promise<CodexProviderSnapshot> = providersApi.logout,
): Promise<CodexProviderSnapshot> {
  await cancelCodexProviderReads(queryClient);
  const next = await logout("openai-codex");
  await cancelCodexProviderReads(queryClient);
  queryClient.setQueryData(queryKeys.codexProviderStatus, next);
  await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
  return next;
}

export function useChats(workspaceId?: string) {
  return useQuery({
    queryKey: queryKeys.chatsIn(workspaceId),
    queryFn: () => chatsApi.list(workspaceId),
  });
}

export function useWorkspaces() {
  return useQuery({ queryKey: queryKeys.workspaces, queryFn: workspacesApi.list });
}

/** Release-bundled capability info for a provider's models, keyed by model id. */
function modelMetadataKey(provider: Provider | undefined): string {
  if (!provider?.modelMetadata) return "";
  return JSON.stringify(
    Object.entries(provider.modelMetadata).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function useModelInfo(
  providerId: string | undefined,
  modelIds: string[],
  provider?: Provider,
) {
  const key = [...modelIds].sort().join(",");
  return useQuery({
    queryKey: [...queryKeys.modelInfo(providerId), key, modelMetadataKey(provider)],
    queryFn: () => modelsApi.info(providerId as string, modelIds),
    enabled: Boolean(providerId) && modelIds.length > 0,
    staleTime: 60 * 60 * 1000,
  });
}

/** Resolve release-bundled display and capability metadata for every picker connection. */
export function useProvidersModelInfo(providers: Provider[]) {
  const results = useQueries({
    queries: providers.map((provider) => {
      const key = [...provider.models].sort().join(",");
      return {
        queryKey: [...queryKeys.modelInfo(provider.id), key, modelMetadataKey(provider)],
        queryFn: () => modelsApi.info(provider.id, provider.models),
        enabled: provider.models.length > 0,
        staleTime: 60 * 60 * 1000,
      };
    }),
  });
  const data: Record<string, Record<string, ModelInfo>> = {};
  providers.forEach((provider, index) => {
    data[provider.id] = results[index]?.data ?? {};
  });
  return {
    data,
    isLoading: results.some((result) => result.isLoading),
  };
}

export function useGitInfo(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.git(workspaceId),
    queryFn: () => workspacesApi.gitInfo(workspaceId as string),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
    staleTime: 1_000,
  });
}

export function useGitReview(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.gitReview(workspaceId),
    queryFn: () => gitApi.review(workspaceId as string),
    enabled: Boolean(workspaceId) && enabled,
    refetchInterval: enabled ? 4_000 : false,
    staleTime: 1_000,
  });
}

export function useGitPushCapability(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.gitPushCapability(workspaceId),
    queryFn: () => gitApi.pushCapability(workspaceId as string),
    enabled: Boolean(workspaceId) && enabled,
    refetchInterval: enabled ? 5_000 : false,
    staleTime: 1_000,
  });
}

export function useGitComparison(
  workspaceId: string | undefined,
  targetRef: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.gitComparison(workspaceId, targetRef),
    queryFn: () => gitApi.compare(workspaceId as string, targetRef as string),
    enabled: Boolean(workspaceId) && Boolean(targetRef) && enabled,
    refetchInterval: enabled ? 5_000 : false,
    staleTime: 1_000,
  });
}

export function useGitWorktrees(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.gitWorktrees(workspaceId),
    queryFn: () => gitApi.worktrees(workspaceId as string),
    enabled: Boolean(workspaceId) && enabled,
    staleTime: 1_000,
  });
}

export function useGitBranches(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.gitBranches(workspaceId),
    queryFn: () => gitApi.branches(workspaceId as string),
    enabled: Boolean(workspaceId) && enabled,
    staleTime: 1_000,
  });
}

export function useDiscoveredSkills(folderPath: string | undefined) {
  return useQuery({
    queryKey: queryKeys.discoveredSkills(folderPath),
    queryFn: () => skillsApi.discovered(folderPath),
    staleTime: 30_000,
  });
}

export function useChat(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.chat(id) : ["chat", "none"],
    queryFn: () => (id ? chatsApi.get(id) : Promise.resolve(null)),
    enabled: Boolean(id),
  });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: settingsApi.get });
}

export function useProfile() {
  return useQuery({ queryKey: queryKeys.profile, queryFn: profileApi.get });
}

export function useUsageSummary(range: UsageDateRange) {
  return useQuery({
    queryKey: queryKeys.usage(range),
    queryFn: () => usageApi.summary(range),
  });
}

export function useFoundationModelsConnection() {
  return useQuery({
    queryKey: queryKeys.foundationModelsConnection,
    queryFn: titleProvidersApi.status,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.state === "model_preparing" ? 5_000 : false),
  });
}

export function useSkills() {
  return useQuery({ queryKey: queryKeys.skills, queryFn: skillsApi.list });
}

export function useMcpServers() {
  return useQuery({ queryKey: queryKeys.mcpServers, queryFn: mcpApi.list });
}

export function useExaConfig() {
  return useQuery({ queryKey: queryKeys.exa, queryFn: exaApi.get });
}

export function useEngineStatus(enabled = true) {
  return useQuery({ queryKey: queryKeys.engineStatus, queryFn: localVoiceApi.status, enabled });
}

export function useLocalModels(enabled = true) {
  return useQuery({ queryKey: queryKeys.localModels, queryFn: localVoiceApi.listModels, enabled });
}

export function useSaveProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: Omit<Provider, "hasKey">) => providersApi.save(provider),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

export function useRemoveProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => providersApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}

export function useSetProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, key }: { id: string; key: string }) => providersApi.setKey(id, key),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.providers }),
  });
}
