import { createHmac, randomBytes } from "node:crypto";
import type { SubagentRunSnapshot } from "../../renderer/shared/subagent-runs.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

export const AIDEN_REMOTE_SUBAGENTS_FEATURE = "workspace-subagents-v1";
export const MAX_REMOTE_RUNS = 100;

export interface RemoteSubagentSummary {
  id: string;
  label: string;
  role: "scout" | "planner" | "reviewer";
  state:
    | "queued"
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "timed_out"
    | "interrupted"
    | "needs_attention"
    | "stopped"
    | "unknown";
  revision: number;
  startedAt: number;
  updatedAt: number;
}

export interface RemoteSubagentPage {
  version: 1;
  workspaceId: string;
  chatId: string;
  runs: RemoteSubagentSummary[];
  truncated: boolean;
}

/** Foreground Mac opt-in, deliberately not persisted or added to pairing defaults. */
export class RemoteSubagentGrants {
  private readonly grants = new Map<string, Buffer>();
  private accepting = true;
  setEnabled(enabled: boolean): void {
    this.accepting = enabled;
    if (!enabled) this.clear();
  }
  set(deviceId: string, allowed: boolean): void {
    if (allowed) {
      if (!this.accepting)
        throw new Error("Remote Access is disabled or stopping.");
      if (!this.grants.has(deviceId))
        this.grants.set(deviceId, randomBytes(32));
    } else this.grants.delete(deviceId);
  }
  get(deviceId: string): Buffer | undefined {
    return this.grants.get(deviceId);
  }
  devices(): string[] {
    return [...this.grants.keys()];
  }
  clear(): void {
    this.grants.clear();
  }
}

export const remoteSubagentGrants = new RemoteSubagentGrants();

const isControl = (character: string): boolean => {
  const code = character.codePointAt(0)!;
  return code <= 31 || code === 127;
};

const states = new Set<RemoteSubagentSummary["state"]>([
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "timed_out",
  "interrupted",
  "needs_attention",
  "stopped",
  "unknown",
]);

export function parseRemoteSubagentPage(value: unknown): RemoteSubagentPage {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const integer = (value: unknown, min = 0): value is number =>
    Number.isSafeInteger(value) && (value as number) >= min;
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
  const invalid = () =>
    new Error("Invalid workspace subagent summary response.");
  if (
    !record(value) ||
    value.version !== 1 ||
    !identifier(value.workspaceId) ||
    !identifier(value.chatId) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_REMOTE_RUNS ||
    Object.keys(value).some(
      (key) =>
        !["version", "workspaceId", "chatId", "runs", "truncated"].includes(
          key,
        ),
    )
  )
    throw invalid();
  const ids = new Set<string>();
  for (const run of value.runs) {
    if (
      !record(run) ||
      typeof run.id !== "string" ||
      !/^run_[A-Za-z0-9_-]{43}$/u.test(run.id) ||
      ids.has(run.id) ||
      typeof run.label !== "string" ||
      [...run.label].length < 1 ||
      [...run.label].length > 80 ||
      [...run.label].some(isControl) ||
      !["scout", "planner", "reviewer"].includes(run.role as string) ||
      !states.has(run.state as RemoteSubagentSummary["state"]) ||
      !integer(run.revision, 1) ||
      !integer(run.startedAt) ||
      !integer(run.updatedAt) ||
      run.updatedAt < run.startedAt ||
      Object.keys(run).some(
        (key) =>
          ![
            "id",
            "label",
            "role",
            "state",
            "revision",
            "startedAt",
            "updatedAt",
          ].includes(key),
      )
    )
      throw invalid();
    ids.add(run.id);
  }
  return value as unknown as RemoteSubagentPage;
}

export class AidenRemoteSubagentService {
  constructor(
    private readonly dependencies: {
      grants: RemoteSubagentGrants;
      enabled(): boolean;
      /** Must resolve ordinary public workspace chat metadata, excluding Bots/Assistant. */
      ownsChat(workspaceId: string, chatId: string): Promise<boolean>;
      listRuns(chatId: string): Promise<SubagentRunSnapshot[]>;
    },
  ) {}

  async list(
    deviceId: string,
    workspaceId: string,
    chatId: string,
    reauthorize: () => Promise<void> = async () => {},
  ): Promise<RemoteSubagentPage> {
    const grant = this.dependencies.grants.get(deviceId);
    const authorized = () =>
      grant !== undefined &&
      this.dependencies.enabled() &&
      this.dependencies.grants.get(deviceId) === grant;
    const requireGrant = () => {
      if (!authorized())
        throw new AidenRemoteServiceError(
          "capability_denied",
          "Enable subagent summaries for this device in Remote Access on your Mac.",
          403,
        );
    };
    requireGrant();
    if (!(await this.dependencies.ownsChat(workspaceId, chatId))) {
      throw new AidenRemoteServiceError(
        "not_found",
        "This workspace chat is unavailable.",
        404,
      );
    }
    requireGrant();
    const snapshots = await this.dependencies.listRuns(chatId);
    const matching = snapshots.filter(
      (run) => run.chatId === chatId && run.workspaceId === workspaceId,
    );
    matching.sort(
      (a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId),
    );
    const runs = matching
      .slice(0, MAX_REMOTE_RUNS)
      .map((run): RemoteSubagentSummary => ({
        id: `run_${createHmac("sha256", grant!)
          .update(JSON.stringify([workspaceId, chatId, run.runId]))
          .digest("base64url")}`,
        label:
          [...run.label]
            .slice(0, 80)
            .map((character) => (isControl(character) ? "�" : character))
            .join("") || "Subagent",
        role: run.role,
        state: states.has(run.state) ? run.state : "unknown",
        revision: run.revision,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
      }));
    await reauthorize();
    // Recheck after every asynchronous boundary: move/delete/revoke must not publish stale ownership.
    if (!(await this.dependencies.ownsChat(workspaceId, chatId))) {
      throw new AidenRemoteServiceError(
        "not_found",
        "This workspace chat is unavailable.",
        404,
      );
    }
    requireGrant();
    return parseRemoteSubagentPage({
      version: 1,
      workspaceId,
      chatId,
      runs,
      truncated: matching.length > MAX_REMOTE_RUNS,
    });
  }
}
