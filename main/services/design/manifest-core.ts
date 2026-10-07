// The one Design Studio manifest schema. There is no migration code: later
// phases add only optional fields, and the parser learns each one then.
import { hasExactKeys, isRecord } from "../../shared/guards.js";
import {
  MAX_DESIGN_REVISION_BYTES,
  MAX_DESIGN_REVISIONS_PER_PROJECT,
  MAX_DESIGN_REVISIONS_PER_SCREEN,
  MAX_DESIGN_RUN_RECORDS,
  MAX_DESIGN_SCREENS_PER_PROJECT,
} from "../../../renderer/shared/design/limits.js";
import type {
  DesignCanvasNode,
  DesignDirectionSet,
  DesignModelRef,
  DesignProjectManifestV1,
  DesignRevision,
  DesignRunEndReason,
  DesignRunRecord,
  DesignScreen,
} from "../../../renderer/shared/design/types.js";
import {
  hasControlCharacter,
  isDesignId,
  parseDesignRunRequest,
  parseDesignScreenFrame,
  parseDesignTitle,
  parseDesignViewport,
} from "./ops-parse.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_STATUSES = new Set(["running", "complete", "partial", "cancelled", "interrupted", "failed"]);
const RUN_END_REASONS = new Set(["stopped", "provider_failed", "interrupted", "short"]);
const REVISION_STATES = new Set(["draft", "published", "missing"]);

export function createDesignProjectManifest(input: {
  id: string;
  chatId: string;
  title: string;
  now: number;
}): DesignProjectManifestV1 {
  return {
    schema: 1,
    id: input.id,
    revision: 1,
    title: input.title,
    chatId: input.chatId,
    state: "active",
    createdAt: input.now,
    updatedAt: input.now,
    canvas: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] },
    screens: {},
    revisions: {},
    directionSets: {},
    runs: {},
  };
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function coordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

/** Provider tool-call ids vary (OpenAI Responses joins two ids with "|"), so they are only bounded. */
function isToolCallId(value: unknown): value is string {
  return boundedIdentifier(value, 512) !== undefined;
}

/** Non-empty, length-bounded and free of the control characters the payload parsers reject. */
function boundedIdentifier(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  return hasControlCharacter(value) ? undefined : value;
}

function exactTitle(value: unknown): string | undefined {
  const title = parseDesignTitle(value);
  return title !== undefined && title === value ? title : undefined;
}

function idList(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const ids = new Set<string>();
  for (const item of value) {
    if (!isDesignId(item) || ids.has(item)) return undefined;
    ids.add(item);
  }
  return [...ids];
}

function keyedRecord<T extends { id: string }>(
  value: unknown,
  limit: number,
  parse: (item: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > limit) return undefined;
  const result: Record<string, T> = {};
  for (const [key, item] of entries) {
    const parsed = parse(item);
    if (!parsed || parsed.id !== key) return undefined;
    result[key] = parsed;
  }
  return result;
}

function parseModel(value: unknown): DesignModelRef | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["providerId", "model"])) return undefined;
  const providerId = boundedIdentifier(value.providerId, 512);
  const model = boundedIdentifier(value.model, 512);
  return providerId === undefined || model === undefined ? undefined : { providerId, model };
}

function parseNode(value: unknown): DesignCanvasNode | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "kind", "screenId", "x", "y"])) return undefined;
  if (!isDesignId(value.id) || value.kind !== "screen" || !isDesignId(value.screenId)) return undefined;
  if (!coordinate(value.x) || !coordinate(value.y)) return undefined;
  return { id: value.id, kind: "screen", screenId: value.screenId, x: value.x, y: value.y };
}

function parseScreen(value: unknown): DesignScreen | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "title", "frame", "revisionIds", "activeRevisionId", "createdAt"], ["directionSetId"])
  ) {
    return undefined;
  }
  const title = exactTitle(value.title);
  const frame = parseDesignScreenFrame(value.frame);
  const revisionIds = idList(value.revisionIds, MAX_DESIGN_REVISIONS_PER_SCREEN);
  if (!isDesignId(value.id) || title === undefined || !frame || !revisionIds || revisionIds.length === 0) {
    return undefined;
  }
  if (!isDesignId(value.activeRevisionId) || !timestamp(value.createdAt)) return undefined;
  if (value.directionSetId !== undefined && !isDesignId(value.directionSetId)) return undefined;
  return {
    id: value.id,
    title,
    frame,
    revisionIds,
    activeRevisionId: value.activeRevisionId,
    ...(value.directionSetId === undefined ? {} : { directionSetId: value.directionSetId }),
    createdAt: value.createdAt,
  };
}

function parseRevision(value: unknown): DesignRevision | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["id", "screenId", "runId", "toolCallId", "title", "bytes", "sha256", "state", "createdAt", "model"],
      ["parentRevisionId"],
    )
  ) {
    return undefined;
  }
  const title = exactTitle(value.title);
  const model = parseModel(value.model);
  if (!isDesignId(value.id) || !isDesignId(value.screenId) || !isDesignId(value.runId)) return undefined;
  if (!isToolCallId(value.toolCallId)) return undefined;
  if (title === undefined || !model || !timestamp(value.createdAt)) return undefined;
  if (
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > MAX_DESIGN_REVISION_BYTES
  ) {
    return undefined;
  }
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) return undefined;
  if (typeof value.state !== "string" || !REVISION_STATES.has(value.state)) return undefined;
  if (value.parentRevisionId !== undefined && !isDesignId(value.parentRevisionId)) return undefined;
  return {
    id: value.id,
    screenId: value.screenId,
    ...(value.parentRevisionId === undefined ? {} : { parentRevisionId: value.parentRevisionId }),
    runId: value.runId,
    toolCallId: value.toolCallId,
    title,
    bytes: value.bytes,
    sha256: value.sha256,
    state: value.state as DesignRevision["state"],
    createdAt: value.createdAt,
    model,
  };
}

function parseDirectionSet(value: unknown): DesignDirectionSet | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "runId", "requestedCount", "screenIds", "archived"], ["chosenScreenId"])
  ) {
    return undefined;
  }
  const screenIds = idList(value.screenIds, MAX_DESIGN_SCREENS_PER_PROJECT);
  const { requestedCount } = value;
  if (!isDesignId(value.id) || !isDesignId(value.runId) || !screenIds) return undefined;
  if (requestedCount !== 2 && requestedCount !== 3 && requestedCount !== 4) return undefined;
  if (typeof value.archived !== "boolean") return undefined;
  if (value.chosenScreenId !== undefined && !isDesignId(value.chosenScreenId)) return undefined;
  return {
    id: value.id,
    runId: value.runId,
    requestedCount,
    screenIds,
    ...(value.chosenScreenId === undefined ? {} : { chosenScreenId: value.chosenScreenId }),
    archived: value.archived,
  };
}

function parseRun(value: unknown): DesignRunRecord | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["id", "kind", "turnId", "request", "outputCap", "status", "revisionIds", "startedAt"],
      ["endedAt", "endReason", "directionSetId", "promptMessageId"],
    )
  ) {
    return undefined;
  }
  const request = parseDesignRunRequest(value.request);
  const revisionIds = idList(value.revisionIds, 4);
  if (!isDesignId(value.id) || !request || request.op !== value.kind || !revisionIds) return undefined;
  // The turn id is the run's stream id, which isSafeSubagentIdentifier bounds at 160.
  const turnId = boundedIdentifier(value.turnId, 160);
  if (turnId === undefined) return undefined;
  const { outputCap } = value;
  if (typeof outputCap !== "number" || !Number.isSafeInteger(outputCap) || outputCap < 1 || outputCap > 4) {
    return undefined;
  }
  if (revisionIds.length > outputCap || (request.op === "refine" && outputCap !== 1)) return undefined;
  if (typeof value.status !== "string" || !RUN_STATUSES.has(value.status)) return undefined;
  // An end reason explains a partial run and nothing else.
  if (
    value.endReason !== undefined &&
    (value.status !== "partial" || typeof value.endReason !== "string" || !RUN_END_REASONS.has(value.endReason))
  ) {
    return undefined;
  }
  if (value.directionSetId !== undefined && (request.op !== "explore" || !isDesignId(value.directionSetId))) {
    return undefined;
  }
  if (value.promptMessageId !== undefined && !isDesignId(value.promptMessageId)) return undefined;
  if (!timestamp(value.startedAt) || (value.endedAt !== undefined && !timestamp(value.endedAt))) {
    return undefined;
  }
  if (value.endedAt !== undefined && (value.status === "running" || value.endedAt < value.startedAt)) {
    return undefined;
  }
  return {
    id: value.id,
    kind: request.op,
    turnId,
    request,
    outputCap,
    status: value.status as DesignRunRecord["status"],
    ...(value.endReason === undefined ? {} : { endReason: value.endReason as DesignRunEndReason }),
    ...(value.directionSetId === undefined ? {} : { directionSetId: value.directionSetId }),
    ...(value.promptMessageId === undefined ? {} : { promptMessageId: value.promptMessageId }),
    revisionIds,
    startedAt: value.startedAt,
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
  };
}

/** Ids are untrusted keys: "constructor" and "toString" are valid ids but must never resolve to inherited members. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function crossReferencesHold(manifest: DesignProjectManifestV1): boolean {
  const { screens, revisions, directionSets, runs } = manifest;
  const nodeScreens = new Set<string>();
  for (const node of manifest.canvas.nodes) {
    if (!own(screens, node.screenId) || nodeScreens.has(node.screenId)) return false;
    nodeScreens.add(node.screenId);
  }
  for (const screen of Object.values(screens)) {
    if (!nodeScreens.has(screen.id) || !screen.revisionIds.includes(screen.activeRevisionId)) return false;
    if (screen.directionSetId !== undefined) {
      // The Screen and its set must name each other.
      if (!own(directionSets, screen.directionSetId)?.screenIds.includes(screen.id)) return false;
    }
    for (const revisionId of screen.revisionIds) {
      if (own(revisions, revisionId)?.screenId !== screen.id) return false;
    }
  }
  for (const revision of Object.values(revisions)) {
    if (!own(screens, revision.screenId)?.revisionIds.includes(revision.id)) return false;
    // A parent may be gone (an Explore base on another Screen can be deleted later), but never itself.
    if (revision.parentRevisionId === revision.id) return false;
    // Runs are trimmed, so a missing run is fine; an existing run must list what it produced.
    const run = own(runs, revision.runId);
    if (run && !run.revisionIds.includes(revision.id)) return false;
  }
  for (const set of Object.values(directionSets)) {
    for (const screenId of set.screenIds) {
      if (own(screens, screenId)?.directionSetId !== set.id) return false;
    }
    if (set.chosenScreenId !== undefined && !set.screenIds.includes(set.chosenScreenId)) return false;
  }
  for (const run of Object.values(runs)) {
    if (!run.revisionIds.every((revisionId) => own(revisions, revisionId)?.runId === run.id)) return false;
    // A run that ended with nothing loses its set and the reference together.
    if (run.directionSetId !== undefined && !own(directionSets, run.directionSetId)) return false;
  }
  return true;
}

export function parseDesignProjectManifestV1(value: unknown): DesignProjectManifestV1 | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema", "id", "revision", "title", "chatId", "state", "createdAt", "updatedAt",
      "canvas", "screens", "revisions", "directionSets", "runs",
    ])
  ) {
    return undefined;
  }
  const title = exactTitle(value.title);
  if (value.schema !== 1 || !isDesignId(value.id) || !isDesignId(value.chatId) || title === undefined) {
    return undefined;
  }
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    return undefined;
  }
  if (value.state !== "active" && value.state !== "deleting") return undefined;
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt)) return undefined;
  if (!isRecord(value.canvas) || !hasExactKeys(value.canvas, ["viewport", "nodes"])) return undefined;
  const viewport = parseDesignViewport(value.canvas.viewport);
  if (!viewport || !Array.isArray(value.canvas.nodes) || value.canvas.nodes.length > MAX_DESIGN_SCREENS_PER_PROJECT) {
    return undefined;
  }
  const nodes: DesignCanvasNode[] = [];
  const nodeIds = new Set<string>();
  for (const item of value.canvas.nodes) {
    const node = parseNode(item);
    if (!node || nodeIds.has(node.id)) return undefined;
    nodeIds.add(node.id);
    nodes.push(node);
  }
  const screens = keyedRecord(value.screens, MAX_DESIGN_SCREENS_PER_PROJECT, parseScreen);
  const revisions = keyedRecord(value.revisions, MAX_DESIGN_REVISIONS_PER_PROJECT, parseRevision);
  const directionSets = keyedRecord(value.directionSets, MAX_DESIGN_REVISIONS_PER_PROJECT, parseDirectionSet);
  const runs = keyedRecord(value.runs, MAX_DESIGN_RUN_RECORDS, parseRun);
  if (!screens || !revisions || !directionSets || !runs) return undefined;
  const manifest: DesignProjectManifestV1 = {
    schema: 1,
    id: value.id,
    revision: value.revision,
    title,
    chatId: value.chatId,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    canvas: { viewport, nodes },
    screens,
    revisions,
    directionSets,
    runs,
  };
  return crossReferencesHold(manifest) ? manifest : undefined;
}
