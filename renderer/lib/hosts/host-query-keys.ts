/**
 * React Query keys for paired hosts. Host-scoped data lives under
 * `["host", hostId, …]`, parallel to the local keys, which stay unchanged.
 * Host-agnostic lists use `["hosts", …]` so no host ID can ever shadow them.
 */
export const hostQueryKeys = {
  /** Paired hosts from the registry. Reading it never starts supervision. */
  list: () => ["hosts", "list"] as const,
  /** Supervisor status for every paired host. */
  statuses: () => ["hosts", "statuses"] as const,
  /** Everything cached for one host. */
  host: (hostId: string) => ["host", hostId] as const,
  /** One host's last-known feed rows. */
  feed: (hostId: string) => ["host", hostId, "feed"] as const,
  /** Everything cached for one chat on one host. */
  chat: (hostId: string, chatId: string) => ["host", hostId, "chat", chatId] as const,
  /** The open remote chat's paged transcript (newest window plus older pages). */
  messagesWindow: (hostId: string, chatId: string) =>
    ["host", hostId, "chat", chatId, "messages"] as const,
  /** A forked chat's lineage with its summary, which feed rows leave out. */
  forkLineage: (hostId: string, chatId: string) => ["host", hostId, "chat", chatId, "fork-lineage"] as const,
  /** The skills one chat on one host may invoke. */
  skills: (hostId: string, chatId: string) => ["host", hostId, "chat", chatId, "skills"] as const,
  /** The models a host offers for new chats. */
  models: (hostId: string) => ["host", hostId, "models"] as const,
  /** The folders a host lets this Mac browse: its roots, or one page of a folder. */
  browser: (hostId: string, location?: string, cursor?: string) =>
    location ? (["host", hostId, "browser", location, cursor ?? ""] as const) : (["host", hostId, "browser"] as const),
};
