// Exact-shape parsers for designProjects:* payloads. Provider, model and
// thinking level go through parseParams, the chat:start rules.
import { MAX_DESIGN_PROMPT_CHARS } from "../../../renderer/shared/design/limits.js";
import type { DesignProjectOp, DesignRunStartRequest } from "../../../renderer/shared/design/types.js";
import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";
import { hasExactKeys, isRecord } from "../../shared/guards.js";
import {
  isDesignId,
  parseDesignContextChips,
  parseDesignProjectOp,
  parseDesignRunRequest,
  parseDesignTitle,
} from "../../services/design/ops-parse.js";
import { parseParams } from "../chat-params.js";

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, required, optional)) throw new Error("Invalid Design request.");
  return value;
}

function designId(value: unknown, label: string): string {
  if (!isDesignId(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function projectRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid project revision.");
  }
  return value;
}

export function parseDesignListRequest(value: unknown): void {
  if (value !== undefined) exact(value, []);
}

export function parseDesignProjectRequest(value: unknown): { projectId: string } {
  return { projectId: designId(exact(value, ["projectId"]).projectId, "project") };
}

export function parseDesignCreateRequest(value: unknown): { title?: string } {
  const request = exact(value ?? {}, [], ["title"]);
  if (request.title === undefined) return {};
  const title = parseDesignTitle(request.title);
  if (title === undefined) throw new Error("Invalid project title.");
  return { title };
}

export function parseDesignMutateRequest(value: unknown): {
  projectId: string;
  expectedRevision: number;
  op: DesignProjectOp;
} {
  const request = exact(value, ["projectId", "expectedRevision", "op"]);
  const projectId = designId(request.projectId, "project");
  const expectedRevision = projectRevision(request.expectedRevision);
  const op = parseDesignProjectOp(request.op);
  if (!op) throw new Error("Invalid project change.");
  return { projectId, expectedRevision, op };
}

/**
 * A healthy project is deleted against its revision. An unreadable project has no
 * readable revision, so the renderer sends `unreadable: true` after the unknown-contents preview.
 */
export type DesignDeleteRequest =
  | { projectId: string; expectedRevision: number; unreadable?: undefined }
  | { projectId: string; unreadable: true; expectedRevision?: undefined };

export function parseDesignDeleteRequest(value: unknown): DesignDeleteRequest {
  const request = exact(value, ["projectId"], ["expectedRevision", "unreadable"]);
  const projectId = designId(request.projectId, "project");
  if (request.unreadable === true && request.expectedRevision === undefined) {
    return { projectId, unreadable: true };
  }
  if (request.unreadable !== undefined) throw new Error("Invalid project delete.");
  return { projectId, expectedRevision: projectRevision(request.expectedRevision) };
}

export function parseDesignRunStartRequest(value: unknown): DesignRunStartRequest {
  const request = exact(
    value,
    ["projectId", "streamId", "request", "prompt", "chips"],
    ["providerId", "model", "thinkingLevel"],
  );
  const projectId = designId(request.projectId, "project");
  if (!isSafeSubagentIdentifier(request.streamId)) throw new Error("Invalid design stream identifier.");
  const run = parseDesignRunRequest(request.request);
  if (!run) throw new Error("Invalid design run.");
  const chips = parseDesignContextChips(request.chips);
  if (!chips) throw new Error("Invalid design selection.");
  // A Resume repeats the resumed run's brief, so it must not carry one of its own.
  const resume = run.op === "explore" && run.resumeRunId !== undefined;
  if (
    typeof request.prompt !== "string" ||
    request.prompt.length > MAX_DESIGN_PROMPT_CHARS ||
    (resume ? request.prompt.length > 0 : request.prompt.trim().length === 0)
  ) {
    throw new Error("Invalid design prompt.");
  }
  const parsed = { projectId, streamId: request.streamId, request: run, prompt: request.prompt, chips };
  if (request.providerId === undefined && request.model === undefined) {
    // Only a Resume may leave the model out; the run service defaults it to the set's model.
    if (!resume || request.thinkingLevel !== undefined) throw new Error("Invalid provider id.");
    return parsed;
  }
  // The same provider, model and thinking-level rules as chat:start.
  const selection = parseParams({
    chatId: projectId,
    providerId: request.providerId,
    model: request.model,
    ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
  });
  return {
    ...parsed,
    providerId: selection.providerId,
    model: selection.model,
    ...(selection.thinkingLevel === undefined ? {} : { thinkingLevel: selection.thinkingLevel }),
  };
}

export function parseDesignRevisionRequest(value: unknown): { projectId: string; revisionId: string } {
  const request = exact(value, ["projectId", "revisionId"]);
  return { projectId: designId(request.projectId, "project"), revisionId: designId(request.revisionId, "revision") };
}

export function parseDesignPreviewRequest(value: unknown): { projectId: string; revisionId: string; theme?: unknown } {
  const request = exact(value, ["projectId", "revisionId"], ["theme"]);
  return {
    projectId: designId(request.projectId, "project"),
    revisionId: designId(request.revisionId, "revision"),
    // parseGenerativeUiTheme accepts only known tokens and hex colors; anything else falls back.
    ...(request.theme === undefined ? {} : { theme: request.theme }),
  };
}
