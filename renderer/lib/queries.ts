// React Query hooks for providers, chats, and settings.

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  assistantApi,
  chatsApi,
  artificialAnalysisApi,
  computerUseApi,
  exaApi,
  gitApi,
  localVoiceApi,
  mcpApi,
  modelsApi,
  profileApi,
  providersApi,
  scheduleApi,
  settingsApi,
  shortcutApi,
  skillsApi,
  titleProvidersApi,
  usageApi,
  workspacesApi,
} from "./ipc";
import type {
  ArtificialAnalysisStatus,
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
  shortcuts: ["shortcuts"] as const,
  assistantConfig: ["assistantConfig"] as const,
  scheduledTasks: ["scheduledTasks"] as const,
  scheduledRuns: (taskId: string | undefined) => ["scheduledRuns", taskId ?? "none"] as const,
  scheduledSettings: ["scheduledSettings"] as const,
  computerUseStatus: ["computerUseStatus"] as const,
  artificialAnalysisStatus: ["artificialAnalysisStatus"] as const,
  artificialAnalysisModelInfo: ["modelInfo"] as const,
  codexProviderStatus: ["codexProviderStatus", "openai-codex"] as const,
  profile: ["profile"] as const,
  usage: (range: UsageDateRange) => ["usage", range] as const,
  foundationModelsConnection: ["foundationModelsConnection"] as const,
  skills: ["skills"] as const,
  mcpServers: ["mcpServers"] as const,
  mcpPresets: ["mcpPresets"] as const,
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
  skillCatalog: (workspaceId: string | undefined) =>
    ["skillCatalog", workspaceId ?? "none"] as const,
  modelInfo: (providerId: string | undefined) => ["modelInfo", providerId ?? "none"] as const,
};

async function cancelArtificialAnalysisReads(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queryKeys.artificialAnalysisStatus }),
    queryClient.cancelQueries({ queryKey: queryKeys.artificialAnalysisModelInfo }),
  ]);
}

/** Freeze device-local AA reads before a connect, refresh, or disconnect mutation. */
export async function beginArtificialAnalysisAction(queryClient: QueryClient): Promise<void> {
  await cancelArtificialAnalysisReads(queryClient);
}

/** Make an action result authoritative without retaining rankings from a prior credential. */
export async function commitArtificialAnalysisState(
  queryClient: QueryClient,
  status: ArtificialAnalysisStatus,
): Promise<void> {
  await cancelArtificialAnalysisReads(queryClient);
  queryClient.removeQueries({
    queryKey: queryKeys.artificialAnalysisModelInfo,
    type: "inactive",
  });
  queryClient.setQueryData(queryKeys.artificialAnalysisStatus, status);
  await queryClient.resetQueries({
    queryKey: queryKeys.artificialAnalysisModelInfo,
    type: "active",
  });
}

/** Re-read only local credential/cache state after a failed or partially applied mutation. */
export async function refreshArtificialAnalysisState(
  queryClient: QueryClient,
  readStatus: () => Promise<ArtificialAnalysisStatus> = artificialAnalysisApi.status,
): Promise<ArtificialAnalysisStatus> {
  await cancelArtificialAnalysisReads(queryClient);
  try {
    const status = await readStatus();
    await commitArtificialAnalysisState(queryClient, status);
    return status;
  } catch (error) {
    await cancelArtificialAnalysisReads(queryClient);
    queryClient.removeQueries({ queryKey: queryKeys.artificialAnalysisModelInfo });
    await queryClient.invalidateQueries({ queryKey: queryKeys.artificialAnalysisStatus });
    throw error;
  }
}

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
  logout: (providerId: "openai-codex") => Promise<CodexProviderSnapshot> = (providerId) =>
    providersApi.logout(providerId) as Promise<CodexProviderSnapshot>,
): Promise<CodexProviderSnapshot> {
  await cancelCodexProviderReads(queryClient);
  const next = await logout("openai-codex");
  await cancelCodexProviderReads(queryClient);
  queryClient.setQueryData(queryKeys.codexProviderStatus, next);
  queryClient.setQueryData<Provider[]>(queryKeys.providers, (current) =>
    current?.map((provider) =>
      provider.id === "openai-codex" ? { ...provider, hasKey: false, canLogout: false } : provider,
    ),
  );
  await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
  return next;
}

export async function logoutBuiltinProvider(
  queryClient: QueryClient,
  providerId: string,
  logout: (providerId: string) => Promise<unknown> = providersApi.logout,
): Promise<{ remainingAuthenticated: boolean | null }> {
  if (providerId === "openai-codex") {
    const next = await logoutCodexProvider(
      queryClient,
      (codexId) => logout(codexId) as Promise<CodexProviderSnapshot>,
    );
    return { remainingAuthenticated: next.configured };
  }
  await queryClient.cancelQueries({ queryKey: queryKeys.providers });
  const result = await logout(providerId);
  if (
    !result ||
    typeof result !== "object" ||
    (result as { id?: unknown }).id !== providerId ||
    !(
      typeof (result as { hasKey?: unknown }).hasKey === "boolean" ||
      (result as { hasKey?: unknown }).hasKey === null
    ) ||
    (result as { canLogout?: unknown }).canLogout !== false
  ) {
    throw new Error("Provider sign-out returned an invalid status.");
  }
  const remainingAuthenticated = (result as { hasKey: boolean | null }).hasKey;
  await queryClient.cancelQueries({ queryKey: queryKeys.providers });
  queryClient.setQueryData<Provider[]>(queryKeys.providers, (current) =>
    current?.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            hasKey: remainingAuthenticated ?? provider.hasKey,
            canLogout: false,
          }
        : provider,
    ),
  );
  await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
  return { remainingAuthenticated };
}

export function useChats(workspaceId?: string) {
  return useQuery({
    queryKey: queryKeys.chatsIn(workspaceId),
    queryFn: () => chatsApi.list(workspaceId),
    // An unscoped list returns every chat in every workspace, including the
    // reserved assistant workspace whose threads belong to the Aiden dock. The
    // sidebar renders whatever this resolves to, and `workspaceId` is briefly
    // undefined while workspaces load, so wait for a concrete id instead.
    enabled: Boolean(workspaceId),
  });
}

export function useWorkspaces() {
  return useQuery({ queryKey: queryKeys.workspaces, queryFn: workspacesApi.list });
}

/** Offline capability info for a provider's models, keyed by model id. */
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

/** Resolve offline display and capability metadata for every picker connection. */
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

export function useDiscoveredSkills(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.skillCatalog(workspaceId),
    queryFn: () => skillsApi.catalog(workspaceId as string),
    enabled: Boolean(workspaceId),
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

export function useShortcuts() {
  return useQuery({ queryKey: queryKeys.shortcuts, queryFn: shortcutApi.get });
}

export function useAssistantConfig() {
  return useQuery({
    queryKey: queryKeys.assistantConfig,
    queryFn: assistantApi.config,
    retry: false,
  });
}

export function useScheduledTasks() {
  return useQuery({ queryKey: queryKeys.scheduledTasks, queryFn: scheduleApi.list });
}

export function useScheduledRuns(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.scheduledRuns(taskId),
    queryFn: () => scheduleApi.runs(taskId as string),
    enabled: Boolean(taskId),
  });
}

export function useScheduledTaskSettings() {
  return useQuery({ queryKey: queryKeys.scheduledSettings, queryFn: () => scheduleApi.settings() });
}

/** Reads only device-local credential/cache state; this query never fetches catalog data. */
export function useArtificialAnalysisStatus() {
  return useQuery({
    queryKey: queryKeys.artificialAnalysisStatus,
    queryFn: artificialAnalysisApi.status,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

export function useComputerUseStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.computerUseStatus,
    queryFn: () => computerUseApi.status(),
    enabled,
    retry: false,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
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

export function useMcpPresets() {
  return useQuery({ queryKey: queryKeys.mcpPresets, queryFn: mcpApi.presets });
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
