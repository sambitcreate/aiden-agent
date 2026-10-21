// Legacy HTTP+SSE MCP servers are no longer supported. Pre-1.0 there is no
// migration: saved entries are dropped so the rest of a server list stays
// valid, and their stored credentials are cleaned up. Shared by the desktop
// config store and the CLI (no dependencies).

/** A saved server entry with the retired `"sse"` transport. */
export function isRetiredMcpServerEntry(entry: unknown): boolean {
  return Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { transport?: unknown }).transport === "sse");
}

/** The list without retired entries; anything that is not an array is returned as is. */
export function withoutRetiredMcpServers<T>(value: T): T {
  return (Array.isArray(value) ? value.filter((entry) => !isRetiredMcpServerEntry(entry)) : value) as T;
}

/** Ids of saved legacy SSE servers, whose stored credentials still need cleanup. */
export function retiredMcpServerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = isRetiredMcpServerEntry(entry) ? (entry as { id?: unknown }).id : undefined;
    return typeof id === "string" && id ? [id] : [];
  });
}
