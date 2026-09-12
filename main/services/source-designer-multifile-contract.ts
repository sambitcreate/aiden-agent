import { createHash } from "node:crypto";

export const SOURCE_DESIGNER_MULTIFILE_VERSION = 1 as const;
export const SOURCE_DESIGNER_MULTIFILE_MAX_FILES = 16;
export const SOURCE_DESIGNER_MULTIFILE_MAX_FILE_BYTES = 192 * 1024;
export const SOURCE_DESIGNER_MULTIFILE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const SOURCE_DESIGNER_MULTIFILE_JOURNAL_LIMIT = 32;

const MAX_ID_BYTES = 128;
const MAX_LABEL_BYTES = 160;
const SHA256 = /^[a-f0-9]{64}$/u;
const EFFECT_PHASES = new Set<SourceDesignerMultifileEffectPhase>([
  "pending",
  "write-intent",
  "verifying",
  "verified",
]);
const STAGES = new Set<SourceDesignerMultifileStage>([
  "prepared",
  "applying",
  "verifying",
  "committed",
  "rolling-back",
  "rolled-back",
  "undoing",
  "undone",
  "recoverable",
]);
const RECOVERY_KINDS = new Set<SourceDesignerMultifileRecoveryKind>([
  "stale-preimage",
  "stale-postimage",
  "apply-conflict",
  "rollback-conflict",
  "undo-conflict",
  "inspection-unavailable",
  "authority-revoked",
]);

export type SourceDesignerMultifileStage =
  | "prepared"
  | "applying"
  | "verifying"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "undoing"
  | "undone"
  | "recoverable";

export type SourceDesignerMultifileEffectPhase =
  | "pending"
  | "write-intent"
  | "verifying"
  | "verified";

export type SourceDesignerMultifileRecoveryKind =
  | "stale-preimage"
  | "stale-postimage"
  | "apply-conflict"
  | "rollback-conflict"
  | "undo-conflict"
  | "inspection-unavailable"
  | "authority-revoked";

export interface SourceDesignerMultifileByteImageV1 {
  sha256: string;
  byteSize: number;
  base64: string;
}

export interface SourceDesignerMultifileEffectV1 {
  effectId: string;
  phase: SourceDesignerMultifileEffectPhase;
}

export interface SourceDesignerMultifileFileV1 {
  path: string;
  before: SourceDesignerMultifileByteImageV1;
  after: SourceDesignerMultifileByteImageV1;
  apply: SourceDesignerMultifileEffectV1;
  rollback: SourceDesignerMultifileEffectV1;
  undo: SourceDesignerMultifileEffectV1;
}

export interface SourceDesignerMultifileConflictV1 {
  path: string;
  expectedSha256: string;
  observedSha256?: string;
  observedByteSize?: number;
  reason: string;
}

export interface SourceDesignerMultifileRecoveryV1 {
  kind: SourceDesignerMultifileRecoveryKind;
  conflicts: SourceDesignerMultifileConflictV1[];
}

export interface SourceDesignerMultifileRecordV1 {
  version: typeof SOURCE_DESIGNER_MULTIFILE_VERSION;
  actionId: string;
  workspaceId: string;
  projectId?: string;
  chatId?: string;
  projectRevision?: number;
  sourceNodeId?: string;
  sourceSelectionId?: string;
  sourceManifestHash?: string;
  sourcePath?: string;
  sourceStart?: number;
  sourceEnd?: number;
  sourceLineNumber?: number;
  sourceColumnNumber?: number;
  sourceComponentName?: string;
  sourceSelector?: string;
  sourceTagName?: string;
  sourceElementId?: string;
  sourceAfterManifestHash?: string;
  sourceAfterVersion?: string;
  sourceAfterStart?: number;
  sourceAfterEnd?: number;
  sourceAfterLineNumber?: number;
  sourceAfterColumnNumber?: number;
  rootFingerprint?: string;
  label: string;
  revision: number;
  stage: SourceDesignerMultifileStage;
  files: SourceDesignerMultifileFileV1[];
  recovery?: SourceDesignerMultifileRecoveryV1;
  createdAt: number;
  updatedAt: number;
}

export interface SourceDesignerMultifileJournalV1 {
  version: typeof SOURCE_DESIGNER_MULTIFILE_VERSION;
  actions: SourceDesignerMultifileRecordV1[];
}

export class SourceDesignerMultifileValidationError extends Error {
  readonly name = "SourceDesignerMultifileValidationError";
}

function fail(message: string): never {
  throw new SourceDesignerMultifileValidationError(message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} contains unsupported fields.`);
  }
}

function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(`${name} is invalid.`);
  }
  return value as number;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") fail(`${name} must be text.`);
  const text = value as string;
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > maximum ||
    text.includes("\0") ||
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code > 0 && code < 9) ||
        code === 11 ||
        code === 12 ||
        (code > 13 && code < 32) ||
        code === 127
      );
    })
  ) {
    fail(`${name} is invalid.`);
  }
  return text;
}

function safeId(value: unknown, name: string): string {
  const id = boundedText(value, name, MAX_ID_BYTES);
  if (id.normalize("NFKC") !== id || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    fail(`${name} is invalid.`);
  }
  return id;
}

export function parseSourceDesignerMultifilePath(value: unknown): string {
  const supplied = boundedText(value, "Designer Action path", 1_024);
  if (
    supplied.normalize("NFC") !== supplied ||
    supplied.includes("\\") ||
    supplied.startsWith("/") ||
    /^[A-Za-z]:/u.test(supplied)
  ) {
    fail("Designer Action path must be a canonical workspace-relative path.");
  }
  const segments = supplied.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.trim() !== segment,
    )
  ) {
    fail("Designer Action path must be a canonical workspace-relative path.");
  }
  return supplied;
}

export function sourceDesignerMultifilePathCollisionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function sourceDesignerMultifileComparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sourceDesignerMultifileSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sourceDesignerMultifileEffectId(
  actionId: string,
  operation: "apply" | "rollback" | "undo",
  path: string,
  beforeSha256: string,
  afterSha256: string,
): string {
  return createHash("sha256")
    .update("source-designer-multifile:v1\0")
    .update(actionId)
    .update("\0")
    .update(operation)
    .update("\0")
    .update(path)
    .update("\0")
    .update(beforeSha256)
    .update("\0")
    .update(afterSha256)
    .digest("hex");
}

export function createSourceDesignerMultifileImage(
  bytes: Uint8Array,
): SourceDesignerMultifileByteImageV1 {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > SOURCE_DESIGNER_MULTIFILE_MAX_FILE_BYTES
  ) {
    fail("Designer Action file bytes exceed the per-file limit.");
  }
  const copy = Buffer.from(bytes);
  return {
    sha256: sourceDesignerMultifileSha256(copy),
    byteSize: copy.byteLength,
    base64: copy.toString("base64"),
  };
}

export function decodeSourceDesignerMultifileImage(
  image: SourceDesignerMultifileByteImageV1,
): Buffer {
  const decoded = Buffer.from(image.base64, "base64");
  if (
    decoded.byteLength !== image.byteSize ||
    decoded.toString("base64") !== image.base64 ||
    sourceDesignerMultifileSha256(decoded) !== image.sha256
  ) {
    fail("Designer Action byte image does not match its digest.");
  }
  return decoded;
}

function parseImage(value: unknown, name: string): SourceDesignerMultifileByteImageV1 {
  const candidate = object(value, name);
  exact(candidate, ["sha256", "byteSize", "base64"], name);
  if (typeof candidate.sha256 !== "string" || !SHA256.test(candidate.sha256)) {
    fail(`${name} digest is invalid.`);
  }
  const byteSize = integer(
    candidate.byteSize,
    `${name} byte size`,
    SOURCE_DESIGNER_MULTIFILE_MAX_FILE_BYTES,
  );
  if (typeof candidate.base64 !== "string") fail(`${name} bytes are invalid.`);
  const image = { sha256: candidate.sha256, byteSize, base64: candidate.base64 };
  decodeSourceDesignerMultifileImage(image);
  return image;
}

function parseEffect(value: unknown, name: string): SourceDesignerMultifileEffectV1 {
  const candidate = object(value, name);
  exact(candidate, ["effectId", "phase"], name);
  if (typeof candidate.effectId !== "string" || !SHA256.test(candidate.effectId)) {
    fail(`${name} identity is invalid.`);
  }
  if (!EFFECT_PHASES.has(candidate.phase as SourceDesignerMultifileEffectPhase)) {
    fail(`${name} phase is invalid.`);
  }
  return {
    effectId: candidate.effectId,
    phase: candidate.phase as SourceDesignerMultifileEffectPhase,
  };
}

function parseFile(value: unknown, index: number): SourceDesignerMultifileFileV1 {
  const name = `Designer Action file ${index}`;
  const candidate = object(value, name);
  exact(candidate, ["path", "before", "after", "apply", "rollback", "undo"], name);
  return {
    path: parseSourceDesignerMultifilePath(candidate.path),
    before: parseImage(candidate.before, `${name} before image`),
    after: parseImage(candidate.after, `${name} after image`),
    apply: parseEffect(candidate.apply, `${name} apply effect`),
    rollback: parseEffect(candidate.rollback, `${name} rollback effect`),
    undo: parseEffect(candidate.undo, `${name} undo effect`),
  };
}

function parseConflict(value: unknown, index: number): SourceDesignerMultifileConflictV1 {
  const name = `Designer Action conflict ${index}`;
  const candidate = object(value, name);
  const keys = ["path", "expectedSha256", "reason"];
  if (candidate.observedSha256 !== undefined) keys.push("observedSha256");
  if (candidate.observedByteSize !== undefined) keys.push("observedByteSize");
  exact(candidate, keys, name);
  if (typeof candidate.expectedSha256 !== "string" || !SHA256.test(candidate.expectedSha256)) {
    fail(`${name} expected digest is invalid.`);
  }
  if (
    candidate.observedSha256 !== undefined &&
    (typeof candidate.observedSha256 !== "string" || !SHA256.test(candidate.observedSha256))
  ) {
    fail(`${name} observed digest is invalid.`);
  }
  return {
    path: parseSourceDesignerMultifilePath(candidate.path),
    expectedSha256: candidate.expectedSha256,
    ...(candidate.observedSha256 === undefined
      ? {}
      : { observedSha256: candidate.observedSha256 as string }),
    ...(candidate.observedByteSize === undefined
      ? {}
      : {
          observedByteSize: integer(
            candidate.observedByteSize,
            `${name} observed byte size`,
            SOURCE_DESIGNER_MULTIFILE_MAX_FILE_BYTES,
          ),
        }),
    reason: boundedText(candidate.reason, `${name} reason`, 160),
  };
}

function parseRecovery(value: unknown): SourceDesignerMultifileRecoveryV1 {
  const candidate = object(value, "Designer Action recovery");
  exact(candidate, ["kind", "conflicts"], "Designer Action recovery");
  if (!RECOVERY_KINDS.has(candidate.kind as SourceDesignerMultifileRecoveryKind)) {
    fail("Designer Action recovery kind is invalid.");
  }
  if (
    !Array.isArray(candidate.conflicts) ||
    candidate.conflicts.length < 1 ||
    candidate.conflicts.length > SOURCE_DESIGNER_MULTIFILE_MAX_FILES
  ) {
    fail("Designer Action recovery conflicts are invalid.");
  }
  return {
    kind: candidate.kind as SourceDesignerMultifileRecoveryKind,
    conflicts: candidate.conflicts.map(parseConflict),
  };
}

function assertFileSet(files: SourceDesignerMultifileFileV1[]): void {
  if (files.length < 1 || files.length > SOURCE_DESIGNER_MULTIFILE_MAX_FILES) {
    fail("Designer Action file count is invalid.");
  }
  let bytes = 0;
  const collisions = new Set<string>();
  let previous = "";
  for (const file of files) {
    bytes += file.before.byteSize + file.after.byteSize;
    const collision = sourceDesignerMultifilePathCollisionKey(file.path);
    if (collisions.has(collision)) fail("Designer Action paths collide by case or Unicode form.");
    collisions.add(collision);
    if (previous && sourceDesignerMultifileComparePaths(previous, file.path) >= 0) {
      fail("Designer Action files must use deterministic path order.");
    }
    previous = file.path;
  }
  if (bytes > SOURCE_DESIGNER_MULTIFILE_MAX_IMAGE_BYTES) {
    fail("Designer Action byte images exceed the transaction limit.");
  }
}

export function parseSourceDesignerMultifileRecord(
  value: unknown,
): SourceDesignerMultifileRecordV1 {
  const candidate = object(value, "Designer Action record");
  const keys = [
    "version",
    "actionId",
    "workspaceId",
    "label",
    "revision",
    "stage",
    "files",
    "createdAt",
    "updatedAt",
  ];
  if (candidate.projectId !== undefined) keys.push("projectId");
  if (candidate.chatId !== undefined) keys.push("chatId");
  if (candidate.projectRevision !== undefined) keys.push("projectRevision");
  if (candidate.sourceNodeId !== undefined) keys.push("sourceNodeId");
  if (candidate.sourceSelectionId !== undefined) keys.push("sourceSelectionId");
  if (candidate.sourceManifestHash !== undefined) keys.push("sourceManifestHash");
  if (candidate.sourcePath !== undefined) keys.push("sourcePath");
  if (candidate.sourceStart !== undefined) keys.push("sourceStart");
  if (candidate.sourceEnd !== undefined) keys.push("sourceEnd");
  if (candidate.sourceLineNumber !== undefined) keys.push("sourceLineNumber");
  if (candidate.sourceColumnNumber !== undefined) keys.push("sourceColumnNumber");
  if (candidate.sourceComponentName !== undefined) keys.push("sourceComponentName");
  if (candidate.sourceSelector !== undefined) keys.push("sourceSelector");
  if (candidate.sourceTagName !== undefined) keys.push("sourceTagName");
  if (candidate.sourceElementId !== undefined) keys.push("sourceElementId");
  if (candidate.sourceAfterManifestHash !== undefined) keys.push("sourceAfterManifestHash");
  if (candidate.sourceAfterVersion !== undefined) keys.push("sourceAfterVersion");
  if (candidate.sourceAfterStart !== undefined) keys.push("sourceAfterStart");
  if (candidate.sourceAfterEnd !== undefined) keys.push("sourceAfterEnd");
  if (candidate.sourceAfterLineNumber !== undefined) keys.push("sourceAfterLineNumber");
  if (candidate.sourceAfterColumnNumber !== undefined) keys.push("sourceAfterColumnNumber");
  if (candidate.rootFingerprint !== undefined) keys.push("rootFingerprint");
  if (candidate.recovery !== undefined) keys.push("recovery");
  exact(candidate, keys, "Designer Action record");
  if (candidate.version !== SOURCE_DESIGNER_MULTIFILE_VERSION) {
    fail("Designer Action version is unsupported.");
  }
  if (!STAGES.has(candidate.stage as SourceDesignerMultifileStage)) {
    fail("Designer Action stage is invalid.");
  }
  if (!Array.isArray(candidate.files)) fail("Designer Action files are invalid.");
  const files = candidate.files.map(parseFile);
  assertFileSet(files);
  const createdAt = integer(candidate.createdAt, "Designer Action creation time");
  const updatedAt = integer(candidate.updatedAt, "Designer Action update time");
  if (updatedAt < createdAt) fail("Designer Action timestamps are invalid.");
  const stage = candidate.stage as SourceDesignerMultifileStage;
  if (
    (stage === "recoverable" && candidate.recovery === undefined) ||
    (stage !== "recoverable" &&
      stage !== "rolling-back" &&
      stage !== "rolled-back" &&
      candidate.recovery !== undefined)
  ) {
    fail("Designer Action recovery details do not match its stage.");
  }
  const actionId = safeId(candidate.actionId, "Designer Action ID");
  for (const file of files) {
    if (
      file.apply.effectId !==
        sourceDesignerMultifileEffectId(
          actionId,
          "apply",
          file.path,
          file.before.sha256,
          file.after.sha256,
        ) ||
      file.rollback.effectId !==
        sourceDesignerMultifileEffectId(
          actionId,
          "rollback",
          file.path,
          file.after.sha256,
          file.before.sha256,
        ) ||
      file.undo.effectId !==
        sourceDesignerMultifileEffectId(
          actionId,
          "undo",
          file.path,
          file.after.sha256,
          file.before.sha256,
        )
    ) {
      fail("Designer Action effect identity does not match its exact byte images.");
    }
  }
  if (
    candidate.sourceStart !== undefined &&
    candidate.sourceEnd !== undefined &&
    (candidate.sourceEnd as number) <= (candidate.sourceStart as number)
  ) {
    fail("Designer Action source range is invalid.");
  }
  if (
    candidate.sourceAfterStart !== undefined &&
    candidate.sourceAfterEnd !== undefined &&
    (candidate.sourceAfterEnd as number) <= (candidate.sourceAfterStart as number)
  ) {
    fail("Designer Action postimage source range is invalid.");
  }
  return {
    version: SOURCE_DESIGNER_MULTIFILE_VERSION,
    actionId,
    workspaceId: safeId(candidate.workspaceId, "Designer Action workspace ID"),
    ...(candidate.projectId === undefined
      ? {}
      : { projectId: safeId(candidate.projectId, "Designer Action project ID") }),
    ...(candidate.chatId === undefined
      ? {}
      : { chatId: safeId(candidate.chatId, "Designer Action chat ID") }),
    ...(candidate.projectRevision === undefined
      ? {}
      : {
          projectRevision: integer(candidate.projectRevision, "Designer Action project revision"),
        }),
    ...(candidate.sourceNodeId === undefined
      ? {}
      : { sourceNodeId: safeId(candidate.sourceNodeId, "Designer Action source node ID") }),
    ...(candidate.sourceSelectionId === undefined
      ? {}
      : {
          sourceSelectionId: safeId(
            candidate.sourceSelectionId,
            "Designer Action source selection ID",
          ),
        }),
    ...(candidate.sourceManifestHash === undefined
      ? {}
      : {
          sourceManifestHash:
            typeof candidate.sourceManifestHash === "string" &&
            SHA256.test(candidate.sourceManifestHash)
              ? candidate.sourceManifestHash
              : fail("Designer Action source manifest hash is invalid."),
        }),
    ...(candidate.sourcePath === undefined
      ? {}
      : { sourcePath: parseSourceDesignerMultifilePath(candidate.sourcePath) }),
    ...(candidate.sourceStart === undefined
      ? {}
      : { sourceStart: integer(candidate.sourceStart, "Designer Action source start") }),
    ...(candidate.sourceEnd === undefined
      ? {}
      : { sourceEnd: integer(candidate.sourceEnd, "Designer Action source end") }),
    ...(candidate.sourceLineNumber === undefined
      ? {}
      : {
          sourceLineNumber: integer(candidate.sourceLineNumber, "Designer Action source line"),
        }),
    ...(candidate.sourceColumnNumber === undefined
      ? {}
      : {
          sourceColumnNumber: integer(
            candidate.sourceColumnNumber,
            "Designer Action source column",
          ),
        }),
    ...(candidate.sourceComponentName === undefined
      ? {}
      : {
          sourceComponentName: boundedText(
            candidate.sourceComponentName,
            "Designer Action source component",
            160,
          ),
        }),
    ...(candidate.sourceSelector === undefined
      ? {}
      : {
          sourceSelector: boundedText(
            candidate.sourceSelector,
            "Designer Action source selector",
            512,
          ),
        }),
    ...(candidate.sourceTagName === undefined
      ? {}
      : {
          sourceTagName: boundedText(candidate.sourceTagName, "Designer Action source tag", 160),
        }),
    ...(candidate.sourceElementId === undefined
      ? {}
      : {
          sourceElementId: boundedText(
            candidate.sourceElementId,
            "Designer Action source element",
            256,
          ),
        }),
    ...(candidate.sourceAfterManifestHash === undefined
      ? {}
      : {
          sourceAfterManifestHash:
            typeof candidate.sourceAfterManifestHash === "string" &&
            SHA256.test(candidate.sourceAfterManifestHash)
              ? candidate.sourceAfterManifestHash
              : fail("Designer Action postimage manifest hash is invalid."),
        }),
    ...(candidate.sourceAfterVersion === undefined
      ? {}
      : {
          sourceAfterVersion:
            typeof candidate.sourceAfterVersion === "string" &&
            SHA256.test(candidate.sourceAfterVersion)
              ? candidate.sourceAfterVersion
              : fail("Designer Action postimage source version is invalid."),
        }),
    ...(candidate.sourceAfterStart === undefined
      ? {}
      : {
          sourceAfterStart: integer(candidate.sourceAfterStart, "Designer Action postimage start"),
        }),
    ...(candidate.sourceAfterEnd === undefined
      ? {}
      : { sourceAfterEnd: integer(candidate.sourceAfterEnd, "Designer Action postimage end") }),
    ...(candidate.sourceAfterLineNumber === undefined
      ? {}
      : {
          sourceAfterLineNumber: integer(
            candidate.sourceAfterLineNumber,
            "Designer Action postimage line",
          ),
        }),
    ...(candidate.sourceAfterColumnNumber === undefined
      ? {}
      : {
          sourceAfterColumnNumber: integer(
            candidate.sourceAfterColumnNumber,
            "Designer Action postimage column",
          ),
        }),
    ...(candidate.rootFingerprint === undefined
      ? {}
      : {
          rootFingerprint:
            typeof candidate.rootFingerprint === "string" && SHA256.test(candidate.rootFingerprint)
              ? candidate.rootFingerprint
              : fail("workspace root fingerprint is invalid."),
        }),
    label: boundedText(candidate.label, "Designer Action label", MAX_LABEL_BYTES),
    revision: integer(candidate.revision, "Designer Action revision"),
    stage,
    files,
    ...(candidate.recovery === undefined ? {} : { recovery: parseRecovery(candidate.recovery) }),
    createdAt,
    updatedAt,
  };
}

export function parseSourceDesignerMultifileJournal(
  value: unknown,
): SourceDesignerMultifileJournalV1 {
  const candidate = object(value, "Designer Action journal");
  exact(candidate, ["version", "actions"], "Designer Action journal");
  if (candidate.version !== SOURCE_DESIGNER_MULTIFILE_VERSION) {
    fail("Designer Action journal version is unsupported.");
  }
  if (
    !Array.isArray(candidate.actions) ||
    candidate.actions.length > SOURCE_DESIGNER_MULTIFILE_JOURNAL_LIMIT
  ) {
    fail("Designer Action journal records are invalid.");
  }
  const actions = candidate.actions.map(parseSourceDesignerMultifileRecord);
  if (new Set(actions.map(({ actionId }) => actionId)).size !== actions.length) {
    fail("Designer Action journal IDs must be unique.");
  }
  return { version: SOURCE_DESIGNER_MULTIFILE_VERSION, actions };
}
