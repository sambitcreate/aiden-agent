// An AGENTS.md that is too long never blocks a response. The host keeps the
// first part (or, past the reader's cap, none of it) and tells the user.

export interface AgentsInstructionNotice {
  scope: "global" | "workspace";
  /** "truncated": the first `limitBytes` were used. "skipped": too large to read at all. */
  kind: "truncated" | "skipped";
  sizeBytes: number;
  limitBytes: number;
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
    (notice.limitBytes as number) < 1
  ) {
    return undefined;
  }
  return {
    scope: notice.scope,
    kind: notice.kind,
    sizeBytes: notice.sizeBytes as number,
    limitBytes: notice.limitBytes as number,
  };
}

/** Announces a chat's notice once per app session, and again only after it changes. */
export function createAgentsInstructionNoticeLog() {
  const announced = new Map<string, string>();
  return {
    shouldAnnounce(chatId: string, notice: AgentsInstructionNotice): boolean {
      const key = `${notice.scope}:${notice.kind}:${notice.sizeBytes}:${notice.limitBytes}`;
      if (announced.get(`${chatId}\u0000${notice.scope}`) === key) return false;
      announced.set(`${chatId}\u0000${notice.scope}`, key);
      return true;
    },
  };
}
