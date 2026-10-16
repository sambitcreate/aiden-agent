// Per-workspace memory of how the last draft there chose to run: in this
// checkout or a new worktree, from which base, and whether from origin.
// A UI preference, so it lives in renderer storage and fails soft.

export type ChatDraftGitMode = "checkout" | "worktree";

export interface ChatDraftGitMemory {
  gitMode: ChatDraftGitMode;
  baseRef?: string;
  fromOrigin?: boolean;
}

export const CHAT_DRAFT_GIT_MEMORY_KEY = "aiden-agent.draftGitMemory.v1";
/** Most recently used workspaces kept. */
export const CHAT_DRAFT_GIT_MEMORY_LIMIT = 100;
const MAX_REF_LENGTH = 200;

type MemoryStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): MemoryStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function parseEntry(value: unknown): ChatDraftGitMemory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.gitMode !== "checkout" && record.gitMode !== "worktree") return undefined;
  const memory: ChatDraftGitMemory = { gitMode: record.gitMode };
  if (typeof record.baseRef === "string" && record.baseRef && record.baseRef.length <= MAX_REF_LENGTH) {
    memory.baseRef = record.baseRef;
  }
  if (typeof record.fromOrigin === "boolean") memory.fromOrigin = record.fromOrigin;
  return memory;
}

function readAll(storage: MemoryStorage | undefined): Array<[string, ChatDraftGitMemory]> {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(CHAT_DRAFT_GIT_MEMORY_KEY) ?? "null") as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: Array<[string, ChatDraftGitMemory]> = [];
    for (const item of parsed) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !item[0]) continue;
      const memory = parseEntry(item[1]);
      if (memory) entries.push([item[0], memory]);
    }
    return entries;
  } catch {
    return [];
  }
}

/** The remembered choice for a workspace; This checkout when nothing is remembered. */
export function readChatDraftGitMemory(
  workspaceId: string,
  storage: MemoryStorage | undefined = defaultStorage(),
): ChatDraftGitMemory {
  const entry = readAll(storage).find(([id]) => id === workspaceId);
  return entry ? { ...entry[1] } : { gitMode: "checkout" };
}

/** Remember a workspace's choice, keeping the most recent workspaces only. */
export function rememberChatDraftGitMemory(
  workspaceId: string,
  memory: ChatDraftGitMemory,
  storage: MemoryStorage | undefined = defaultStorage(),
): void {
  if (!storage || !workspaceId) return;
  const entry = parseEntry(memory);
  if (!entry) return;
  const entries = readAll(storage).filter(([id]) => id !== workspaceId);
  entries.unshift([workspaceId, entry]);
  try {
    storage.setItem(
      CHAT_DRAFT_GIT_MEMORY_KEY,
      JSON.stringify(entries.slice(0, CHAT_DRAFT_GIT_MEMORY_LIMIT)),
    );
  } catch {
    // Sending still works when browser storage is unavailable.
  }
}

/** What the branch menu knows about the repository (`git:branches`). */
export interface DraftWorktreeRepositoryState {
  branches: readonly string[];
  remoteBranches?: readonly string[];
  current?: string;
  defaultBranch?: string;
  hasRemote?: boolean;
  unborn?: boolean;
}

/**
 * New-worktree defaults for a draft: the remembered base while it still
 * exists, else the repository's default branch, else the current branch.
 * From origin defaults to on when a remote exists. Undefined when the
 * repository has no commit to start from.
 */
export function resolveDraftWorktreeDefaults(
  memory: ChatDraftGitMemory,
  repository: DraftWorktreeRepositoryState,
): { baseRef: string; fromOrigin: boolean } | undefined {
  if (repository.unborn) return undefined;
  const exists = (ref: string | undefined): ref is string =>
    ref !== undefined && (repository.branches.includes(ref) || (repository.remoteBranches ?? []).includes(ref));
  const baseRef = [memory.baseRef, repository.defaultBranch, repository.current, repository.branches[0]]
    .find(exists);
  if (!baseRef) return undefined;
  const hasRemote = repository.hasRemote ?? (repository.remoteBranches?.length ?? 0) > 0;
  return { baseRef, fromOrigin: hasRemote && (memory.fromOrigin ?? true) };
}
