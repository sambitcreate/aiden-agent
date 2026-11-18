import { useQuery } from "@tanstack/react-query";
import { aidenMcpApi } from "./ipc";
import type { AidenMcpChatProvenanceView } from "../shared/aiden-mcp";

/**
 * React Query keys for Aiden's MCP server. A credential is never cached here:
 * it lives only in the state of the sheet that shows it once.
 */
export const aidenMcpQueryKeys = {
  status: () => ["aiden-mcp", "status"] as const,
  apps: () => ["aiden-mcp", "apps"] as const,
  provenance: (chatId: string) => ["aiden-mcp", "provenance", chatId] as const,
};

/**
 * The app that started a chat, for the "Started by" label. Only this computer's
 * own chats have one. A failed read shows no label rather than an error.
 */
export function useAidenMcpChatProvenance(
  chatId: string | null | undefined,
  enabled: boolean,
): AidenMcpChatProvenanceView | null {
  const query = useQuery({
    queryKey: aidenMcpQueryKeys.provenance(chatId ?? ""),
    queryFn: async () => {
      try {
        return await aidenMcpApi.chatProvenance(chatId ?? "");
      } catch {
        return null;
      }
    },
    enabled: enabled && Boolean(chatId),
    staleTime: 60_000,
  });
  return query.data ?? null;
}
