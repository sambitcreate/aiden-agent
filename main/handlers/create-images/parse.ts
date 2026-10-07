// Exact-shape request parsers for the Create Images channels. Anything else is
// rejected with one generic message before any store is touched.
import { hasExactKeys, isRecord } from "../../shared/guards.js";
import { IMAGE_IMPORT_MAX_BYTES } from "../../../renderer/shared/images/ipc-types.js";
import type { RunScope } from "../../../renderer/shared/images/run-types.js";
import { IMAGE_WORKFLOW_ID_PATTERN, IMAGE_WORKFLOW_LIMITS } from "../../../renderer/shared/images/schema.js";

const INVALID = "Invalid Create Images request.";
const CONSENT_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const IMPORT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function invalid(): never {
  throw new Error(INVALID);
}

function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, required, optional)) invalid();
  return value;
}

/** Workflow and node ids share one opaque pattern: whitespace-only and empty ids never match it. */
function id(value: unknown): string {
  return typeof value === "string" && IMAGE_WORKFLOW_ID_PATTERN.test(value) ? value : invalid();
}

function title(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= IMAGE_WORKFLOW_LIMITS.maxTitleLength
    ? value
    : invalid();
}

function revision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : invalid();
}

export function parseEmptyRequest(value: unknown): void {
  if (value !== undefined) shape(value, []);
}

export function parseWorkflowRequest(value: unknown): { workflowId: string } {
  return { workflowId: id(shape(value, ["workflowId"]).workflowId) };
}

export function parseCreateRequest(value: unknown): { template: "blank" | "starter"; title?: string } {
  const request = shape(value, ["template"], ["title"]);
  if (request.template !== "blank" && request.template !== "starter") invalid();
  return { template: request.template, ...(request.title !== undefined ? { title: title(request.title) } : {}) };
}

export function parseSaveRequest(value: unknown): { workflowId: string; baseRevision: number; document: unknown } {
  const request = shape(value, ["workflowId", "baseRevision", "document"]);
  return { workflowId: id(request.workflowId), baseRevision: revision(request.baseRevision), document: request.document };
}

export function parseMutateRequest(
  value: unknown,
): { op: "rename"; workflowId: string; title: string } | { op: "duplicate" | "delete"; workflowId: string } {
  if (!isRecord(value)) invalid();
  if (value.op === "rename") {
    const request = shape(value, ["op", "workflowId", "title"]);
    return { op: "rename", workflowId: id(request.workflowId), title: title(request.title) };
  }
  if (value.op === "duplicate" || value.op === "delete") {
    const request = shape(value, ["op", "workflowId"]);
    return { op: value.op, workflowId: id(request.workflowId) };
  }
  return invalid();
}

export function parseImportRequest(
  value: unknown,
): { source: "dialog" } | { source: "bytes"; name: string; mimeType: string; data: Uint8Array } {
  if (!isRecord(value)) invalid();
  if (value.source === "dialog") {
    shape(value, ["source"]);
    return { source: "dialog" };
  }
  if (value.source !== "bytes") invalid();
  const request = shape(value, ["source", "name", "mimeType", "data"]);
  if (typeof request.name !== "string" || request.name.length > 255) invalid();
  if (typeof request.mimeType !== "string" || !IMPORT_TYPES.has(request.mimeType)) invalid();
  const data = request.data;
  if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > IMAGE_IMPORT_MAX_BYTES) invalid();
  return { source: "bytes", name: request.name, mimeType: request.mimeType, data };
}

export function parseRunScope(value: unknown): RunScope {
  const scope = shape(value, ["kind"], ["nodeId"]);
  if (scope.kind === "all" && scope.nodeId === undefined) return { kind: "all" };
  if (scope.kind === "from-node" || scope.kind === "node-only") return { kind: scope.kind, nodeId: id(scope.nodeId) };
  return invalid();
}

export function parsePrepareRequest(value: unknown): { workflowId: string; revision: number; scope: RunScope } {
  const request = shape(value, ["workflowId", "revision", "scope"]);
  return { workflowId: id(request.workflowId), revision: revision(request.revision), scope: parseRunScope(request.scope) };
}

export function parseConsentRequest(value: unknown): { consentId: string } {
  const consentId = shape(value, ["consentId"]).consentId;
  return typeof consentId === "string" && CONSENT_ID.test(consentId) ? { consentId } : invalid();
}

export function parseRunRequest(value: unknown): { runId: string } {
  return { runId: id(shape(value, ["runId"]).runId) };
}

export function parseGetRunRequest(value: unknown): { runId: string } | { workflowId: string } {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "runId")
    ? parseRunRequest(value)
    : parseWorkflowRequest(value);
}

export function parseListRunsRequest(value: unknown): { workflowId: string; limit: number } {
  const request = shape(value, ["workflowId", "limit"]);
  const limit = request.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) invalid();
  return { workflowId: id(request.workflowId), limit: limit as number };
}
