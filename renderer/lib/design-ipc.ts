// Typed Design Studio client on the minimal IPC bridge (not ipc.ts). Only the
// lazy /design route imports it.
//
// Main answers store refusals with `{ ok: false, reason, message }` (see
// main/handlers/design/results.ts). This client turns those into a thrown
// DesignIpcError, and turns any response with an unknown shape into the same
// typed error, so callers never receive an unchecked payload.
import { invoke, onNotification } from "./ipc-bridge";
import {
  DESIGN_FAILURE_REASONS,
  DESIGN_PROJECT_HEALTH,
  DESIGN_RUN_STATUSES,
  isDesignId,
  type DesignFailureReason,
} from "../shared/design/ids";
import type {
  DesignDeletePreview,
  DesignMutateResult,
  DesignPreviewTheme,
  DesignProjectOp,
  DesignProjectSnapshot,
  DesignProjectSummary,
  DesignProjectsChangedEvent,
  DesignRunChangedEvent,
  DesignRunStartRequest,
  DesignRunStartResult,
  DesignRunStatus,
} from "../shared/design/types";

export type DesignIpcFailureReason = DesignFailureReason;

/** A refused or unrecognized Design Studio call. `reason` is "unexpected" for an unknown shape. */
export class DesignIpcError extends Error {
  constructor(
    readonly reason: DesignIpcFailureReason | "unexpected",
    message: string,
  ) {
    super(message);
    this.name = "DesignIpcError";
  }
}

const FAILURE_REASONS: ReadonlySet<string> = new Set(DESIGN_FAILURE_REASONS);
const MUTATE_REFUSAL_REASONS: ReadonlySet<string> = new Set<string>(["stale", "quota", "invalid", "busy"]);
const RUN_STATUSES: ReadonlySet<string> = new Set(DESIGN_RUN_STATUSES);
const PROJECT_HEALTH: ReadonlySet<string> = new Set(DESIGN_PROJECT_HEALTH);
const MAX_ACCEPTED_REVISIONS = 4;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A store refusal is `{ ok: false, reason, message }` with a known reason. */
function refusalOf(value: unknown): DesignIpcError | undefined {
  const record = asRecord(value);
  if (!record || record.ok !== false || typeof record.reason !== "string") return undefined;
  if (!FAILURE_REASONS.has(record.reason)) return undefined;
  const message = typeof record.message === "string" ? record.message : "Design Studio could not complete that.";
  return new DesignIpcError(record.reason as DesignIpcFailureReason, message);
}

function unexpected(channel: string): DesignIpcError {
  return new DesignIpcError("unexpected", `Design Studio returned an unexpected response for ${channel}.`);
}

function isProjectSummary(value: unknown): value is DesignProjectSummary {
  const record = asRecord(value);
  return (
    record !== undefined &&
    isDesignId(record.id) &&
    typeof record.title === "string" &&
    isTimestamp(record.updatedAt) &&
    isCount(record.screenCount) &&
    isCount(record.bytes) &&
    typeof record.health === "string" &&
    PROJECT_HEALTH.has(record.health)
  );
}

function isProjectSnapshot(value: unknown): value is DesignProjectSnapshot {
  const record = asRecord(value);
  const canvas = asRecord(record?.canvas);
  return (
    record !== undefined &&
    record.schema === 1 &&
    isDesignId(record.id) &&
    typeof record.revision === "number" &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 1 &&
    typeof record.title === "string" &&
    typeof record.chatId === "string" &&
    (record.state === "active" || record.state === "deleting") &&
    isTimestamp(record.createdAt) &&
    isTimestamp(record.updatedAt) &&
    canvas !== undefined &&
    Array.isArray(canvas.nodes) &&
    asRecord(canvas.viewport) !== undefined &&
    asRecord(record.screens) !== undefined &&
    asRecord(record.revisions) !== undefined &&
    asRecord(record.directionSets) !== undefined &&
    asRecord(record.runs) !== undefined
  );
}

function isDeletePreview(value: unknown): value is DesignDeletePreview {
  const record = asRecord(value);
  return (
    record !== undefined &&
    isCount(record.screens) &&
    isCount(record.revisions) &&
    isCount(record.bytes) &&
    isCount(record.references) &&
    (record.unreadable === undefined || record.unreadable === true)
  );
}

function parseSnapshot(channel: string, value: unknown): DesignProjectSnapshot {
  const refusal = refusalOf(value);
  if (refusal) throw refusal;
  if (!isProjectSnapshot(value)) throw unexpected(channel);
  return value;
}

function parseMutateResult(value: unknown): DesignMutateResult {
  const record = asRecord(value);
  if (record?.ok === true && isProjectSnapshot(record.snapshot)) {
    return { ok: true, snapshot: record.snapshot };
  }
  if (
    record?.ok === false &&
    typeof record.reason === "string" &&
    MUTATE_REFUSAL_REASONS.has(record.reason) &&
    typeof record.message === "string" &&
    isProjectSnapshot(record.snapshot)
  ) {
    return {
      ok: false,
      reason: record.reason as "stale" | "quota" | "invalid" | "busy",
      message: record.message,
      snapshot: record.snapshot,
    };
  }
  const refusal = refusalOf(value);
  if (refusal) throw refusal;
  throw unexpected("designProjects:mutate");
}

/** A void channel resolves to nothing on success; anything else is a refusal or an unknown shape. */
function settleVoid(value: unknown, channel: string): void {
  if (value === undefined || value === null) return;
  const refusal = refusalOf(value);
  if (refusal) throw refusal;
  throw unexpected(channel);
}

export function parseDesignProjectsChangedEvent(value: unknown): DesignProjectsChangedEvent | undefined {
  const event = asRecord(value);
  if (!event || !isDesignId(event.projectId)) return undefined;
  if (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision) || event.revision < 0) {
    return undefined;
  }
  return { projectId: event.projectId, revision: event.revision };
}

export function parseDesignRunChangedEvent(value: unknown): DesignRunChangedEvent | undefined {
  const event = asRecord(value);
  if (!event || !isDesignId(event.projectId) || !isDesignId(event.runId)) return undefined;
  if (typeof event.status !== "string" || !RUN_STATUSES.has(event.status)) return undefined;
  const ids = event.acceptedRevisionIds;
  if (!Array.isArray(ids) || ids.length > MAX_ACCEPTED_REVISIONS || !ids.every(isDesignId)) return undefined;
  return {
    projectId: event.projectId,
    runId: event.runId,
    status: event.status as DesignRunStatus,
    acceptedRevisionIds: [...ids],
  };
}

export const designProjectsApi = {
  async list(): Promise<DesignProjectSummary[]> {
    const value = await invoke<unknown>("designProjects:list");
    const refusal = refusalOf(value);
    if (refusal) throw refusal;
    if (!Array.isArray(value) || !value.every(isProjectSummary)) throw unexpected("designProjects:list");
    return value;
  },

  async get(projectId: string): Promise<DesignProjectSnapshot> {
    return parseSnapshot("designProjects:get", await invoke<unknown>("designProjects:get", { projectId }));
  },

  async create(title?: string): Promise<DesignProjectSnapshot> {
    const request = title === undefined ? {} : { title };
    return parseSnapshot("designProjects:create", await invoke<unknown>("designProjects:create", request));
  },

  async duplicate(projectId: string): Promise<DesignProjectSnapshot> {
    return parseSnapshot("designProjects:duplicate", await invoke<unknown>("designProjects:duplicate", { projectId }));
  },

  async mutate(projectId: string, expectedRevision: number, op: DesignProjectOp): Promise<DesignMutateResult> {
    return parseMutateResult(await invoke<unknown>("designProjects:mutate", { projectId, expectedRevision, op }));
  },

  async previewDelete(projectId: string): Promise<DesignDeletePreview> {
    const value = await invoke<unknown>("designProjects:previewDelete", { projectId });
    const refusal = refusalOf(value);
    if (refusal) throw refusal;
    if (!isDeletePreview(value)) throw unexpected("designProjects:previewDelete");
    return value;
  },

  /** Deletes a healthy project against the revision the user confirmed. */
  async delete(projectId: string, expectedRevision: number): Promise<void> {
    settleVoid(await invoke<unknown>("designProjects:delete", { projectId, expectedRevision }), "designProjects:delete");
  },

  /** Deletes an unreadable project after the user confirms unknown contents (see previewDelete). */
  async deleteUnreadable(projectId: string): Promise<void> {
    settleVoid(await invoke<unknown>("designProjects:delete", { projectId, unreadable: true }), "designProjects:delete");
  },

  async run(request: DesignRunStartRequest): Promise<DesignRunStartResult> {
    const value = await invoke<unknown>("designProjects:run", request);
    const refusal = refusalOf(value);
    if (refusal) throw refusal;
    const record = asRecord(value);
    if (typeof record?.accepted !== "boolean") throw unexpected("designProjects:run");
    return value as DesignRunStartResult;
  },

  async previewSrc(projectId: string, revisionId: string, theme?: DesignPreviewTheme): Promise<{ src: string; title: string }> {
    const request = theme === undefined ? { projectId, revisionId } : { projectId, revisionId, theme };
    const value = await invoke<unknown>("designProjects:previewSrc", request);
    const refusal = refusalOf(value);
    if (refusal) throw refusal;
    const record = asRecord(value);
    if (typeof record?.src !== "string" || typeof record.title !== "string") {
      throw unexpected("designProjects:previewSrc");
    }
    return { src: record.src, title: record.title };
  },

  async readSource(projectId: string, revisionId: string): Promise<{ html: string; bytes: number }> {
    const value = await invoke<unknown>("designProjects:readSource", { projectId, revisionId });
    const refusal = refusalOf(value);
    if (refusal) throw refusal;
    const record = asRecord(value);
    if (typeof record?.html !== "string" || !isCount(record.bytes)) throw unexpected("designProjects:readSource");
    return { html: record.html, bytes: record.bytes };
  },

  onChanged(handler: (event: DesignProjectsChangedEvent) => void): () => void {
    return onNotification<unknown>("designProjects:changed", (payload) => {
      const event = parseDesignProjectsChangedEvent(payload);
      if (event) handler(event);
    });
  },

  onRunChanged(handler: (event: DesignRunChangedEvent) => void): () => void {
    return onNotification<unknown>("designProjects:run-changed", (payload) => {
      const event = parseDesignRunChangedEvent(payload);
      if (event) handler(event);
    });
  },
};
