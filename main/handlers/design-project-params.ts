import { isDesignProjectOpaqueId } from "../services/design-project-contract.js";

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Design Project request.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    [...required].some((key) => !(key in record))
  ) {
    throw new Error("Invalid Design Project request.");
  }
  return record;
}

function opaqueId(value: unknown): string {
  if (!isDesignProjectOpaqueId(value)) throw new Error("Invalid Design Project identity.");
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Invalid Design Project revision.");
  }
  return value as number;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function parseDesignProjectCreateParams(value: unknown): Record<string, never> {
  exactRecord(value, new Set());
  return {};
}

export function parseDesignProjectConnectParams(value: unknown): {
  projectId: string;
  expectedRevision: number;
  workspaceId: string;
} {
  const input = exactRecord(value, new Set(["projectId", "expectedRevision", "workspaceId"]));
  return {
    projectId: opaqueId(input.projectId),
    expectedRevision: revision(input.expectedRevision),
    workspaceId: opaqueId(input.workspaceId),
  };
}

export function parseDesignProjectPreflightParams(value: unknown): { projectId: string } {
  const input = exactRecord(value, new Set(["projectId"]));
  return { projectId: opaqueId(input.projectId) };
}

/**
 * Renderer-authored canvas persistence cannot carry relationship authority.
 * A workspace binding may only be created by designer:connectProject.
 */
export function parseDesignProjectContentUpdateEnvelope(value: unknown): Record<string, unknown> {
  return exactRecord(value, new Set(["id", "expectedRevision", "canvas"]));
}

export function parseDesignProjectPreviewParams(value: unknown): { projectId: string } {
  return parseDesignProjectPreflightParams(value);
}

export function parseDesignProjectStartPreviewParams(value: unknown): {
  projectId: string;
  scriptId: string;
} {
  const input = exactRecord(value, new Set(["projectId", "scriptId"]));
  return {
    projectId: opaqueId(input.projectId),
    scriptId: boundedString(input.scriptId, "preview script", 120),
  };
}

export function parseDesignProjectBindSelectionParams(value: unknown): {
  projectId: string;
  sessionId: string;
  descriptor: unknown;
} {
  const input = exactRecord(value, new Set(["projectId", "sessionId", "descriptor"]));
  return {
    projectId: opaqueId(input.projectId),
    sessionId: boundedString(input.sessionId, "preview session", 256),
    descriptor: input.descriptor,
  };
}

export function parseDesignProjectActionParams(value: unknown): {
  projectId: string;
  actionId: string;
} {
  const input = exactRecord(value, new Set(["projectId", "actionId"]));
  return {
    projectId: opaqueId(input.projectId),
    actionId: boundedString(input.actionId, "Designer Action", 256),
  };
}
