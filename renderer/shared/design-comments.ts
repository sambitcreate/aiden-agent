export const DESIGN_COMMENT_VERSION = 1 as const;
export const MAX_DESIGN_COMMENT_BODY_CHARS = 4_000;
export const MAX_DESIGN_COMMENT_BODY_BYTES = 16 * 1024;
export const MAX_DESIGN_COMMENT_SELECTOR_CHARS = 512;
export const MAX_RENDERER_DESIGN_COMMENTS = 500;
export const MAX_RENDERER_DESIGN_COMMENT_VIEW_BYTES = 8 * 1024 * 1024;

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const SAFE_ID = /^[A-Za-z0-9._:@+-]{1,256}$/u;
const SAFE_HASH = /^[a-f0-9]{64}$/u;
const SAFE_TAG = /^[a-z][a-z0-9-]{0,31}$/u;
const SAFE_PATH_SEGMENT = /^(?!\.\.?$)[^/\\]+$/u;

export interface DesignCommentElementIdentityV1 {
  selector: string;
  selectorMatchCount: 1;
  tagName: string;
  elementId?: string;
}

export type DesignCommentSourceIdentityV1 =
  | { kind: "generated-artifact"; artifactId: string }
  | {
      kind: "connected-source";
      workspaceId: string;
      path: string;
      sourceVersion: string;
      start: number;
      end: number;
      preimageHash: string;
    };

export interface DesignCommentTargetV1 {
  projectId: string;
  lineageId: string;
  mediaId: string;
  element: DesignCommentElementIdentityV1;
  source: DesignCommentSourceIdentityV1;
}

export interface DesignCommentV1 {
  version: typeof DESIGN_COMMENT_VERSION;
  id: string;
  revision: number;
  target: DesignCommentTargetV1;
  body: string;
  status: "open" | "resolved";
  stale: boolean;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  staleAt?: number;
}

export interface DesignCommentProjectViewV1 {
  databaseRevision: number;
  comments: DesignCommentV1[];
}

const VIEW_KEYS = new Set(["databaseRevision", "comments"]);
const COMMENT_KEYS = new Set([
  "version",
  "id",
  "revision",
  "target",
  "body",
  "status",
  "stale",
  "createdAt",
  "updatedAt",
  "resolvedAt",
  "staleAt",
]);
const REQUIRED_COMMENT_KEYS = new Set([
  "version",
  "id",
  "revision",
  "target",
  "body",
  "status",
  "stale",
  "createdAt",
  "updatedAt",
]);
const TARGET_KEYS = new Set([
  "projectId",
  "lineageId",
  "mediaId",
  "element",
  "source",
]);
const ELEMENT_KEYS = new Set([
  "selector",
  "selectorMatchCount",
  "tagName",
  "elementId",
]);
const ELEMENT_REQUIRED_KEYS = new Set([
  "selector",
  "selectorMatchCount",
  "tagName",
]);
const GENERATED_SOURCE_KEYS = new Set(["kind", "artifactId"]);
const CONNECTED_SOURCE_KEYS = new Set([
  "kind",
  "workspaceId",
  "path",
  "sourceVersion",
  "start",
  "end",
  "preimageHash",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = allowed,
): boolean {
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    [...required].every((key) => key in value)
  );
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_ID.test(value) &&
    value.normalize("NFKC") === value
  );
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SAFE_HASH.test(value);
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function safeTimestamp(value: unknown): value is number {
  return safeInteger(value, 0) && value <= MAX_DATE_MILLISECONDS;
}

function safePlainText(
  value: unknown,
  maxChars: number,
  options: { trim?: boolean; multiline?: boolean } = {},
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > maxChars ||
    value.normalize("NFKC") !== value ||
    (options.trim && value.trim() !== value)
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 0x7f) return false;
    if (
      code <= 0x1f &&
      !(options.multiline && (code === 0x09 || code === 0x0a))
    )
      return false;
  }
  return true;
}

function safePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096)
    return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("//"))
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const segments = value.split("/");
  return (
    segments.length <= 64 &&
    segments.every((segment) => SAFE_PATH_SEGMENT.test(segment))
  );
}

export function parseDesignCommentDraft(value: unknown): string | undefined {
  if (
    !safePlainText(value, MAX_DESIGN_COMMENT_BODY_CHARS, {
      trim: true,
      multiline: true,
    })
  ) {
    return undefined;
  }
  return new TextEncoder().encode(value).byteLength <=
    MAX_DESIGN_COMMENT_BODY_BYTES
    ? value
    : undefined;
}

export function parseDesignCommentTarget(
  value: unknown,
): DesignCommentTargetV1 | undefined {
  const target = record(value);
  if (
    !target ||
    !exactKeys(target, TARGET_KEYS) ||
    !safeId(target.projectId) ||
    !safeId(target.lineageId) ||
    !safeId(target.mediaId)
  ) {
    return undefined;
  }
  const element = record(target.element);
  if (
    !element ||
    !exactKeys(element, ELEMENT_KEYS, ELEMENT_REQUIRED_KEYS) ||
    !safePlainText(element.selector, MAX_DESIGN_COMMENT_SELECTOR_CHARS, {
      trim: true,
    }) ||
    element.selectorMatchCount !== 1 ||
    !safePlainText(element.tagName, 32) ||
    !SAFE_TAG.test(element.tagName) ||
    (element.elementId !== undefined && !safeId(element.elementId))
  ) {
    return undefined;
  }
  const source = record(target.source);
  let parsedSource: DesignCommentSourceIdentityV1;
  if (source?.kind === "generated-artifact") {
    if (
      !exactKeys(source, GENERATED_SOURCE_KEYS) ||
      !safeHash(source.artifactId)
    )
      return undefined;
    parsedSource = {
      kind: "generated-artifact",
      artifactId: source.artifactId,
    };
  } else if (source?.kind === "connected-source") {
    if (
      !exactKeys(source, CONNECTED_SOURCE_KEYS) ||
      !safeId(source.workspaceId) ||
      !safePath(source.path) ||
      !safeHash(source.sourceVersion) ||
      !safeInteger(source.start, 0) ||
      !safeInteger(source.end, 1) ||
      source.end <= source.start ||
      source.end - source.start > 256 * 1024 ||
      !safeHash(source.preimageHash)
    ) {
      return undefined;
    }
    parsedSource = {
      kind: "connected-source",
      workspaceId: source.workspaceId,
      path: source.path,
      sourceVersion: source.sourceVersion,
      start: source.start,
      end: source.end,
      preimageHash: source.preimageHash,
    };
  } else {
    return undefined;
  }
  return {
    projectId: target.projectId,
    lineageId: target.lineageId,
    mediaId: target.mediaId,
    element: {
      selector: element.selector,
      selectorMatchCount: 1,
      tagName: element.tagName,
      ...(element.elementId === undefined
        ? {}
        : { elementId: element.elementId }),
    },
    source: parsedSource,
  };
}

function parseDesignComment(value: unknown): DesignCommentV1 | undefined {
  const comment = record(value);
  if (!comment || !exactKeys(comment, COMMENT_KEYS, REQUIRED_COMMENT_KEYS))
    return undefined;
  const target = parseDesignCommentTarget(comment.target);
  const body = parseDesignCommentDraft(comment.body);
  if (
    comment.version !== DESIGN_COMMENT_VERSION ||
    !safeId(comment.id) ||
    !safeInteger(comment.revision, 1) ||
    !target ||
    !body ||
    (comment.status !== "open" && comment.status !== "resolved") ||
    typeof comment.stale !== "boolean" ||
    !safeTimestamp(comment.createdAt) ||
    !safeTimestamp(comment.updatedAt) ||
    comment.updatedAt < comment.createdAt
  ) {
    return undefined;
  }
  const resolvedAt = comment.resolvedAt;
  const staleAt = comment.staleAt;
  if (
    (comment.status === "resolved"
      ? !safeTimestamp(resolvedAt) ||
        resolvedAt < comment.createdAt ||
        resolvedAt > comment.updatedAt
      : resolvedAt !== undefined) ||
    (comment.stale
      ? !safeTimestamp(staleAt) ||
        staleAt < comment.createdAt ||
        staleAt > comment.updatedAt
      : staleAt !== undefined)
  ) {
    return undefined;
  }
  return {
    version: DESIGN_COMMENT_VERSION,
    id: comment.id,
    revision: comment.revision,
    target,
    body,
    status: comment.status,
    stale: comment.stale,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    ...(resolvedAt === undefined ? {} : { resolvedAt: resolvedAt as number }),
    ...(staleAt === undefined ? {} : { staleAt: staleAt as number }),
  };
}

/** Fail-closed renderer boundary for main-owned comment projections. */
export function parseDesignCommentProjectView(
  value: unknown,
  expectedProjectId: string,
): DesignCommentProjectViewV1 | undefined {
  const view = record(value);
  if (
    !safeId(expectedProjectId) ||
    !view ||
    !exactKeys(view, VIEW_KEYS) ||
    !safeInteger(view.databaseRevision, 0) ||
    !Array.isArray(view.comments) ||
    view.comments.length > MAX_RENDERER_DESIGN_COMMENTS
  ) {
    return undefined;
  }
  const comments = view.comments.map(parseDesignComment);
  if (comments.some((comment) => !comment)) return undefined;
  const parsed = comments as DesignCommentV1[];
  if (
    new Set(parsed.map(({ id }) => id)).size !== parsed.length ||
    parsed.some(({ target }) => target.projectId !== expectedProjectId)
  )
    return undefined;
  const candidate = {
    databaseRevision: view.databaseRevision,
    comments: parsed,
  };
  return new TextEncoder().encode(JSON.stringify(candidate)).byteLength <=
    MAX_RENDERER_DESIGN_COMMENT_VIEW_BYTES
    ? candidate
    : undefined;
}

export function designCommentIsCurrent(
  comment: DesignCommentV1,
  currentTarget: DesignCommentTargetV1 | undefined,
): boolean {
  return Boolean(
    currentTarget &&
    !comment.stale &&
    JSON.stringify(comment.target) === JSON.stringify(currentTarget),
  );
}

export function designCommentDisplayOrder(
  comments: readonly DesignCommentV1[],
): DesignCommentV1[] {
  return [...comments].sort(
    (left, right) =>
      Number(left.status === "resolved") -
        Number(right.status === "resolved") ||
      Number(left.stale) - Number(right.stale) ||
      right.updatedAt - left.updatedAt ||
      left.id.localeCompare(right.id),
  );
}

export function designCommentTargetLabel(
  target: DesignCommentTargetV1,
): string {
  const element = target.element.elementId
    ? `${target.element.tagName}#${target.element.elementId}`
    : target.element.tagName;
  return target.source.kind === "connected-source"
    ? `${element} in ${target.source.path}`
    : `${element} on saved revision`;
}
