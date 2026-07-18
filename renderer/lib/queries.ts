// React Query hooks for providers, chats, and settings.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatsApi, exaApi, gitApi, localVoiceApi, mcpApi, modelsApi, providersApi, settingsApi, skillsApi, workspacesApi } from "./ipc";
import type { Provider } from "./types";

export const queryKeys = {
  providers: ["providers"] as const,
  chats: ["chats"] as const,
  chatsIn: (workspaceId: string | undefined) => ["chats", workspaceId ?? "all"] as const,
  chat: (id: string) => ["chat", id] as const,
  settings: ["settings"] as const,
  skills: ["skills"] as const,
  mcpServers: ["mcpServers"] as const,
  exa: ["exa"] as const,
  engineStatus: ["engineStatus"] as const,
  localModels: ["localModels"] as const,
  workspaces: ["workspaces"] as const,
  git: (folderPath: string | undefined) => ["git", folderPath ?? "none"] as const,
  gitBranches: (folderPath: string | undefined) => ["gitBranches", folderPath ?? "none"] as const,
  discoveredSkills: (folderPath: string | undefined) => ["discoveredSkills", folderPath ?? "none"] as const,
  modelInfo: (providerId: string | undefined) => ["modelInfo", providerId ?? "none"] as const,
};

export function useProviders() {
  return useQuery({ queryKey: queryKeys.providers, queryFn: providersApi.list });
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

/** models.dev capability info for a provider's models, keyed by model id. */
export function useModelInfo(providerId: string | undefined, modelIds: string[]) {
  const key = [...modelIds].sort().join(",");
  return useQuery({
    queryKey: [...queryKeys.modelInfo(providerId), key],
    queryFn: () => modelsApi.info(providerId as string, modelIds),
    enabled: Boolean(providerId) && modelIds.length > 0,
    staleTime: 60 * 60 * 1000,
  });
}

export function useGitInfo(folderPath: string | undefined) {
  return useQuery({
    queryKey: queryKeys.git(folderPath),
    queryFn: () => workspacesApi.gitInfo(folderPath as string),
    enabled: Boolean(folderPath),
    staleTime: 15_000,
  });
}

export function useGitBranches(folderPath: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.gitBranches(folderPath),
    queryFn: () => gitApi.branches(folderPath as string),
    enabled: Boolean(folderPath) && enabled,
    staleTime: 10_000,
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
