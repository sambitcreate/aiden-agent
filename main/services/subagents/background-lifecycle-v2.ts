import {
  isSafeSubagentIdentifier,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV2,
  type SubagentRunStateV2,
} from "../../../renderer/shared/subagent-runs.js";
import {
  SUBAGENT_AUTHORITY_VERSION,
  createSubagentAuthorityV2,
  type CreateSubagentAuthorityV2Input,
  type SubagentAuthorityV2,
} from "./authority-v2.js";
import { sanitizeSubagentText } from "./safe-text.js";

export const MAX_BACKGROUND_EVENTS_V2 = 128;
export const MAX_BACKGROUND_STEERS_V2 = 16;
export const MAX_BACKGROUND_WAITS_V2 = 64;
export const MAX_BACKGROUND_WAIT_MS_V2 = 30_000;
export const MAX_BACKGROUND_STEER_CHARS_V2 = 8_000;

const ACTIVE = new Set<SubagentRunStateV2>([
  "queued",
  "starting",
  "running",
  "needs_attention",
]);
const TRANSITIONS: Readonly<Record<string, ReadonlySet<SubagentRunStateV2>>> = {
  queued: new Set(["starting", "stopped", "interrupted"]),
  starting: new Set([
    "running",
    "failed",
    "timed_out",
    "stopped",
    "interrupted",
    "unknown",
  ]),
  running: new Set([
    "needs_attention",
    "completed",
    "failed",
    "timed_out",
    "stopped",
    "interrupted",
    "unknown",
  ]),
  needs_attention: new Set([
    "running",
    "failed",
    "timed_out",
    "stopped",
    "interrupted",
    "unknown",
  ]),
};

export interface BackgroundSubagentEventV2 {
  sequence: number;
  at: number;
  kind:
    | "accepted"
    | "transition"
    | "wait"
    | "steer"
    | "stop_requested"
    | "reconciled";
  state: SubagentRunStateV2;
}

export interface BackgroundSubagentSteerV2 {
  sequence: number;
  at: number;
  instruction: string;
  consumed: boolean;
}

export interface BackgroundSubagentRunV2 {
  version: 2;
  manifest: {
    version: 2;
    execution: "background";
    context: "fresh";
    reusableAuthority: false;
    acceptedAt: number;
    task: string;
    authority: SubagentAuthorityV2;
  };
  snapshot: SubagentRunSnapshotV2;
  events: BackgroundSubagentEventV2[];
  steering: BackgroundSubagentSteerV2[];
  waitCount: number;
  waitedMs: number;
}

export interface BackgroundSubagentStoreV2 {
  get(runId: string): Promise<BackgroundSubagentRunV2 | null>;
  put(
    run: BackgroundSubagentRunV2,
    expectedRevision: number | null,
  ): Promise<boolean>;
  list(): Promise<BackgroundSubagentRunV2[]>;
}

const AUTHORITY_KEYS = [
  "version", "grantId", "treeRootId", "runId", "depth", "authorityRevision",
  "generationId", "chatId", "workspaceId", "workspaceRevision", "ownerDocumentId",
  "providerFingerprint", "modelFingerprint", "contextRevision", "execution", "context",
  "thinkingLevel", "capabilities", "budgets", "expiresAt",
] as const;
const EVENT_KINDS = new Set<BackgroundSubagentEventV2["kind"]>([
  "accepted", "transition", "wait", "steer", "stop_requested", "reconciled",
]);
const RUN_STATES = new Set<SubagentRunStateV2>([
  "queued", "starting", "running", "needs_attention", "completed", "failed",
  "timed_out", "stopped", "interrupted", "unknown",
]);

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) && keys.every((key) => required.includes(key) || optional.includes(key)) && keys.length >= required.length && keys.length <= required.length + optional.length;
}

function parseBackgroundAuthority(value: unknown): SubagentAuthorityV2 | undefined {
  if (!record(value) || !exact(value, AUTHORITY_KEYS, ["parentRunId"])) return undefined;
  try {
    const authority = createSubagentAuthorityV2(value as unknown as CreateSubagentAuthorityV2Input);
    assertBackgroundAuthority(authority);
    return authority;
  } catch {
    return undefined;
  }
}

/** Strict private parser used before any background record crosses durable storage. */
export function parseBackgroundSubagentRunV2(value: unknown): BackgroundSubagentRunV2 | undefined {
  if (
    !record(value) ||
    !exact(value, ["version", "manifest", "snapshot", "events", "steering", "waitCount", "waitedMs"]) ||
    value.version !== 2 ||
    !record(value.manifest) ||
    !exact(value.manifest, ["version", "execution", "context", "reusableAuthority", "acceptedAt", "task", "authority"]) ||
    value.manifest.version !== 2 || value.manifest.execution !== "background" ||
    value.manifest.context !== "fresh" || value.manifest.reusableAuthority !== false ||
    typeof value.manifest.acceptedAt !== "number" || !Number.isFinite(value.manifest.acceptedAt) || value.manifest.acceptedAt < 0 ||
    !bounded(value.manifest.task, 240) || sanitizeSubagentText(value.manifest.task) !== value.manifest.task ||
    !Array.isArray(value.events) || value.events.length < 1 || value.events.length > MAX_BACKGROUND_EVENTS_V2 ||
    !Array.isArray(value.steering) || value.steering.length > MAX_BACKGROUND_STEERS_V2 ||
    !Number.isSafeInteger(value.waitCount) || (value.waitCount as number) < 0 || (value.waitCount as number) > MAX_BACKGROUND_WAITS_V2 ||
    !Number.isSafeInteger(value.waitedMs) || (value.waitedMs as number) < 0 || (value.waitedMs as number) > MAX_BACKGROUND_WAITS_V2 * MAX_BACKGROUND_WAIT_MS_V2
  ) return undefined;
  const authority = parseBackgroundAuthority(value.manifest.authority);
  const snapshot = parseSubagentRunSnapshotV2(value.snapshot);
  if (
    !authority || !snapshot || snapshot.execution !== "background" || snapshot.context !== "fresh" ||
    snapshot.runId !== authority.runId || snapshot.generationId !== authority.generationId ||
    snapshot.chatId !== authority.chatId || snapshot.workspaceId !== authority.workspaceId ||
    snapshot.authorityRevision !== authority.authorityRevision || snapshot.taskPreview !== value.manifest.task
  ) return undefined;
  const events: BackgroundSubagentEventV2[] = [];
  let previousEventSequence = 0;
  for (let index = 0; index < value.events.length; index += 1) {
    const item = value.events[index];
    if (!record(item) || !exact(item, ["sequence", "at", "kind", "state"]) ||
      !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1 ||
      (index > 0 && item.sequence !== previousEventSequence + 1) ||
      typeof item.at !== "number" || !Number.isFinite(item.at) || item.at < 0 ||
      !EVENT_KINDS.has(item.kind as BackgroundSubagentEventV2["kind"]) || !RUN_STATES.has(item.state as SubagentRunStateV2)
    ) return undefined;
    previousEventSequence = item.sequence as number;
    events.push({ sequence: item.sequence as number, at: item.at, kind: item.kind as BackgroundSubagentEventV2["kind"], state: item.state as SubagentRunStateV2 });
  }
  const steering: BackgroundSubagentSteerV2[] = [];
  for (let index = 0; index < value.steering.length; index += 1) {
    const item = value.steering[index];
    if (!record(item) || !exact(item, ["sequence", "at", "instruction", "consumed"]) ||
      item.sequence !== index + 1 || typeof item.at !== "number" || !Number.isFinite(item.at) || item.at < 0 ||
      !bounded(item.instruction, MAX_BACKGROUND_STEER_CHARS_V2) || sanitizeSubagentText(item.instruction) !== item.instruction || typeof item.consumed !== "boolean"
    ) return undefined;
    steering.push({ sequence: item.sequence, at: item.at, instruction: item.instruction, consumed: item.consumed });
  }
  return {
    version: 2,
    manifest: { version: 2, execution: "background", context: "fresh", reusableAuthority: false, acceptedAt: value.manifest.acceptedAt, task: value.manifest.task, authority },
    snapshot,
    events,
    steering,
    waitCount: value.waitCount as number,
    waitedMs: value.waitedMs as number,
  };
}

export interface BackgroundSubagentHooksV2 {
  stop?(
    runId: string,
    reason: "explicit" | "chat_deleted" | "workspace_revoked" | "shutdown",
  ): void;
  steer?(runId: string): void;
}

export interface BackgroundSubagentManagementRequestV2 {
  version: 2;
  action: "status" | "wait" | "stop" | "steer";
  runId: string;
  chatId: string;
  workspaceId: string;
  ownerDocumentId: string;
  authorityRevision: number;
  expectedRevision: number;
  timeoutMs?: number;
  instruction?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

export function parseBackgroundSubagentManagementRequestV2(
  value: unknown,
): BackgroundSubagentManagementRequestV2 {
  if (!record(value))
    throw new Error("Invalid background subagent management request.");
  const base = [
    "version",
    "action",
    "runId",
    "chatId",
    "workspaceId",
    "ownerDocumentId",
    "authorityRevision",
    "expectedRevision",
  ];
  const optional =
    value.action === "wait"
      ? ["timeoutMs"]
      : value.action === "steer"
        ? ["instruction"]
        : [];
  const keys = Object.keys(value);
  if (
    value.version !== SUBAGENT_AUTHORITY_VERSION ||
    !["status", "wait", "stop", "steer"].includes(String(value.action)) ||
    keys.length !== base.length + optional.length ||
    !keys.every((key) => base.includes(key) || optional.includes(key)) ||
    ![value.runId, value.chatId, value.workspaceId].every(
      isSafeSubagentIdentifier,
    ) ||
    !bounded(value.ownerDocumentId) ||
    !Number.isSafeInteger(value.authorityRevision) ||
    (value.authorityRevision as number) < 1 ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1 ||
    (value.action === "wait" &&
      (!Number.isSafeInteger(value.timeoutMs) ||
        (value.timeoutMs as number) < 0 ||
        (value.timeoutMs as number) > MAX_BACKGROUND_WAIT_MS_V2)) ||
    (value.action === "steer" &&
      (!bounded(value.instruction, MAX_BACKGROUND_STEER_CHARS_V2) ||
        !(value.instruction as string).trim()))
  ) {
    throw new Error("Invalid background subagent management request fields.");
  }
  return { ...value } as unknown as BackgroundSubagentManagementRequestV2;
}

function assertBackgroundAuthority(authority: SubagentAuthorityV2): void {
  const capabilities = authority.capabilities;
  if (
    authority.execution !== "background" ||
    authority.context !== "fresh" ||
    authority.depth !== 1 ||
    authority.parentRunId !== undefined ||
    authority.treeRootId !== authority.runId ||
    capabilities.workspaceRead !== true ||
    capabilities.workspaceWrite ||
    capabilities.shell ||
    capabilities.web ||
    capabilities.delegation ||
    capabilities.mcp.length !== 0
  ) {
    throw new Error(
      "Background Phase 7A authority must be fresh, depth-1, and read-only without outbound capabilities.",
    );
  }
}

function safeVisible(value: unknown, maximum: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`Invalid background ${field}.`);
  }
  const safe = sanitizeSubagentText(value);
  if (!safe.trim()) throw new Error(`Invalid background ${field}.`);
  return safe;
}

function copy(run: BackgroundSubagentRunV2): BackgroundSubagentRunV2 {
  return structuredClone(run);
}

function event(
  run: BackgroundSubagentRunV2,
  kind: BackgroundSubagentEventV2["kind"],
  at: number,
  required = false,
): BackgroundSubagentEventV2[] {
  const next = {
    sequence: (run.events[run.events.length - 1]?.sequence ?? 0) + 1,
    at,
    kind,
    state: run.snapshot.state,
  };
  if (run.events.length >= MAX_BACKGROUND_EVENTS_V2) {
    if (!required) throw new Error("Background event ledger is full.");
    return [...run.events.slice(1), next];
  }
  return [...run.events, next];
}

export class BackgroundSubagentLifecycleV2 {
  constructor(
    private readonly store: BackgroundSubagentStoreV2,
    private readonly hooks: BackgroundSubagentHooksV2 = {},
    private readonly now: () => number = Date.now,
  ) {}

  async accept(input: {
    authority: SubagentAuthorityV2;
    snapshot: SubagentRunSnapshotV2;
    task: string;
  }): Promise<{
    accepted: true;
    runId: string;
    revision: number;
    state: "queued";
  }> {
    assertBackgroundAuthority(input.authority);
    const { snapshot, authority } = input;
    const acceptedAt = this.now();
    const task = safeVisible(input.task, 240, "task");
    const parsedSnapshot = parseSubagentRunSnapshotV2({
      ...snapshot,
      label: safeVisible(snapshot.label, 80, "label"),
      taskPreview: task,
      ...(snapshot.activity === undefined
        ? {}
        : { activity: safeVisible(snapshot.activity, 512, "activity") }),
    });
    if (
      !parsedSnapshot ||
      parsedSnapshot.execution !== "background" ||
      parsedSnapshot.context !== "fresh" ||
      parsedSnapshot.state !== "queued" ||
      parsedSnapshot.finishedAt !== undefined ||
      parsedSnapshot.depth !== 1 ||
      parsedSnapshot.parentRunId !== undefined ||
      authority.expiresAt <= acceptedAt ||
      parsedSnapshot.runId !== authority.runId ||
      parsedSnapshot.generationId !== authority.generationId ||
      parsedSnapshot.chatId !== authority.chatId ||
      parsedSnapshot.workspaceId !== authority.workspaceId ||
      parsedSnapshot.authorityRevision !== authority.authorityRevision
    )
      throw new Error("Invalid or duplicate background launch acceptance.");
    const run: BackgroundSubagentRunV2 = {
      version: 2,
      manifest: {
        version: 2,
        execution: "background",
        context: "fresh",
        reusableAuthority: false,
        acceptedAt,
        task,
        authority,
      },
      snapshot: parsedSnapshot,
      events: [],
      steering: [],
      waitCount: 0,
      waitedMs: 0,
    };
    run.events = event(run, "accepted", acceptedAt);
    if (!(await this.store.put(copy(run), null)))
      throw new Error("Duplicate background launch acceptance.");
    return {
      accepted: true,
      runId: snapshot.runId,
      revision: snapshot.revision,
      state: "queued",
    };
  }

  private async owned(
    request: BackgroundSubagentManagementRequestV2,
  ): Promise<BackgroundSubagentRunV2> {
    const run = await this.store.get(request.runId);
    const authority = run?.manifest.authority;
    if (
      !run ||
      !authority ||
      authority.chatId !== request.chatId ||
      authority.workspaceId !== request.workspaceId ||
      authority.ownerDocumentId !== request.ownerDocumentId ||
      authority.authorityRevision !== request.authorityRevision ||
      run.snapshot.revision !== request.expectedRevision
    ) {
      throw new Error("Background subagent ownership or revision changed.");
    }
    return copy(run);
  }

  async manage(value: unknown): Promise<BackgroundSubagentRunV2> {
    const request = parseBackgroundSubagentManagementRequestV2(value);
    const run = await this.owned(request);
    if (request.action === "status") return run;
    const at = this.now();
    if (request.action === "wait") {
      if (run.waitCount >= MAX_BACKGROUND_WAITS_V2)
        throw new Error("Background wait ledger is full.");
      run.waitCount += 1;
      run.waitedMs += request.timeoutMs!;
      run.snapshot = {
        ...run.snapshot,
        revision: run.snapshot.revision + 1,
        updatedAt: Math.max(run.snapshot.updatedAt, at),
      };
      run.events = event(run, "wait", at);
    } else if (request.action === "steer") {
      if (
        run.snapshot.state !== "running" &&
        run.snapshot.state !== "needs_attention"
      )
        throw new Error(
          "Background run cannot be steered in its current state.",
        );
      if (run.steering.length >= MAX_BACKGROUND_STEERS_V2)
        throw new Error("Background steering ledger is full.");
      run.steering.push({
        sequence: run.steering.length + 1,
        at,
        instruction: safeVisible(
          request.instruction,
          MAX_BACKGROUND_STEER_CHARS_V2,
          "steering instruction",
        ),
        consumed: false,
      });
      run.snapshot = {
        ...run.snapshot,
        revision: run.snapshot.revision + 1,
        updatedAt: Math.max(run.snapshot.updatedAt, at),
      };
      run.events = event(run, "steer", at);
    } else {
      if (ACTIVE.has(run.snapshot.state)) {
        run.events = event(run, "stop_requested", at, true);
        this.setState(run, "stopped", "Stopped by owner.", at);
      }
    }
    if (!(await this.store.put(copy(run), request.expectedRevision))) {
      throw new Error(
        "Background subagent revision changed before persistence.",
      );
    }
    try {
      if (request.action === "steer") this.hooks.steer?.(run.snapshot.runId);
      if (request.action === "stop" && run.snapshot.state === "stopped") {
        this.hooks.stop?.(run.snapshot.runId, "explicit");
      }
    } catch {
      await this.recordHookFailure(run);
    }
    return run;
  }

  async transition(
    value: unknown,
    next: SubagentRunStateV2,
    activity: string,
  ): Promise<BackgroundSubagentRunV2> {
    const request = parseBackgroundSubagentManagementRequestV2(value);
    if (request.action !== "status")
      throw new Error("A status ownership proof is required for transition.");
    const run = await this.owned(request);
    if (!TRANSITIONS[run.snapshot.state]?.has(next))
      throw new Error("Invalid background subagent state transition.");
    const at = this.now();
    if (
      (next === "starting" || next === "running") &&
      run.manifest.authority.expiresAt <= at
    ) {
      throw new Error(
        "Background subagent authority expired before execution transition.",
      );
    }
    this.setState(run, next, safeVisible(activity, 512, "activity"), at);
    if (!(await this.store.put(copy(run), request.expectedRevision))) {
      throw new Error(
        "Background subagent revision changed before persistence.",
      );
    }
    return run;
  }

  private setState(
    run: BackgroundSubagentRunV2,
    state: SubagentRunStateV2,
    activity: string,
    at: number,
  ): void {
    if (!Number.isFinite(at) || at < run.snapshot.updatedAt)
      throw new Error("Background lifecycle clock moved backwards.");
    run.snapshot = {
      ...run.snapshot,
      revision: run.snapshot.revision + 1,
      state,
      activity: safeVisible(activity, 512, "activity"),
      updatedAt: at,
      ...(ACTIVE.has(state) ? { finishedAt: undefined } : { finishedAt: at }),
    };
    run.events = event(
      run,
      state === "interrupted" ? "reconciled" : "transition",
      at,
      state === "stopped" || state === "interrupted" || state === "unknown",
    );
  }

  private async recordHookFailure(run: BackgroundSubagentRunV2): Promise<void> {
    const expectedRevision = run.snapshot.revision;
    this.setState(
      run,
      "unknown",
      "Lifecycle hook outcome could not be proven.",
      this.now(),
    );
    if (await this.store.put(copy(run), expectedRevision)) return;
    const current = await this.store.get(run.snapshot.runId);
    if (!current || !ACTIVE.has(current.snapshot.state)) return;
    const retryRevision = current.snapshot.revision;
    this.setState(
      current,
      "unknown",
      "Lifecycle hook outcome could not be proven.",
      this.now(),
    );
    if (!(await this.store.put(copy(current), retryRevision))) {
      throw new Error("Background hook ambiguity could not be persisted.");
    }
  }

  async reconcileStartup(): Promise<number> {
    return this.terminate(
      "shutdown",
      "interrupted",
      "Interrupted after Aiden restarted.",
    );
  }
  async chatDeleted(chatId: string): Promise<number> {
    return this.terminate(
      "chat_deleted",
      "stopped",
      "Stopped because the chat was deleted.",
      (run) => run.snapshot.chatId === chatId,
    );
  }
  async workspaceRevoked(workspaceId: string): Promise<number> {
    return this.terminate(
      "workspace_revoked",
      "stopped",
      "Stopped because workspace access was revoked.",
      (run) => run.snapshot.workspaceId === workspaceId,
    );
  }
  async shutdown(): Promise<number> {
    return this.terminate(
      "shutdown",
      "interrupted",
      "Interrupted during Aiden shutdown.",
    );
  }

  private async terminate(
    reason: "chat_deleted" | "workspace_revoked" | "shutdown",
    state: "stopped" | "interrupted",
    activity: string,
    matches: (run: BackgroundSubagentRunV2) => boolean = () => true,
  ): Promise<number> {
    let count = 0;
    for (const candidate of await this.store.list()) {
      if (!matches(candidate)) continue;
      let stored: BackgroundSubagentRunV2 | null = candidate;
      for (
        let attempt = 0;
        attempt < 2 && stored && ACTIVE.has(stored.snapshot.state);
        attempt += 1
      ) {
        const expectedRevision = stored.snapshot.revision;
        const run = copy(stored);
        this.setState(run, state, activity, this.now());
        if (!(await this.store.put(copy(run), expectedRevision))) {
          stored = await this.store.get(candidate.snapshot.runId);
          continue;
        }
        try {
          this.hooks.stop?.(run.snapshot.runId, reason);
        } catch {
          await this.recordHookFailure(run);
        }
        count += 1;
        break;
      }
    }
    return count;
  }
}
