import { createHash } from "node:crypto";

export const DESIGN_PROJECT_EXPORT_VERSION = 1 as const;
export const MAX_DESIGN_EXPORT_ENTRIES = 103;
export const MAX_DESIGN_EXPORT_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_DESIGN_EXPORT_TOTAL_BYTES = 80 * 1024 * 1024;
export const MAX_DESIGN_EXPORT_PATH_BYTES = 512;

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORED_METHOD = 0;
const ZIP_VERSION = 20;
const ZIP_UNIX_VERSION = (3 << 8) | ZIP_VERSION;
const ZIP_FIXED_DOS_TIME = 0;
const ZIP_FIXED_DOS_DATE = (1 << 5) | 1; // 1980-01-01, the earliest DOS date.
const ZIP_REGULAR_FILE_MODE = 0o100644;
const MAX_TITLE_CHARACTERS = 160;
const MAX_TEXT_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._:@+-]{1,256}$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const FORBIDDEN_PORTABLE_PATH_CHARACTER = /[<>:"|?*\p{Cc}\p{Cf}]/u;
const FILE_URL = /\bfile:\/\//iu;
const ABSOLUTE_FILE_PATH = /(?:^|[\s"'=(])(?:\/(?:Users|home|private|var|tmp)\/|[A-Za-z]:[\\/])/u;
const EMBEDDED_CREDENTIAL =
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*["'][^"'\r\n]{8,}["']|\bbearer\s+[A-Za-z0-9._~+/-]{8,}/iu;

export interface DeterministicZipEntryInput {
  path: string;
  bytes: Uint8Array;
}

export interface DesignProjectExportReferenceInput {
  /** Relative to the bundle's `references/` directory. */
  relativePath: string;
  bytes: Uint8Array;
}

export interface DesignProjectExportInput {
  projectId: string;
  projectTitle: string;
  lineageId: string;
  revision: number;
  /** Lowercase SHA-256 of the exact UTF-8 `indexHtml` bytes. */
  contentHash: string;
  /** Canonical UTC ISO-8601 timestamp belonging to the immutable source revision. */
  sourceRevisionTimestamp: string;
  /** Canonical, offline, standalone source document. */
  indexHtml: string;
  referenceAssets?: readonly DesignProjectExportReferenceInput[];
}

export interface DesignProjectExportManifestV1 {
  schema: "aiden.design-project.export";
  version: typeof DESIGN_PROJECT_EXPORT_VERSION;
  project: {
    id: string;
    title: string;
  };
  source: {
    lineageId: string;
    revision: number;
    contentHash: string;
    revisionTimestamp: string;
  };
  entrypoint: "index.html";
  references: Array<{
    path: string;
    byteLength: number;
    sha256: string;
  }>;
}

export interface DesignProjectExportBundle {
  readonly fileName: string;
  readonly rootDirectory: string;
  readonly manifest: Readonly<DesignProjectExportManifestV1>;
  readonly manifestJson: string;
  readonly readmeMarkdown: string;
  readonly entryPaths: readonly string[];
  /** Returns a defensive copy; callers cannot mutate the bundle's canonical bytes. */
  getZipBytes(): Buffer;
}

interface PreparedZipEntry {
  path: string;
  pathBytes: Buffer;
  bytes: Buffer;
  crc32: number;
  localOffset: number;
}

function isUnicodeScalarString(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function utf8BytePrefix(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Builds a portable, deterministic directory name from user-visible text. */
export function safeDesignExportSlug(value: string): string {
  if (typeof value !== "string") return "design-project";
  const scalar = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 0xd800 || codePoint > 0xdfff);
    })
    .join("");
  const slug = scalar
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const bounded = utf8BytePrefix(Array.from(slug).slice(0, 64).join(""), 192).replace(/-+$/gu, "");
  return bounded || "design-project";
}

/**
 * Normalizes a relative ZIP path while rejecting traversal and names that
 * collide or extract differently on common desktop filesystems.
 */
export function normalizeDesignExportRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || !isUnicodeScalarString(value)) {
    throw new Error("Design export paths must be non-empty valid UTF-8 text.");
  }
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    throw new Error("Design export paths must be relative file paths.");
  }
  const normalized = value.normalize("NFC");
  const parts = normalized.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        WINDOWS_RESERVED_NAME.test(part) ||
        FORBIDDEN_PORTABLE_PATH_CHARACTER.test(part),
    )
  ) {
    throw new Error("Design export paths contain an unsafe component.");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_DESIGN_EXPORT_PATH_BYTES) {
    throw new Error("Design export paths exceed the UTF-8 byte limit.");
  }
  return normalized;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertZipBudgets(entries: readonly DeterministicZipEntryInput[]): void {
  if (entries.length === 0 || entries.length > MAX_DESIGN_EXPORT_ENTRIES) {
    throw new Error(`Design exports must contain 1-${MAX_DESIGN_EXPORT_ENTRIES} files.`);
  }
  let total = 0;
  for (const entry of entries) {
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new Error("Design export entry bytes must be a byte array.");
    }
    if (entry.bytes.byteLength > MAX_DESIGN_EXPORT_ENTRY_BYTES) {
      throw new Error("A Design export file exceeds the per-file byte limit.");
    }
    total += entry.bytes.byteLength;
    if (total > MAX_DESIGN_EXPORT_TOTAL_BYTES) {
      throw new Error("The Design export exceeds the total byte limit.");
    }
  }
}

/** Encodes regular files as a deterministic, uncompressed, non-Zip64 ZIP. */
export function encodeDeterministicZip(inputs: readonly DeterministicZipEntryInput[]): Buffer {
  assertZipBudgets(inputs);
  const seen = new Set<string>();
  const entries = inputs
    .map((input) => {
      const path = normalizeDesignExportRelativePath(input.path);
      const collisionKey = path.toLocaleLowerCase("en-US");
      if (seen.has(collisionKey)) {
        throw new Error("Design export paths must be unique across desktop filesystems.");
      }
      seen.add(collisionKey);
      const bytes = Buffer.from(input.bytes);
      return {
        path,
        pathBytes: Buffer.from(path, "utf8"),
        bytes,
        crc32: crc32(bytes),
        localOffset: 0,
      } satisfies PreparedZipEntry;
    })
    .sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));

  const localParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    entry.localOffset = localOffset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    header.writeUInt16LE(ZIP_STORED_METHOD, 8);
    header.writeUInt16LE(ZIP_FIXED_DOS_TIME, 10);
    header.writeUInt16LE(ZIP_FIXED_DOS_DATE, 12);
    header.writeUInt32LE(entry.crc32, 14);
    header.writeUInt32LE(entry.bytes.byteLength, 18);
    header.writeUInt32LE(entry.bytes.byteLength, 22);
    header.writeUInt16LE(entry.pathBytes.byteLength, 26);
    header.writeUInt16LE(0, 28);
    localParts.push(header, entry.pathBytes, entry.bytes);
    localOffset += header.byteLength + entry.pathBytes.byteLength + entry.bytes.byteLength;
  }

  const centralParts: Buffer[] = [];
  let centralSize = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(ZIP_UNIX_VERSION, 4);
    header.writeUInt16LE(ZIP_VERSION, 6);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    header.writeUInt16LE(ZIP_STORED_METHOD, 10);
    header.writeUInt16LE(ZIP_FIXED_DOS_TIME, 12);
    header.writeUInt16LE(ZIP_FIXED_DOS_DATE, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.bytes.byteLength, 20);
    header.writeUInt32LE(entry.bytes.byteLength, 24);
    header.writeUInt16LE(entry.pathBytes.byteLength, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((ZIP_REGULAR_FILE_MODE << 16) >>> 0, 38);
    header.writeUInt32LE(entry.localOffset, 42);
    centralParts.push(header, entry.pathBytes);
    centralSize += header.byteLength + entry.pathBytes.byteLength;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON cannot encode non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical JSON contains an unsupported value.");
}

function boundedScalarText(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarString(value) ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES
  ) {
    throw new Error(`${label} is not bounded valid text.`);
  }
  return value.normalize("NFC");
}

function assertCanonicalTimestamp(value: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("The source revision timestamp must be canonical UTC ISO-8601 text.");
  }
}

function decodeUrlEntities(value: string): string {
  return value.replace(/&(?:colon|sol|#58|#47|#x0*3a|#x0*2f);/giu, (entity) =>
    /(?:colon|58|3a)/iu.test(entity) ? ":" : "/",
  );
}

function isForbiddenPortableReference(value: string): boolean {
  const normalized = decodeUrlEntities(value).trim();
  return (
    /^(?:https?:|wss?:|file:)\/\//iu.test(normalized) ||
    normalized.startsWith("//") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(normalized)
  );
}

function hasForbiddenPortableReference(html: string): boolean {
  const candidates: string[] = [];
  const collect = (pattern: RegExp): void => {
    for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
      candidates.push(match[1] ?? match[2] ?? "");
    }
  };

  collect(
    /\b(?:src|href|action|formaction|poster|data|cite|background)\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/giu,
  );
  collect(/\bsrcset\s*=\s*["']([^"']*)["']/giu);
  collect(/\burl\(\s*(?:["']([^"']*)["']|([^\s)'"]+))\s*\)/giu);
  collect(/@import\s+(?:url\(\s*)?["']([^"']+)["']/giu);
  collect(
    /\b(?:fetch|import|WebSocket|EventSource|Worker|SharedWorker)\s*\(\s*["'`]([^"'`]+)["'`]/giu,
  );
  collect(/\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/giu);
  collect(/\.(?:src|href|action|poster)\s*=\s*["'`]([^"'`]+)["'`]/giu);

  return candidates.some((candidate) =>
    candidate
      .split(",")
      .map((part) => part.trim().split(/\s+/u)[0] ?? "")
      .some(isForbiddenPortableReference),
  );
}

/** Rejects network dependencies, machine paths, and obvious embedded secrets. */
export function assertPortableDesignExportHtml(html: string): Buffer {
  if (typeof html !== "string" || html.length === 0 || !isUnicodeScalarString(html)) {
    throw new Error("Design export HTML must be non-empty valid UTF-8 text.");
  }
  const bytes = Buffer.from(html, "utf8");
  if (bytes.byteLength > MAX_DESIGN_EXPORT_ENTRY_BYTES) {
    throw new Error("Design export HTML exceeds the per-file byte limit.");
  }
  if (!/^\s*<!doctype\s+html\b/iu.test(html) || !/<html\b/iu.test(html)) {
    throw new Error("Design export HTML must be a canonical standalone document.");
  }
  if (
    hasForbiddenPortableReference(html) ||
    FILE_URL.test(html) ||
    ABSOLUTE_FILE_PATH.test(html) ||
    EMBEDDED_CREDENTIAL.test(html)
  ) {
    throw new Error(
      "Design export HTML cannot contain remote URLs, absolute paths, or credentials.",
    );
  }
  return bytes;
}

function readmeFor(input: DesignProjectExportInput, referenceCount: number): string {
  return `# ${input.projectTitle}\n\nThis is an offline Aiden Design prototype export. It requires engineering review before production use.\n\n- Project ID: \`${input.projectId}\`\n- Artboard lineage: \`${input.lineageId}\`\n- Source revision: \`${input.revision}\`\n- Source revision timestamp: \`${input.sourceRevisionTimestamp}\`\n- Content SHA-256: \`${input.contentHash}\`\n- Entrypoint: \`index.html\`\n- Reference assets: ${referenceCount}\n\nOpen \`index.html\` locally to inspect the standalone prototype. No export-time timestamp is embedded in this bundle.\n`;
}

/**
 * Creates an immutable source-revision export. Inputs are copied, paths are
 * canonicalized, and each `getZipBytes()` call returns a defensive copy.
 */
export function buildDesignProjectExportBundle(
  input: DesignProjectExportInput,
): DesignProjectExportBundle {
  const projectTitle = boundedScalarText(input.projectTitle, "Project title");
  if (Array.from(projectTitle).length > MAX_TITLE_CHARACTERS) {
    throw new Error("Project title exceeds the character limit.");
  }
  if (!OPAQUE_ID.test(input.projectId) || !OPAQUE_ID.test(input.lineageId)) {
    throw new Error("Design export identities are invalid.");
  }
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error("Design export revision must be a positive safe integer.");
  }
  if (!SHA256.test(input.contentHash)) {
    throw new Error("Design export content hash must be a lowercase SHA-256 digest.");
  }
  assertCanonicalTimestamp(input.sourceRevisionTimestamp);
  const indexBytes = assertPortableDesignExportHtml(input.indexHtml);
  const actualHash = createHash("sha256").update(indexBytes).digest("hex");
  if (actualHash !== input.contentHash) {
    throw new Error("Design export HTML does not match the immutable source hash.");
  }

  const rootDirectory = safeDesignExportSlug(projectTitle);
  const referenceInputs = input.referenceAssets ?? [];
  if (referenceInputs.length > MAX_DESIGN_EXPORT_ENTRIES - 3) {
    throw new Error("Design export contains too many reference assets.");
  }
  const referencePaths = new Set<string>();
  const referenceEntries = referenceInputs
    .map((reference) => {
      const relativePath = normalizeDesignExportRelativePath(reference.relativePath);
      const collisionKey = relativePath.toLocaleLowerCase("en-US");
      if (referencePaths.has(collisionKey)) {
        throw new Error("Design export reference paths must be unique.");
      }
      referencePaths.add(collisionKey);
      const bytes = Buffer.from(reference.bytes);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_DESIGN_EXPORT_ENTRY_BYTES) {
        throw new Error("Design export reference assets must be non-empty and bounded.");
      }
      return {
        relativePath,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    })
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.relativePath, "utf8"),
        Buffer.from(right.relativePath, "utf8"),
      ),
    );

  const manifest: DesignProjectExportManifestV1 = {
    schema: "aiden.design-project.export",
    version: DESIGN_PROJECT_EXPORT_VERSION,
    project: { id: input.projectId, title: projectTitle },
    source: {
      lineageId: input.lineageId,
      revision: input.revision,
      contentHash: input.contentHash,
      revisionTimestamp: input.sourceRevisionTimestamp,
    },
    entrypoint: "index.html",
    references: referenceEntries.map((entry) => ({
      path: `references/${entry.relativePath}`,
      byteLength: entry.bytes.byteLength,
      sha256: entry.sha256,
    })),
  };
  const manifestJson = `${canonicalJson(manifest)}\n`;
  const readmeMarkdown = readmeFor({ ...input, projectTitle }, referenceEntries.length);
  const entries: DeterministicZipEntryInput[] = [
    { path: `${rootDirectory}/index.html`, bytes: indexBytes },
    { path: `${rootDirectory}/README.md`, bytes: Buffer.from(readmeMarkdown, "utf8") },
    {
      path: `${rootDirectory}/design-project.json`,
      bytes: Buffer.from(manifestJson, "utf8"),
    },
    ...referenceEntries.map((entry) => ({
      path: `${rootDirectory}/references/${entry.relativePath}`,
      bytes: entry.bytes,
    })),
  ];
  const zipBytes = encodeDeterministicZip(entries);
  const entryPaths = Object.freeze(
    entries
      .map((entry) => normalizeDesignExportRelativePath(entry.path))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
  const frozenManifest = Object.freeze({
    ...manifest,
    project: Object.freeze({ ...manifest.project }),
    source: Object.freeze({ ...manifest.source }),
    references: Object.freeze(
      manifest.references.map((reference) => Object.freeze({ ...reference })),
    ),
  }) as Readonly<DesignProjectExportManifestV1>;
  return Object.freeze({
    fileName: `${rootDirectory}.zip`,
    rootDirectory,
    manifest: frozenManifest,
    manifestJson,
    readmeMarkdown,
    entryPaths,
    getZipBytes: () => Buffer.from(zipBytes),
  });
}
