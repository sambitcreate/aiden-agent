export const DESIGN_COMMENT_DATABASE_VERSION = 1 as const;
export const DESIGN_COMMENT_VERSION = 1 as const;

export const MAX_DESIGN_COMMENTS = 5_000;
export const MAX_DESIGN_COMMENTS_PER_PROJECT = 500;
export const MAX_DESIGN_COMMENT_BODY_CHARS = 4_000;
export const MAX_DESIGN_COMMENT_BODY_BYTES = 16 * 1024;
export const MAX_DESIGN_COMMENT_SELECTOR_CHARS = 512;
export const MAX_DESIGN_COMMENT_STORE_BYTES = 8 * 1024 * 1024;

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
  | {
      kind: "generated-artifact";
      artifactId: string;
    }
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
  /** Immutable generated artifact or immutable connected-source capture identity. */
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

export interface DesignCommentDatabaseV1 {
  version: typeof DESIGN_COMMENT_DATABASE_VERSION;
  revision: number;
  comments: DesignCommentV1[];
}

const DATABASE_KEYS = new Set(["version", "revision", "comments"]);
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

export function isDesignCommentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_ID.test(value) &&
    value.normalize("NFKC") === value
  );
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SAFE_HASH.test(value);
}

function safeTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_DATE_MILLISECONDS
  );
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function safeOffset(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 10_000_000
  );
}

function safePlainText(
  value: unknown,
  maxChars: number,
  multiline = false,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > maxChars ||
    value.trim() !== value ||
    value.normalize("NFKC") !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 0x7f) return false;
    if (code <= 0x1f && !(multiline && (code === 0x09 || code === 0x0a)))
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

export function parseDesignCommentBody(value: unknown): string | undefined {
  if (!safePlainText(value, MAX_DESIGN_COMMENT_BODY_CHARS, true))
    return undefined;
  return Buffer.byteLength(value, "utf8") <= MAX_DESIGN_COMMENT_BODY_BYTES
    ? value
    : undefined;
}

export function parseDesignCommentTarget(
  value: unknown,
): DesignCommentTargetV1 | undefined {
  const target = record(value);
  if (!target || !exactKeys(target, TARGET_KEYS)) return undefined;
  if (
    !isDesignCommentId(target.projectId) ||
    !isDesignCommentId(target.lineageId) ||
    !isDesignCommentId(target.mediaId)
  ) {
    return undefined;
  }

  const element = record(target.element);
  if (!element || !exactKeys(element, ELEMENT_KEYS, ELEMENT_REQUIRED_KEYS))
    return undefined;
  if (
    !safePlainText(element.selector, MAX_DESIGN_COMMENT_SELECTOR_CHARS) ||
    element.selectorMatchCount !== 1 ||
    !safePlainText(element.tagName, 32) ||
    !SAFE_TAG.test(element.tagName) ||
    (element.elementId !== undefined &&
      (!safePlainText(element.elementId, 120) ||
        !SAFE_ID.test(element.elementId)))
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
      !isDesignCommentId(source.workspaceId) ||
      !safePath(source.path) ||
      !safeHash(source.sourceVersion) ||
      !safeOffset(source.start) ||
      !safeOffset(source.end) ||
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

export function parseDesignComment(
  value: unknown,
): DesignCommentV1 | undefined {
  const comment = record(value);
  if (!comment || !exactKeys(comment, COMMENT_KEYS, REQUIRED_COMMENT_KEYS))
    return undefined;
  const target = parseDesignCommentTarget(comment.target);
  const body = parseDesignCommentBody(comment.body);
  if (
    comment.version !== DESIGN_COMMENT_VERSION ||
    !isDesignCommentId(comment.id) ||
    !safePositiveInteger(comment.revision) ||
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

export function emptyDesignCommentDatabase(): DesignCommentDatabaseV1 {
  return {
    version: DESIGN_COMMENT_DATABASE_VERSION,
    revision: 0,
    comments: [],
  };
}

export function parseDesignCommentDatabase(
  value: unknown,
): DesignCommentDatabaseV1 | undefined {
  const database = record(value);
  if (
    !database ||
    !exactKeys(database, DATABASE_KEYS) ||
    database.version !== DESIGN_COMMENT_DATABASE_VERSION ||
    !Number.isSafeInteger(database.revision) ||
    (database.revision as number) < 0 ||
    !Array.isArray(database.comments) ||
    database.comments.length > MAX_DESIGN_COMMENTS
  ) {
    return undefined;
  }
  const comments = database.comments.map(parseDesignComment);
  if (comments.some((comment) => !comment)) return undefined;
  const parsed = comments as DesignCommentV1[];
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length)
    return undefined;
  const perProject = new Map<string, number>();
  for (const comment of parsed) {
    const count = (perProject.get(comment.target.projectId) ?? 0) + 1;
    if (count > MAX_DESIGN_COMMENTS_PER_PROJECT) return undefined;
    perProject.set(comment.target.projectId, count);
  }
  const candidate = {
    version: DESIGN_COMMENT_DATABASE_VERSION,
    revision: database.revision as number,
    comments: parsed,
  } satisfies DesignCommentDatabaseV1;
  return Buffer.byteLength(JSON.stringify(candidate), "utf8") <=
    MAX_DESIGN_COMMENT_STORE_BYTES
    ? candidate
    : undefined;
}

export function designCommentTargetMatches(
  target: DesignCommentTargetV1,
  current: DesignCommentTargetV1,
): boolean {
  return JSON.stringify(target) === JSON.stringify(current);
}

export function designCommentElementMatches(
  target: DesignCommentTargetV1,
  current: DesignCommentTargetV1,
): boolean {
  return JSON.stringify(target.element) === JSON.stringify(current.element);
}
