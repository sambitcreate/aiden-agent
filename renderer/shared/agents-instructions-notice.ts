// An AGENTS.md that is too long never blocks a response. The host keeps the
// first part (or, past the reader's cap, none of it) and tells the user.

export interface AgentsInstructionNotice {
  scope: "global" | "workspace";
  /** "truncated": the first `limitBytes` were used. "skipped": too large to read at all. */
  kind: "truncated" | "skipped";
  sizeBytes: number;
  limitBytes: number;
  /** Changes whenever the file's contents (or, for a skipped file, its size or mtime) do. */
  fingerprint: string;
}

const kib = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function agentsInstructionNoticeMessage(notice: AgentsInstructionNotice): string {
  const file = notice.scope === "workspace" ? "This workspace's AGENTS.md" : "Your global AGENTS.md";
  return notice.kind === "truncated"
    ? `${file} is ${kib(notice.sizeBytes)}, over the ${kib(notice.limitBytes)} limit. Aiden is using the first ${kib(notice.limitBytes)}.`
    : `${file} is ${kib(notice.sizeBytes)}, too large to read. Aiden is responding without it.`;
}

export function parseAgentsInstructionNotice(value: unknown): AgentsInstructionNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const notice = value as Record<string, unknown>;
  if (
    (notice.scope !== "global" && notice.scope !== "workspace") ||
    (notice.kind !== "truncated" && notice.kind !== "skipped") ||
    !Number.isSafeInteger(notice.sizeBytes) ||
    !Number.isSafeInteger(notice.limitBytes) ||
    (notice.sizeBytes as number) < 0 ||
    (notice.limitBytes as number) < 1 ||
    typeof notice.fingerprint !== "string" ||
    !/^[0-9a-f]{16}$/u.test(notice.fingerprint)
  ) {
    return undefined;
  }
  return {
    scope: notice.scope,
    kind: notice.kind,
    sizeBytes: notice.sizeBytes as number,
    limitBytes: notice.limitBytes as number,
    fingerprint: notice.fingerprint,
  };
}

/** The full set for one response; an empty list means every AGENTS.md now fits. */
export function parseAgentsInstructionNotices(value: unknown): AgentsInstructionNotice[] | undefined {
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const notices = value.map(parseAgentsInstructionNotice);
  return notices.every((notice): notice is AgentsInstructionNotice => notice !== undefined) ? notices : undefined;
}

/**
 * Announces each chat's notices once per app session, and again after the file
 * changes. A scope that drops out (the file now fits, or was removed) is
 * forgotten, so a later oversized version is announced even if identical.
 */
export function createAgentsInstructionNoticeLog() {
  const announced = new Map<string, Map<AgentsInstructionNotice["scope"], string>>();
  return {
    /** Records the current set and returns the notices to show now. */
    update(chatId: string, notices: readonly AgentsInstructionNotice[]): AgentsInstructionNotice[] {
      const previous = announced.get(chatId) ?? new Map<AgentsInstructionNotice["scope"], string>();
      const current = new Map<AgentsInstructionNotice["scope"], string>();
      const fresh: AgentsInstructionNotice[] = [];
      for (const notice of notices) {
        const key = `${notice.kind}:${notice.fingerprint}`;
        current.set(notice.scope, key);
        if (previous.get(notice.scope) !== key) fresh.push(notice);
      }
      if (current.size) announced.set(chatId, current);
      else announced.delete(chatId);
      return fresh;
    },
  };
}
