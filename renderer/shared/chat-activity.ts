import { isSafeSubagentIdentifier } from "./subagent-runs";

export interface ChatActivitySnapshot {
  revision: number;
  activeChatIds: string[];
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseChatActivitySnapshot(value: unknown): ChatActivitySnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isRevision(candidate.revision) ||
    !Array.isArray(candidate.activeChatIds) ||
    !candidate.activeChatIds.every(isSafeSubagentIdentifier)
  ) {
    return null;
  }
  return {
    revision: candidate.revision,
    activeChatIds: [...new Set(candidate.activeChatIds)],
  };
}
