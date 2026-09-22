import { parseDesignElementSelection, type DesignElementSelectionV1 } from "./design-workspace";

export const SOURCE_DESIGNER_VERSION = 1 as const;
export const SOURCE_DESIGN_PICKER_COMMAND = "aiden:source-design-picker/v1" as const;
export const SOURCE_DESIGN_PICKER_SELECTION = "aiden:source-design-selection/v1" as const;
export const MAX_SOURCE_DESCRIPTOR_BYTES = 4 * 1024;
export const MAX_DESIGNER_REPLACEMENT_BYTES = 64 * 1024;

export interface SourcePreviewScriptV1 {
  id: string;
  label: string;
  command: string;
}

export type SourcePreviewStateV1 =
  | {
      version: typeof SOURCE_DESIGNER_VERSION;
      status: "unsupported";
      reason: string;
    }
  | {
      version: typeof SOURCE_DESIGNER_VERSION;
      status: "ready";
      scripts: SourcePreviewScriptV1[];
    }
  | {
      version: typeof SOURCE_DESIGNER_VERSION;
      status: "running";
      sessionId: string;
      script: SourcePreviewScriptV1;
      src: string;
      capability: string;
      logs: string[];
    }
  | {
      version: typeof SOURCE_DESIGNER_VERSION;
      status: "failed";
      reason: string;
      logs: string[];
    };

/** Untrusted context reported by the sandboxed local-app preview. */
export interface SourceElementDescriptorV1 {
  version: typeof SOURCE_DESIGNER_VERSION;
  selection: DesignElementSelectionV1;
  filePath?: string;
  lineNumber?: number;
  columnNumber?: number;
  componentName?: string;
  selectorMatchCount?: number;
}

/** Main-bound, hash-pinned authority for one exact JSX element range. */
export interface SourceSelectionBindingV1 {
  version: typeof SOURCE_DESIGNER_VERSION;
  id: string;
  projectId: string;
  sessionId: string;
  workspaceId: string;
  path: string;
  sourceVersion: string;
  start: number;
  end: number;
  lineNumber: number;
  columnNumber: number;
  snippet: string;
  selection: DesignElementSelectionV1;
}

export interface SourceDesignTurnContextV1 {
  version: typeof SOURCE_DESIGNER_VERSION;
  selectionId: string;
}

export type DesignerActionStatus = "pending" | "applied" | "rejected" | "undone" | "stale";

export interface DesignerActionV1 {
  version: typeof SOURCE_DESIGNER_VERSION;
  id: string;
  projectId: string;
  chatId: string;
  workspaceId: string;
  status: DesignerActionStatus;
  label: string;
  path: string;
  selectionLabel: string;
  before: string;
  after: string;
  createdAt: number;
  appliedAt?: number;
  message?: string;
}

export interface SourceDesignerMultifileActionViewV1 {
  version: 1;
  actionId: string;
  workspaceId: string;
  projectId: string;
  label: string;
  stage:
    | "prepared"
    | "applying"
    | "verifying"
    | "committed"
    | "rolling-back"
    | "rolled-back"
    | "undoing"
    | "undone"
    | "recoverable";
  files: Array<{
    path: string;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
  }>;
  recovery?: {
    kind: string;
    conflicts: Array<{ path: string; reason: string }>;
  };
  createdAt: number;
  updatedAt: number;
}

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function boundedText(value: unknown, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  if (value.includes("\0")) return undefined;
  return value;
}

function boundedInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10_000_000
    ? (value as number)
    : undefined;
}

export function parseSourceElementDescriptor(value: unknown): SourceElementDescriptorV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(
      record,
      new Set([
        "version",
        "selection",
        "filePath",
        "lineNumber",
        "columnNumber",
        "componentName",
        "selectorMatchCount",
      ]),
    ) ||
    record.version !== SOURCE_DESIGNER_VERSION
  ) {
    return undefined;
  }
  const selection = parseDesignElementSelection(record.selection);
  const filePath = boundedText(record.filePath, 4_096, true);
  const lineNumber = boundedInteger(record.lineNumber);
  const columnNumber = boundedInteger(record.columnNumber);
  const componentName = boundedText(record.componentName, 160, true);
  const selectorMatchCount = boundedInteger(record.selectorMatchCount);
  if (!selection) return undefined;
  if (
    (record.filePath !== undefined && !filePath) ||
    (record.lineNumber !== undefined && !lineNumber) ||
    (record.columnNumber !== undefined && !columnNumber) ||
    (record.componentName !== undefined && !componentName) ||
    (record.selectorMatchCount !== undefined && !selectorMatchCount)
  ) {
    return undefined;
  }
  const parsed: SourceElementDescriptorV1 = {
    version: SOURCE_DESIGNER_VERSION,
    selection,
    ...(filePath ? { filePath } : {}),
    ...(lineNumber ? { lineNumber } : {}),
    ...(columnNumber ? { columnNumber } : {}),
    ...(componentName ? { componentName } : {}),
    ...(selectorMatchCount ? { selectorMatchCount } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(parsed)).byteLength <= MAX_SOURCE_DESCRIPTOR_BYTES
    ? parsed
    : undefined;
}

export function parseSourceDesignTurnContext(value: unknown): SourceDesignTurnContextV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, new Set(["version", "selectionId"])) ||
    record.version !== SOURCE_DESIGNER_VERSION ||
    typeof record.selectionId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(record.selectionId)
  ) {
    return undefined;
  }
  return { version: SOURCE_DESIGNER_VERSION, selectionId: record.selectionId };
}
