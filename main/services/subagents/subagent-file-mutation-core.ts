import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_SUBAGENT_FILE_CONTENT_BYTES = 200_000;
export const MAX_SUBAGENT_FILE_PATH_BYTES = 4_096;
export const MAX_SUBAGENT_FILE_PATH_COMPONENTS = 64;
export const MAX_SUBAGENT_FILE_COMPONENT_BYTES = 255;
export const MAX_SUBAGENT_FILE_LINES = 50_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const RESERVED_COMPONENT_PREFIX = ".aiden-subagent-file-";

export type SubagentFileExpectedRevision = "absent" | string;
export type SubagentFileMutationOperation = "write" | "edit";

export interface SubagentWorkspaceRootIdentity {
  canonicalPath: string;
  device: string;
  inode: string;
}

export interface PreparedSubagentFileMutation {
  readonly version: 1;
  readonly effectId: string;
  readonly effectDigest: string;
  readonly operation: SubagentFileMutationOperation;
  readonly workspaceRoot: Readonly<SubagentWorkspaceRootIdentity>;
  readonly relativePath: string;
  readonly expectedRevision: SubagentFileExpectedRevision;
  readonly postimage: Readonly<{
    content: string;
    sha256: string;
    bytes: number;
  }>;
}

export interface SubagentFileInspection {
  readonly version: 1;
  readonly effectId: string;
  readonly workspaceRoot: Readonly<SubagentWorkspaceRootIdentity>;
  readonly relativePath: string;
  readonly expectedRevision: SubagentFileExpectedRevision;
  readonly currentContent?: string;
}

export type SubagentFilePreparationFailure = "conflict" | "invalid_input" | "cancelled";

export class SubagentFilePreparationError extends Error {
  readonly name = "SubagentFilePreparationError";

  constructor(readonly failure: SubagentFilePreparationFailure) {
    super(
      failure === "conflict"
        ? "The workspace file changed and was preserved."
        : failure === "cancelled"
          ? "The workspace file operation was cancelled."
          : "The workspace file operation request is invalid.",
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SubagentFilePreparationError("cancelled");
}

function decimalIdentity(value: bigint): string {
  if (value < 0n) throw new SubagentFilePreparationError("invalid_input");
  return value.toString(10);
}

/** Pin the canonical workspace path to an exact decimal device/inode pair. */
export async function pinSubagentWorkspaceRoot(
  root: string,
  signal?: AbortSignal,
): Promise<Readonly<SubagentWorkspaceRootIdentity>> {
  throwIfAborted(signal);
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    root.includes("\0") ||
    Buffer.byteLength(root, "utf8") > MAX_SUBAGENT_FILE_PATH_BYTES
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  try {
    const canonicalPath = await fs.realpath(root);
    throwIfAborted(signal);
    const first = await fs.stat(canonicalPath, { bigint: true });
    const verifiedPath = await fs.realpath(root);
    const second = await fs.stat(verifiedPath, { bigint: true });
    throwIfAborted(signal);
    if (
      canonicalPath !== verifiedPath ||
      !first.isDirectory() ||
      !second.isDirectory() ||
      first.dev !== second.dev ||
      first.ino !== second.ino
    ) {
      throw new SubagentFilePreparationError("conflict");
    }
    return Object.freeze({
      canonicalPath,
      device: decimalIdentity(first.dev),
      inode: decimalIdentity(first.ino),
    });
  } catch (error) {
    if (error instanceof SubagentFilePreparationError) throw error;
    throw new SubagentFilePreparationError("conflict");
  }
}

function hasForbiddenControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}

export function canonicalSubagentFileRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value, "utf8") > MAX_SUBAGENT_FILE_PATH_BYTES ||
    path.posix.isAbsolute(value) ||
    hasForbiddenControl(value)
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const components = value.split("/");
  if (
    components.length === 0 ||
    components.length > MAX_SUBAGENT_FILE_PATH_COMPONENTS ||
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        component.startsWith(RESERVED_COMPONENT_PREFIX) ||
        Buffer.byteLength(component, "utf8") > MAX_SUBAGENT_FILE_COMPONENT_BYTES,
    )
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) throw new SubagentFilePreparationError("invalid_input");
  return normalized;
}

function exactSha256(value: string): string {
  if (!SHA256.test(value)) throw new SubagentFilePreparationError("invalid_input");
  return value;
}

function expectedRevision(value: SubagentFileExpectedRevision): SubagentFileExpectedRevision {
  return value === "absent" ? value : exactSha256(value);
}

export function canonicalSubagentFileEffectId(value: string): string {
  if (!EFFECT_ID.test(value)) throw new SubagentFilePreparationError("invalid_input");
  return value;
}

function boundedText(value: string): { content: string; buffer: Buffer } {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const buffer = Buffer.from(value, "utf8");
  if (
    buffer.byteLength > MAX_SUBAGENT_FILE_CONTENT_BYTES ||
    value.split("\n", MAX_SUBAGENT_FILE_LINES + 1).length > MAX_SUBAGENT_FILE_LINES
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  return { content: value, buffer };
}

function safeRootIdentity(
  value: Readonly<SubagentWorkspaceRootIdentity>,
): Readonly<SubagentWorkspaceRootIdentity> {
  if (
    typeof value !== "object" ||
    value === null ||
    !path.isAbsolute(value.canonicalPath) ||
    value.canonicalPath.includes("\0") ||
    Buffer.byteLength(value.canonicalPath, "utf8") > MAX_SUBAGENT_FILE_PATH_BYTES ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.device) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.inode)
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  return Object.freeze({ ...value });
}

function updateDigestField(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function effectDigest(input: {
  effectId: string;
  operation: SubagentFileMutationOperation;
  workspaceRoot: Readonly<SubagentWorkspaceRootIdentity>;
  relativePath: string;
  expectedRevision: SubagentFileExpectedRevision;
  content: string;
  postimageSha256: string;
  postimageBytes: number;
}): string {
  const hash = createHash("sha256");
  for (const field of [
    "aiden-subagent-file-effect-v1",
    input.effectId,
    input.operation,
    input.workspaceRoot.canonicalPath,
    input.workspaceRoot.device,
    input.workspaceRoot.inode,
    input.relativePath,
    input.expectedRevision,
    input.postimageSha256,
    String(input.postimageBytes),
    input.content,
  ]) {
    updateDigestField(hash, field);
  }
  return hash.digest("hex");
}

export interface PrepareSubagentFileWriteInput {
  inspection: Readonly<SubagentFileInspection>;
  content: string;
}

export interface PrepareSubagentFileEditInput {
  inspection: Readonly<SubagentFileInspection>;
  oldString: string;
  newString: string;
}

export interface SubagentFileMutationPreparerOptions {
  allocateEffectId?: () => string;
}

/** Recompute every immutable binding before it crosses into the native helper. */
export function assertPreparedSubagentFileMutation(
  value: PreparedSubagentFileMutation,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.version !== 1 ||
    !EFFECT_ID.test(value.effectId) ||
    !SHA256.test(value.effectDigest) ||
    (value.operation !== "write" && value.operation !== "edit")
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const workspaceRoot = safeRootIdentity(value.workspaceRoot);
  const relativePath = canonicalSubagentFileRelativePath(value.relativePath);
  const revision = expectedRevision(value.expectedRevision);
  if (value.operation === "edit" && revision === "absent") {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const postimage = boundedText(value.postimage.content);
  const sha256 = createHash("sha256").update(postimage.buffer).digest("hex");
  if (
    value.postimage.sha256 !== sha256 ||
    value.postimage.bytes !== postimage.buffer.byteLength ||
    value.effectDigest !==
      effectDigest({
        effectId: value.effectId,
        operation: value.operation,
        workspaceRoot,
        relativePath,
        expectedRevision: revision,
        content: postimage.content,
        postimageSha256: sha256,
        postimageBytes: postimage.buffer.byteLength,
      })
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
}

export function assertSubagentFileInspection(
  value: Readonly<SubagentFileInspection>,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.version !== 1 ||
    canonicalSubagentFileEffectId(value.effectId) !== value.effectId
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  safeRootIdentity(value.workspaceRoot);
  canonicalSubagentFileRelativePath(value.relativePath);
  const revision = expectedRevision(value.expectedRevision);
  if (revision === "absent") {
    if (value.currentContent !== undefined) {
      throw new SubagentFilePreparationError("invalid_input");
    }
    return;
  }
  if (value.currentContent === undefined) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const current = boundedText(value.currentContent);
  if (createHash("sha256").update(current.buffer).digest("hex") !== revision) {
    throw new SubagentFilePreparationError("invalid_input");
  }
}

export class SubagentFileMutationPreparer {
  private readonly allocateEffectId: () => string;

  constructor(options: SubagentFileMutationPreparerOptions = {}) {
    this.allocateEffectId = options.allocateEffectId ?? (() => `effect-${randomUUID()}`);
  }

  createEffectId(): string {
    return canonicalSubagentFileEffectId(this.allocateEffectId());
  }

  prepareWrite(input: PrepareSubagentFileWriteInput): PreparedSubagentFileMutation {
    return this.prepare("write", input);
  }

  prepareEdit(input: PrepareSubagentFileEditInput): PreparedSubagentFileMutation {
    assertSubagentFileInspection(input.inspection);
    if (
      input.inspection.expectedRevision === "absent" ||
      input.inspection.currentContent === undefined
    ) {
      throw new SubagentFilePreparationError("conflict");
    }
    const current = boundedText(input.inspection.currentContent);
    const oldValue = boundedText(input.oldString).content;
    const newValue = boundedText(input.newString).content;
    if (oldValue.length === 0) throw new SubagentFilePreparationError("invalid_input");
    const first = current.content.indexOf(oldValue);
    if (first < 0 || current.content.indexOf(oldValue, first + 1) >= 0) {
      throw new SubagentFilePreparationError("conflict");
    }
    const content = `${current.content.slice(0, first)}${newValue}${current.content.slice(
      first + oldValue.length,
    )}`;
    return this.prepare("edit", {
      inspection: input.inspection,
      content,
    });
  }

  private prepare(
    operation: SubagentFileMutationOperation,
    input: PrepareSubagentFileWriteInput,
  ): PreparedSubagentFileMutation {
    assertSubagentFileInspection(input.inspection);
    const effectId = canonicalSubagentFileEffectId(input.inspection.effectId);
    const workspaceRoot = safeRootIdentity(input.inspection.workspaceRoot);
    const relativePath = canonicalSubagentFileRelativePath(input.inspection.relativePath);
    const revision = expectedRevision(input.inspection.expectedRevision);
    const postimage = boundedText(input.content);
    const sha256 = createHash("sha256").update(postimage.buffer).digest("hex");
    const frozenPostimage = Object.freeze({
      content: postimage.content,
      sha256,
      bytes: postimage.buffer.byteLength,
    });
    return Object.freeze({
      version: 1 as const,
      effectId,
      effectDigest: effectDigest({
        effectId,
        operation,
        workspaceRoot,
        relativePath,
        expectedRevision: revision,
        content: postimage.content,
        postimageSha256: sha256,
        postimageBytes: postimage.buffer.byteLength,
      }),
      operation,
      workspaceRoot,
      relativePath,
      expectedRevision: revision,
      postimage: frozenPostimage,
    });
  }
}
