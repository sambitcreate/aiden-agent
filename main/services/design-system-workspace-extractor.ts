import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DESIGN_SYSTEM_MAX_INPUT_BYTES,
  DESIGN_SYSTEM_MAX_SOURCES,
  createDesignSystemAttachment,
  type DesignSystemAuthorizedSource,
  type DesignSystemComponentInput,
  type DesignSystemIconInput,
  type DesignSystemIndexInputV1,
  type DesignSystemTypographyTokenInput,
  type DesignSystemValueTokenInput,
} from "./design-system-snapshot-core.js";
import { decodeUtf8 } from "./regular-file-read.js";
import { createSubagentFileMutatorClient } from "./subagents/subagent-file-mutator-io.js";

export const DESIGN_SYSTEM_SOURCE_MAX_BYTES = 256 * 1024;
export const DESIGN_SYSTEM_SOURCE_TOTAL_MAX_BYTES = 512 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/u;
const TOKEN_DOCUMENT_KEYS = new Set(["version", "kind", "tokens"]);
const TOKEN_GROUP_KEYS = new Set(["colors", "spacing", "typography", "radii", "shadows"]);
const VALUE_TOKEN_KEYS = new Set(["name", "value"]);
const TYPOGRAPHY_TOKEN_KEYS = new Set([
  "name",
  "families",
  "size",
  "lineHeight",
  "weight",
  "letterSpacing",
]);
const CATALOG_DOCUMENT_KEYS = new Set(["version", "kind", "components", "icons"]);
const COMPONENT_KEYS = new Set(["name", "description", "reviewed", "variants", "states"]);
const ICON_KEYS = new Set(["name", "label", "style", "tags"]);

export type ReviewedDesignSystemDocumentKind = "tokens-v1" | "catalog-v1";

export interface DesignSystemWorkspaceAuthority {
  /** Canonical absolute path selected through Aiden's workspace picker. */
  rootPath: string;
  /** Decimal strings preserve the platform's full stat width. */
  device: string;
  inode: string;
}

export interface ReviewedDesignSystemSourceSelection {
  sourceId: string;
  workspaceRelativePath: string;
  kind: ReviewedDesignSystemDocumentKind;
  reviewed: true;
}

export interface ExtractReviewedDesignSystemInput {
  name: string;
  authority: DesignSystemWorkspaceAuthority;
  sources: ReviewedDesignSystemSourceSelection[];
}

export interface DesignSystemWorkspaceExtractorObserver {
  beforeFileOpen?(workspaceRelativePath: string): Promise<void> | void;
  beforeFinalVerification?(workspaceRelativePath: string): Promise<void> | void;
}

export interface DesignSystemWorkspaceExtractorOptions {
  signal?: AbortSignal;
  /** Race-test seam; production callers leave this undefined. */
  observer?: DesignSystemWorkspaceExtractorObserver;
}

export class DesignSystemWorkspaceExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignSystemWorkspaceExtractionError";
  }
}

function fail(message: string): never {
  throw new DesignSystemWorkspaceExtractionError(message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw (
      signal.reason ?? new DesignSystemWorkspaceExtractionError("Design-system indexing stopped.")
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).length === keys.size && hasOnlyKeys(value, keys);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function requireRecordWithKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, allowed) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail(`${label} has an invalid shape.`);
  }
  return value;
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    fail("A reviewed design-system path is invalid.");
  }
  if (
    value.normalize("NFKC") !== value ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    containsControlCharacter(value)
  ) {
    fail("Reviewed design-system sources must use normalized workspace-relative paths.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("Reviewed design-system sources must not traverse the workspace.");
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseSelection(value: unknown): ReviewedDesignSystemSourceSelection {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, new Set(["sourceId", "workspaceRelativePath", "kind", "reviewed"])) ||
    typeof value.sourceId !== "string" ||
    !SAFE_ID.test(value.sourceId) ||
    (value.kind !== "tokens-v1" && value.kind !== "catalog-v1") ||
    value.reviewed !== true
  ) {
    fail("Design-system source selections must be explicitly reviewed and use schema version 1.");
  }
  return {
    sourceId: value.sourceId,
    workspaceRelativePath: normalizeRelativePath(value.workspaceRelativePath),
    kind: value.kind,
    reviewed: true,
  };
}

async function verifyWorkspaceRoot(authority: DesignSystemWorkspaceAuthority): Promise<string> {
  if (
    typeof authority.rootPath !== "string" ||
    !path.isAbsolute(authority.rootPath) ||
    !/^\d+$/u.test(authority.device) ||
    !/^\d+$/u.test(authority.inode)
  ) {
    fail("The authorized design-system workspace identity is invalid.");
  }
  const lexicalRoot = path.resolve(authority.rootPath);
  const [linkInfo, canonicalRoot, identity] = await Promise.all([
    fs.lstat(lexicalRoot, { bigint: true }),
    fs.realpath(lexicalRoot),
    fs.stat(lexicalRoot, { bigint: true }),
  ]).catch(() => fail("The authorized design-system workspace is unavailable."));
  if (
    linkInfo.isSymbolicLink() ||
    !identity.isDirectory() ||
    canonicalRoot !== lexicalRoot ||
    identity.dev.toString() !== authority.device ||
    identity.ino.toString() !== authority.inode
  ) {
    fail("The authorized design-system workspace changed after it was confirmed.");
  }
  return canonicalRoot;
}

/** Diagnostics only. The native descriptor-relative read below remains the authority. */
async function diagnoseLexicalSource(root: string, relativePath: string): Promise<void> {
  let current = root;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) fail("Design-system source paths must not contain symlinks.");
    if (index < segments.length - 1 && !info.isDirectory()) {
      fail("A design-system source parent is not a directory.");
    }
    if (index === segments.length - 1) {
      if (!info.isFile()) fail("Design-system sources must be regular files.");
      if (info.size < 1 || info.size > DESIGN_SYSTEM_SOURCE_MAX_BYTES) {
        fail("Reviewed design-system sources must be bounded, non-empty regular files.");
      }
    }
  }
}

async function descriptorRelativeRead(
  authority: DesignSystemWorkspaceAuthority,
  relativePath: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const client = createSubagentFileMutatorClient({
    workspaceRoot: {
      canonicalPath: authority.rootPath,
      device: authority.device,
      inode: authority.inode,
    },
  });
  try {
    const content = await client.readHtml(requestId, relativePath, signal);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > DESIGN_SYSTEM_SOURCE_MAX_BYTES) {
      fail("Reviewed design-system sources must be bounded, non-empty regular files.");
    }
    return bytes;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    fail(
      "A reviewed design-system source changed before it opened or changed while it was being read.",
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function readVerifiedSource(
  authority: DesignSystemWorkspaceAuthority,
  canonicalRoot: string,
  relativePath: string,
  options: DesignSystemWorkspaceExtractorOptions,
): Promise<Buffer> {
  throwIfAborted(options.signal);
  if ((await verifyWorkspaceRoot(authority)) !== canonicalRoot) {
    fail("The authorized design-system workspace changed after it was confirmed.");
  }
  await diagnoseLexicalSource(canonicalRoot, relativePath);
  await options.observer?.beforeFileOpen?.(relativePath);
  throwIfAborted(options.signal);
  const requestBase = createHash("sha256").update(relativePath, "utf8").digest("hex").slice(0, 32);
  const initial = await descriptorRelativeRead(
    authority,
    relativePath,
    `ds-first-${requestBase}`,
    options.signal,
  );
  await options.observer?.beforeFinalVerification?.(relativePath);
  throwIfAborted(options.signal);
  const verified = await descriptorRelativeRead(
    authority,
    relativePath,
    `ds-final-${requestBase}`,
    options.signal,
  );
  if (!initial.equals(verified)) {
    fail("A reviewed design-system source changed while it was being read.");
  }
  return initial;
}

function parseJsonDocument(bytes: Buffer): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    fail("Reviewed design-system documents must be valid UTF-8 JSON.");
  }
}

function valueTokens(
  value: unknown,
  sourceId: string,
  label: string,
): DesignSystemValueTokenInput[] {
  return requireArray(value, label).map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, VALUE_TOKEN_KEYS) ||
      typeof entry.name !== "string" ||
      typeof entry.value !== "string"
    ) {
      fail(`${label} entries must contain only name and value.`);
    }
    return { name: entry.name, value: entry.value, sourceId };
  });
}

function typographyTokens(value: unknown, sourceId: string): DesignSystemTypographyTokenInput[] {
  return requireArray(value, "Typography tokens").map((entry) => {
    const record = requireRecordWithKeys(
      entry,
      TYPOGRAPHY_TOKEN_KEYS,
      ["name", "families", "size", "lineHeight", "weight"],
      "Typography token",
    );
    if (
      typeof record.name !== "string" ||
      !Array.isArray(record.families) ||
      !record.families.every((family) => typeof family === "string") ||
      typeof record.size !== "string" ||
      typeof record.lineHeight !== "string" ||
      typeof record.weight !== "number" ||
      (record.letterSpacing !== undefined && typeof record.letterSpacing !== "string")
    ) {
      fail("Typography token values have an invalid shape.");
    }
    return {
      name: record.name,
      families: record.families,
      size: record.size,
      lineHeight: record.lineHeight,
      weight: record.weight,
      ...(record.letterSpacing === undefined ? {} : { letterSpacing: record.letterSpacing }),
      sourceId,
    };
  });
}

function parseTokenDocument(value: unknown, sourceId: string) {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, TOKEN_DOCUMENT_KEYS) ||
    value.version !== 1 ||
    value.kind !== "tokens" ||
    !isPlainRecord(value.tokens) ||
    !hasExactKeys(value.tokens, TOKEN_GROUP_KEYS)
  ) {
    fail("A tokens-v1 source must be an exact version 1 static token document.");
  }
  return {
    colors: valueTokens(value.tokens.colors, sourceId, "Color tokens"),
    spacing: valueTokens(value.tokens.spacing, sourceId, "Spacing tokens"),
    typography: typographyTokens(value.tokens.typography, sourceId),
    radii: valueTokens(value.tokens.radii, sourceId, "Radius tokens"),
    shadows: valueTokens(value.tokens.shadows, sourceId, "Shadow tokens"),
  };
}

function parseCatalogDocument(
  value: unknown,
  sourceId: string,
): { components: DesignSystemComponentInput[]; icons: DesignSystemIconInput[] } {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, CATALOG_DOCUMENT_KEYS) ||
    value.version !== 1 ||
    value.kind !== "catalog"
  ) {
    fail("A catalog-v1 source must be an exact version 1 reviewed catalog document.");
  }
  const components = requireArray(value.components, "Component catalog").map((entry) => {
    const record = requireRecordWithKeys(
      entry,
      COMPONENT_KEYS,
      ["name", "reviewed", "variants", "states"],
      "Component catalog entry",
    );
    if (
      record.reviewed !== true ||
      typeof record.name !== "string" ||
      !Array.isArray(record.variants) ||
      !record.variants.every((variant) => typeof variant === "string") ||
      !Array.isArray(record.states) ||
      !record.states.every((state) => typeof state === "string") ||
      (record.description !== undefined && typeof record.description !== "string")
    ) {
      fail("Every catalog component must be explicitly reviewed and contain static metadata.");
    }
    return {
      name: record.name,
      ...(record.description === undefined ? {} : { description: record.description }),
      reviewed: true as const,
      variants: record.variants,
      states: record.states,
      sourceId,
    };
  });
  const icons = requireArray(value.icons, "Icon catalog").map((entry) => {
    const record = requireRecordWithKeys(entry, ICON_KEYS, ["name", "tags"], "Icon catalog entry");
    if (
      typeof record.name !== "string" ||
      !Array.isArray(record.tags) ||
      !record.tags.every((tag) => typeof tag === "string") ||
      (record.label !== undefined && typeof record.label !== "string") ||
      (record.style !== undefined && typeof record.style !== "string")
    ) {
      fail("Icon catalog entries must contain static metadata.");
    }
    return {
      name: record.name,
      ...(record.label === undefined ? {} : { label: record.label }),
      ...(record.style === undefined ? {} : { style: record.style }),
      tags: record.tags,
      sourceId,
    };
  });
  return { components, icons };
}

function parseInput(value: unknown): ExtractReviewedDesignSystemInput {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, new Set(["name", "authority", "sources"])) ||
    typeof value.name !== "string" ||
    !isPlainRecord(value.authority) ||
    !hasExactKeys(value.authority, new Set(["rootPath", "device", "inode"])) ||
    !Array.isArray(value.sources) ||
    value.sources.length < 1 ||
    value.sources.length > DESIGN_SYSTEM_MAX_SOURCES
  ) {
    fail("Design-system extraction input is invalid.");
  }
  const sources = value.sources.map(parseSelection);
  if (
    new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length ||
    new Set(sources.map(({ workspaceRelativePath }) => workspaceRelativePath)).size !==
      sources.length
  ) {
    fail("Reviewed design-system sources contain duplicate identities or paths.");
  }
  return {
    name: value.name,
    authority: {
      rootPath: value.authority.rootPath as string,
      device: value.authority.device as string,
      inode: value.authority.inode as string,
    },
    sources,
  };
}

async function readSelections(
  input: ExtractReviewedDesignSystemInput,
  options: DesignSystemWorkspaceExtractorOptions,
  allowMissing: boolean,
): Promise<
  Array<{
    selection: ReviewedDesignSystemSourceSelection;
    bytes: Buffer;
    source: DesignSystemAuthorizedSource;
  }>
> {
  const canonicalRoot = await verifyWorkspaceRoot(input.authority);
  let totalBytes = 0;
  const reads = [];
  for (const selection of input.sources) {
    let bytes: Buffer;
    try {
      bytes = await readVerifiedSource(
        input.authority,
        canonicalRoot,
        selection.workspaceRelativePath,
        options,
      );
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > DESIGN_SYSTEM_SOURCE_TOTAL_MAX_BYTES) {
      fail("Reviewed design-system sources exceed the total byte limit.");
    }
    reads.push({
      selection,
      bytes,
      source: {
        sourceId: selection.sourceId,
        workspaceRelativePath: selection.workspaceRelativePath,
        fileType: "regular-file" as const,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  }
  return reads;
}

/**
 * Hash current reviewed documents without parsing or executing them. Main uses
 * this immediately before projecting a snapshot to prove freshness.
 */
export async function inspectReviewedDesignSystemSources(
  value: unknown,
  options: DesignSystemWorkspaceExtractorOptions = {},
): Promise<DesignSystemAuthorizedSource[]> {
  const input = parseInput(value);
  return (await readSelections(input, options, true)).map(({ source }) => source);
}

/**
 * Extract strict static metadata from user-reviewed JSON documents. No package
 * resolution, imports, scripts, CSS evaluation, network, Git, or writes occur.
 */
export async function extractReviewedDesignSystemIndex(
  value: unknown,
  options: DesignSystemWorkspaceExtractorOptions = {},
): Promise<DesignSystemIndexInputV1> {
  const input = parseInput(value);
  const reads = await readSelections(input, options, false);
  const result: DesignSystemIndexInputV1 = {
    version: 1,
    name: input.name,
    sources: reads.map(({ source }) => source),
    tokens: { colors: [], spacing: [], typography: [], radii: [], shadows: [] },
    components: [],
    icons: [],
  };
  for (const { selection, bytes } of reads) {
    const document = parseJsonDocument(bytes);
    if (selection.kind === "tokens-v1") {
      const tokens = parseTokenDocument(document, selection.sourceId);
      result.tokens.colors.push(...tokens.colors);
      result.tokens.spacing.push(...tokens.spacing);
      result.tokens.typography.push(...tokens.typography);
      result.tokens.radii.push(...tokens.radii);
      result.tokens.shadows.push(...tokens.shadows);
    } else {
      const catalog = parseCatalogDocument(document, selection.sourceId);
      result.components.push(...catalog.components);
      result.icons.push(...catalog.icons);
    }
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > DESIGN_SYSTEM_MAX_INPUT_BYTES) {
    fail("The extracted design-system index exceeds the normalized input byte limit.");
  }
  // Reuse the core's exact semantic bounds and dynamic-value rejection before
  // any caller can persist this main-only index.
  createDesignSystemAttachment(result, {
    attachmentId: "design-system:extraction-validation",
    now: 0,
  });
  return result;
}
