import { createHash } from "node:crypto";

export const DESIGN_SYSTEM_SNAPSHOT_VERSION = 1 as const;
export const DESIGN_SYSTEM_ATTACHMENT_VERSION = 1 as const;

export const DESIGN_SYSTEM_MAX_INPUT_BYTES = 512 * 1024;
export const DESIGN_SYSTEM_MAX_SNAPSHOT_BYTES = 384 * 1024;
export const DESIGN_SYSTEM_MAX_RECORD_BYTES = 512 * 1024;
export const DESIGN_SYSTEM_MAX_SOURCES = 128;
export const DESIGN_SYSTEM_MAX_TOKENS_PER_KIND = 256;
export const DESIGN_SYSTEM_MAX_COMPONENTS = 256;
export const DESIGN_SYSTEM_MAX_ICONS = 512;
export const DESIGN_SYSTEM_MAX_VARIANTS = 32;
export const DESIGN_SYSTEM_MAX_STATES = 24;
export const DESIGN_SYSTEM_MAX_TAGS = 24;
export const DESIGN_SYSTEM_MAX_DEPTH = 8;
export const DESIGN_SYSTEM_MAX_KEYS = 8_192;

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/u;
const SEMANTIC_NAME = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u;
const COLOR =
  /^(?:#[a-f0-9]{3,8}|(?:rgb|rgba|hsl|hsla|oklab|oklch|lab|lch)\([0-9a-z.+,% /-]{1,120}\)|transparent)$/iu;
const DIMENSION = /^(?:0|[0-9]+(?:\.[0-9]{1,4})?(?:px|rem|em|ch|ex|%|vw|vh|vmin|vmax))$/u;
const SIGNED_DIMENSION = /^(?:0|-?[0-9]+(?:\.[0-9]{1,4})?(?:px|rem|em|ch|ex|%))$/u;
const LINE_HEIGHT = /^(?:normal|[0-9]+(?:\.[0-9]{1,4})?(?:px|rem|em|%)?)$/u;
const FONT_FAMILY = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u;
const STATIC_FORBIDDEN = /(?:\$\{|#\{|\b(?:var|env|calc|url|attr|expression)\s*\(|[{};`])/iu;

const INPUT_KEYS = new Set(["version", "name", "sources", "tokens", "components", "icons"]);
const SOURCE_KEYS = new Set(["sourceId", "workspaceRelativePath", "fileType", "sha256"]);
const TOKEN_GROUP_KEYS = new Set(["colors", "spacing", "typography", "radii", "shadows"]);
const VALUE_TOKEN_INPUT_KEYS = new Set(["name", "value", "sourceId"]);
const VALUE_TOKEN_SNAPSHOT_KEYS = new Set(["name", "value", "sourceHash"]);
const TYPE_TOKEN_INPUT_KEYS = new Set([
  "name",
  "families",
  "size",
  "lineHeight",
  "weight",
  "letterSpacing",
  "sourceId",
]);
const TYPE_TOKEN_SNAPSHOT_KEYS = new Set([
  "name",
  "families",
  "size",
  "lineHeight",
  "weight",
  "letterSpacing",
  "sourceHash",
]);
const COMPONENT_INPUT_KEYS = new Set([
  "name",
  "description",
  "reviewed",
  "variants",
  "states",
  "sourceId",
]);
const COMPONENT_SNAPSHOT_KEYS = new Set([
  "name",
  "description",
  "variants",
  "states",
  "sourceHash",
]);
const ICON_INPUT_KEYS = new Set(["name", "label", "style", "tags", "sourceId"]);
const ICON_SNAPSHOT_KEYS = new Set(["name", "label", "style", "tags", "sourceHash"]);
const SNAPSHOT_KEYS = new Set([
  "version",
  "id",
  "revision",
  "name",
  "refreshedAt",
  "contentHash",
  "sourceHashes",
  "tokens",
  "components",
  "icons",
]);
const PROVENANCE_KEYS = new Set(["sourceId", "workspaceRelativePath", "sha256"]);
const ATTACHED_KEYS = new Set([
  "version",
  "attachmentId",
  "revision",
  "state",
  "createdAt",
  "updatedAt",
  "snapshot",
  "provenance",
]);
const DETACHED_KEYS = new Set([
  "version",
  "attachmentId",
  "revision",
  "state",
  "createdAt",
  "updatedAt",
  "detachedAt",
  "priorSnapshotHash",
  "sourceHashes",
]);

export class DesignSystemSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignSystemSnapshotError";
  }
}

export interface DesignSystemAuthorizedSource {
  sourceId: string;
  workspaceRelativePath: string;
  fileType: "regular-file" | "symlink" | "directory" | "unsupported";
  sha256: string;
}

export interface DesignSystemValueTokenInput {
  name: string;
  value: string;
  sourceId: string;
}

export interface DesignSystemTypographyTokenInput {
  name: string;
  families: string[];
  size: string;
  lineHeight: string;
  weight: number;
  letterSpacing?: string;
  sourceId: string;
}

export interface DesignSystemComponentInput {
  name: string;
  description?: string;
  reviewed: true;
  variants: string[];
  states: string[];
  sourceId: string;
}

export interface DesignSystemIconInput {
  name: string;
  label?: string;
  style?: string;
  tags: string[];
  sourceId: string;
}

export interface DesignSystemIndexInputV1 {
  version: 1;
  name: string;
  sources: DesignSystemAuthorizedSource[];
  tokens: {
    colors: DesignSystemValueTokenInput[];
    spacing: DesignSystemValueTokenInput[];
    typography: DesignSystemTypographyTokenInput[];
    radii: DesignSystemValueTokenInput[];
    shadows: DesignSystemValueTokenInput[];
  };
  components: DesignSystemComponentInput[];
  icons: DesignSystemIconInput[];
}

export interface DesignSystemValueToken {
  name: string;
  value: string;
  sourceHash: string;
}

export interface DesignSystemTypographyToken {
  name: string;
  families: string[];
  size: string;
  lineHeight: string;
  weight: number;
  letterSpacing?: string;
  sourceHash: string;
}

export interface DesignSystemComponent {
  name: string;
  description?: string;
  variants: string[];
  states: string[];
  sourceHash: string;
}

export interface DesignSystemIcon {
  name: string;
  label?: string;
  style?: string;
  tags: string[];
  sourceHash: string;
}

export interface DesignSystemSnapshotV1 {
  version: 1;
  id: string;
  revision: number;
  name: string;
  refreshedAt: number;
  contentHash: string;
  sourceHashes: string[];
  tokens: {
    colors: DesignSystemValueToken[];
    spacing: DesignSystemValueToken[];
    typography: DesignSystemTypographyToken[];
    radii: DesignSystemValueToken[];
    shadows: DesignSystemValueToken[];
  };
  components: DesignSystemComponent[];
  icons: DesignSystemIcon[];
}

export interface DesignSystemSourceProvenance {
  sourceId: string;
  workspaceRelativePath: string;
  sha256: string;
}

export interface AttachedDesignSystemRecordV1 {
  version: 1;
  attachmentId: string;
  revision: number;
  state: "attached";
  createdAt: number;
  updatedAt: number;
  snapshot: DesignSystemSnapshotV1;
  /** Main-only. Never project this object to a renderer or model. */
  provenance: DesignSystemSourceProvenance[];
}

export interface DetachedDesignSystemRecordV1 {
  version: 1;
  attachmentId: string;
  revision: number;
  state: "detached";
  createdAt: number;
  updatedAt: number;
  detachedAt: number;
  priorSnapshotHash: string;
  sourceHashes: string[];
}

export type DesignSystemAttachmentRecordV1 =
  | AttachedDesignSystemRecordV1
  | DetachedDesignSystemRecordV1;

export type DesignSystemFreshness = "current" | "changed" | "missing" | "detached";

export interface DesignSystemSnapshotAvailability {
  freshness: DesignSystemFreshness;
  snapshot: DesignSystemSnapshotV1 | null;
}

function fail(message: string): never {
  throw new DesignSystemSnapshotError(message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertStructure(value: unknown, maxBytes: number, label: string): void {
  let keyCount = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > DESIGN_SYSTEM_MAX_DEPTH) fail(`${label} exceeds the nesting limit.`);
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate as object)) fail(`${label} must not contain cycles.`);
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!isPlainRecord(candidate)) fail(`${label} must contain only plain data.`);
    if (Object.getOwnPropertySymbols(candidate).length > 0) {
      fail(`${label} must not contain symbol keys.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const descriptor of Object.values(descriptors)) {
      keyCount += 1;
      if (keyCount > DESIGN_SYSTEM_MAX_KEYS) fail(`${label} contains too many keys.`);
      if (!("value" in descriptor)) fail(`${label} must not contain accessors.`);
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    fail(`${label} must be JSON serializable.`);
  }
  if (bytes > maxBytes) fail(`${label} exceeds the byte limit.`);
}

function exactKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function optionalExactKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  return (
    Object.keys(record).every((key) => allowed.has(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function normalizeDisplayText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") fail(`${label} must be text.`);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > maxChars ||
    containsControlCharacter(normalized)
  ) {
    fail(`${label} is outside the text limit.`);
  }
  return normalized;
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.normalize("NFKC") !== value || !SAFE_ID.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function normalizeSemanticName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.normalize("NFKC") !== value ||
    !SEMANTIC_NAME.test(value)
  ) {
    fail(`${label} must be a semantic name.`);
  }
  return value;
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a SHA-256 hash.`);
  return value;
}

function normalizeTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_TIMESTAMP) {
    fail(`${label} must be a safe timestamp.`);
  }
  return value as number;
}

function normalizeRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a revision.`);
  return value as number;
}

function normalizeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    fail("Design-system provenance path is invalid.");
  }
  const normalized = value.normalize("NFKC");
  if (
    normalized !== value ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    containsControlCharacter(normalized)
  ) {
    fail("Design-system provenance must be a normalized workspace-relative path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("Design-system provenance must not traverse the workspace.");
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function compareName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name, "en", { sensitivity: "variant" });
}

function uniqueByName<T extends { name: string }>(values: T[], label: string): T[] {
  const identities = values.map(({ name }) => name.toLocaleLowerCase("en-US"));
  if (new Set(identities).size !== identities.length) fail(`${label} contains duplicate names.`);
  return values.sort(compareName);
}

function normalizeStringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} exceeds the item limit.`);
  const items = value.map((item, index) =>
    normalizeDisplayText(item, `${label}[${index}]`, maxChars),
  );
  const identities = items.map((item) => item.toLocaleLowerCase("en-US"));
  if (new Set(identities).size !== identities.length) fail(`${label} contains duplicate values.`);
  return items.sort((left, right) => left.localeCompare(right, "en"));
}

function assertStatic(value: string, label: string): void {
  if (STATIC_FORBIDDEN.test(value)) fail(`${label} contains a dynamic or unsupported value.`);
}

function normalizeColor(value: unknown, label: string): string {
  const result = normalizeDisplayText(value, label, 128);
  assertStatic(result, label);
  if (!COLOR.test(result)) fail(`${label} is not a supported static color.`);
  return result;
}

function normalizeDimension(value: unknown, label: string, signed = false): string {
  const result = normalizeDisplayText(value, label, 32);
  assertStatic(result, label);
  if (!(signed ? SIGNED_DIMENSION : DIMENSION).test(result)) {
    fail(`${label} is not a supported static dimension.`);
  }
  return result;
}

function normalizeShadow(value: unknown, label: string): string {
  const result = normalizeDisplayText(value, label, 192);
  assertStatic(result, label);
  if (
    result !== "none" &&
    (!/^(?:inset )?[#(),.%/\-+ a-z0-9]+$/iu.test(result) ||
      !/(?:#[a-f0-9]{3,8}|(?:rgb|rgba|hsl|hsla|oklab|oklch|lab|lch)\()/iu.test(result) ||
      !/[0-9](?:px|rem|em)\b/u.test(result))
  ) {
    fail(`${label} is not a supported static shadow.`);
  }
  return result;
}

function normalizeLineHeight(value: unknown, label: string): string {
  const result = normalizeDisplayText(value, label, 32);
  assertStatic(result, label);
  if (!LINE_HEIGHT.test(result)) fail(`${label} is not a supported static line height.`);
  return result;
}

function normalizeSource(value: unknown): DesignSystemAuthorizedSource {
  if (!isPlainRecord(value) || !exactKeys(value, SOURCE_KEYS)) {
    fail("Design-system source metadata has an invalid shape.");
  }
  if (value.fileType !== "regular-file") {
    fail(
      "Design-system sources must be regular files; symlinks and unsupported entries are rejected.",
    );
  }
  return {
    sourceId: normalizeId(value.sourceId, "Design-system source ID"),
    workspaceRelativePath: normalizeRelativePath(value.workspaceRelativePath),
    fileType: "regular-file",
    sha256: normalizeHash(value.sha256, "Design-system source hash"),
  };
}

function normalizeSources(value: unknown, allowEmpty = false): DesignSystemAuthorizedSource[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > DESIGN_SYSTEM_MAX_SOURCES
  ) {
    fail("Design-system sources are outside the count limit.");
  }
  const sources = value.map(normalizeSource);
  for (const identity of [
    sources.map(({ sourceId }) => sourceId),
    sources.map(({ workspaceRelativePath }) => workspaceRelativePath),
  ]) {
    if (new Set(identity).size !== identity.length)
      fail("Design-system sources contain duplicates.");
  }
  return sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en"));
}

function requireSourceHash(sourceId: unknown, sourceMap: ReadonlyMap<string, string>): string {
  const normalized = normalizeId(sourceId, "Design-system source reference");
  const hash = sourceMap.get(normalized);
  if (!hash) fail("Design-system entry references an unknown source.");
  return hash;
}

type ValueTokenKind = "color" | "spacing" | "radius" | "shadow";

function normalizeValueTokenInput(
  value: unknown,
  sourceMap: ReadonlyMap<string, string>,
  kind: ValueTokenKind,
): DesignSystemValueToken {
  if (!isPlainRecord(value) || !exactKeys(value, VALUE_TOKEN_INPUT_KEYS)) {
    fail(`Design-system ${kind} token has an invalid shape.`);
  }
  const tokenValue =
    kind === "color"
      ? normalizeColor(value.value, "Color token")
      : kind === "shadow"
        ? normalizeShadow(value.value, "Shadow token")
        : normalizeDimension(value.value, `${kind} token`);
  return {
    name: normalizeSemanticName(value.name, `${kind} token name`),
    value: tokenValue,
    sourceHash: requireSourceHash(value.sourceId, sourceMap),
  };
}

function normalizeTypographyInput(
  value: unknown,
  sourceMap: ReadonlyMap<string, string>,
): DesignSystemTypographyToken {
  if (
    !isPlainRecord(value) ||
    !optionalExactKeys(value, TYPE_TOKEN_INPUT_KEYS, [
      "name",
      "families",
      "size",
      "lineHeight",
      "weight",
      "sourceId",
    ])
  ) {
    fail("Design-system typography token has an invalid shape.");
  }
  if (!Array.isArray(value.families) || value.families.length < 1 || value.families.length > 8) {
    fail("Typography families are outside the count limit.");
  }
  const families = value.families.map((family, index) => {
    const normalized = normalizeDisplayText(family, `Typography family ${index}`, 80);
    if (!FONT_FAMILY.test(normalized)) fail("Typography family is unsupported.");
    return normalized;
  });
  if (
    !Number.isSafeInteger(value.weight) ||
    (value.weight as number) < 1 ||
    (value.weight as number) > 1_000
  ) {
    fail("Typography weight is outside the supported range.");
  }
  return {
    name: normalizeSemanticName(value.name, "Typography token name"),
    families,
    size: normalizeDimension(value.size, "Typography size"),
    lineHeight: normalizeLineHeight(value.lineHeight, "Typography line height"),
    weight: value.weight as number,
    ...(value.letterSpacing === undefined
      ? {}
      : {
          letterSpacing: normalizeDimension(value.letterSpacing, "Typography letter spacing", true),
        }),
    sourceHash: requireSourceHash(value.sourceId, sourceMap),
  };
}

function normalizeBoundedArray<T>(
  value: unknown,
  label: string,
  max: number,
  parser: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} exceeds the count limit.`);
  return value.map(parser);
}

function normalizeComponentInput(
  value: unknown,
  sourceMap: ReadonlyMap<string, string>,
): DesignSystemComponent {
  if (
    !isPlainRecord(value) ||
    !optionalExactKeys(value, COMPONENT_INPUT_KEYS, [
      "name",
      "reviewed",
      "variants",
      "states",
      "sourceId",
    ]) ||
    value.reviewed !== true
  ) {
    fail("Only explicitly reviewed design-system components may be indexed.");
  }
  return {
    name: normalizeSemanticName(value.name, "Component name"),
    ...(value.description === undefined
      ? {}
      : { description: normalizeDisplayText(value.description, "Component description", 320) }),
    variants: normalizeStringList(
      value.variants,
      "Component variants",
      DESIGN_SYSTEM_MAX_VARIANTS,
      64,
    ),
    states: normalizeStringList(value.states, "Component states", DESIGN_SYSTEM_MAX_STATES, 64),
    sourceHash: requireSourceHash(value.sourceId, sourceMap),
  };
}

function normalizeIconInput(
  value: unknown,
  sourceMap: ReadonlyMap<string, string>,
): DesignSystemIcon {
  if (
    !isPlainRecord(value) ||
    !optionalExactKeys(value, ICON_INPUT_KEYS, ["name", "tags", "sourceId"])
  ) {
    fail("Design-system icon metadata has an invalid shape.");
  }
  return {
    name: normalizeSemanticName(value.name, "Icon name"),
    ...(value.label === undefined
      ? {}
      : { label: normalizeDisplayText(value.label, "Icon label", 96) }),
    ...(value.style === undefined
      ? {}
      : { style: normalizeSemanticName(value.style, "Icon style") }),
    tags: normalizeStringList(value.tags, "Icon tags", DESIGN_SYSTEM_MAX_TAGS, 48),
    sourceHash: requireSourceHash(value.sourceId, sourceMap),
  };
}

function snapshotPayload(snapshot: Omit<DesignSystemSnapshotV1, "contentHash">): object {
  return {
    version: snapshot.version,
    name: snapshot.name,
    sourceHashes: snapshot.sourceHashes,
    tokens: snapshot.tokens,
    components: snapshot.components,
    icons: snapshot.icons,
  };
}

function hashJson(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function buildNormalized(
  input: unknown,
  snapshotId: string,
  revision: number,
  refreshedAt: number,
): { snapshot: DesignSystemSnapshotV1; provenance: DesignSystemSourceProvenance[] } {
  assertStructure(input, DESIGN_SYSTEM_MAX_INPUT_BYTES, "Design-system index input");
  if (!isPlainRecord(input) || !exactKeys(input, INPUT_KEYS) || input.version !== 1) {
    fail("Design-system index input must use schema version 1.");
  }
  if (!isPlainRecord(input.tokens) || !exactKeys(input.tokens, TOKEN_GROUP_KEYS)) {
    fail("Design-system tokens have an invalid shape.");
  }
  const sources = normalizeSources(input.sources);
  const sourceMap = new Map(sources.map(({ sourceId, sha256 }) => [sourceId, sha256]));
  const colors = uniqueByName(
    normalizeBoundedArray(
      input.tokens.colors,
      "Color tokens",
      DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
      (entry) => normalizeValueTokenInput(entry, sourceMap, "color"),
    ),
    "Color tokens",
  );
  const spacing = uniqueByName(
    normalizeBoundedArray(
      input.tokens.spacing,
      "Spacing tokens",
      DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
      (entry) => normalizeValueTokenInput(entry, sourceMap, "spacing"),
    ),
    "Spacing tokens",
  );
  const typography = uniqueByName(
    normalizeBoundedArray(
      input.tokens.typography,
      "Typography tokens",
      DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
      (entry) => normalizeTypographyInput(entry, sourceMap),
    ),
    "Typography tokens",
  );
  const radii = uniqueByName(
    normalizeBoundedArray(
      input.tokens.radii,
      "Radius tokens",
      DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
      (entry) => normalizeValueTokenInput(entry, sourceMap, "radius"),
    ),
    "Radius tokens",
  );
  const shadows = uniqueByName(
    normalizeBoundedArray(
      input.tokens.shadows,
      "Shadow tokens",
      DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
      (entry) => normalizeValueTokenInput(entry, sourceMap, "shadow"),
    ),
    "Shadow tokens",
  );
  const components = uniqueByName(
    normalizeBoundedArray(input.components, "Components", DESIGN_SYSTEM_MAX_COMPONENTS, (entry) =>
      normalizeComponentInput(entry, sourceMap),
    ),
    "Components",
  );
  const icons = uniqueByName(
    normalizeBoundedArray(input.icons, "Icons", DESIGN_SYSTEM_MAX_ICONS, (entry) =>
      normalizeIconInput(entry, sourceMap),
    ),
    "Icons",
  );
  if (
    colors.length +
      spacing.length +
      typography.length +
      radii.length +
      shadows.length +
      components.length +
      icons.length ===
    0
  ) {
    fail("Design-system snapshot must contain at least one semantic entry.");
  }
  const partial: Omit<DesignSystemSnapshotV1, "contentHash"> = {
    version: 1,
    id: normalizeId(snapshotId, "Design-system snapshot ID"),
    revision: normalizeRevision(revision, "Design-system snapshot revision"),
    name: normalizeDisplayText(input.name, "Design-system name", 120),
    refreshedAt: normalizeTimestamp(refreshedAt, "Design-system refresh time"),
    sourceHashes: [...new Set(sources.map(({ sha256 }) => sha256))].sort(),
    tokens: { colors, spacing, typography, radii, shadows },
    components,
    icons,
  };
  const snapshot: DesignSystemSnapshotV1 = {
    ...partial,
    contentHash: hashJson(snapshotPayload(partial)),
  };
  assertStructure(snapshot, DESIGN_SYSTEM_MAX_SNAPSHOT_BYTES, "Design-system snapshot");
  return {
    snapshot,
    provenance: sources.map(({ sourceId, workspaceRelativePath, sha256 }) => ({
      sourceId,
      workspaceRelativePath,
      sha256,
    })),
  };
}

export function createDesignSystemAttachment(
  input: unknown,
  options: { attachmentId: string; now: number },
): AttachedDesignSystemRecordV1 {
  const attachmentId = normalizeId(options.attachmentId, "Design-system attachment ID");
  const now = normalizeTimestamp(options.now, "Design-system attachment time");
  const normalized = buildNormalized(input, attachmentId, 1, now);
  const record: AttachedDesignSystemRecordV1 = {
    version: 1,
    attachmentId,
    revision: 1,
    state: "attached",
    createdAt: now,
    updatedAt: now,
    ...normalized,
  };
  assertStructure(record, DESIGN_SYSTEM_MAX_RECORD_BYTES, "Design-system attachment record");
  return record;
}

export function refreshDesignSystemAttachment(
  record: DesignSystemAttachmentRecordV1,
  input: unknown,
  now: number,
): AttachedDesignSystemRecordV1 {
  const parsed = parseDesignSystemAttachmentRecord(record);
  if (parsed.state !== "attached")
    fail("A detached design system must be explicitly attached again.");
  const refreshedAt = normalizeTimestamp(now, "Design-system refresh time");
  if (refreshedAt < parsed.updatedAt) fail("Design-system refresh time must be monotonic.");
  const revision = parsed.revision + 1;
  if (!Number.isSafeInteger(revision)) fail("Design-system attachment revision is exhausted.");
  const normalized = buildNormalized(input, parsed.attachmentId, revision, refreshedAt);
  return {
    version: 1,
    attachmentId: parsed.attachmentId,
    revision,
    state: "attached",
    createdAt: parsed.createdAt,
    updatedAt: refreshedAt,
    ...normalized,
  };
}

export function detachDesignSystemAttachment(
  record: DesignSystemAttachmentRecordV1,
  now: number,
): DetachedDesignSystemRecordV1 {
  const parsed = parseDesignSystemAttachmentRecord(record);
  const detachedAt = normalizeTimestamp(now, "Design-system detach time");
  if (detachedAt < parsed.updatedAt) fail("Design-system detach time must be monotonic.");
  if (parsed.state === "detached") return parsed;
  const revision = parsed.revision + 1;
  if (!Number.isSafeInteger(revision)) fail("Design-system attachment revision is exhausted.");
  return {
    version: 1,
    attachmentId: parsed.attachmentId,
    revision,
    state: "detached",
    createdAt: parsed.createdAt,
    updatedAt: detachedAt,
    detachedAt,
    priorSnapshotHash: parsed.snapshot.contentHash,
    sourceHashes: [...parsed.snapshot.sourceHashes],
  };
}

function parseSnapshotValueToken(value: unknown, kind: ValueTokenKind): DesignSystemValueToken {
  if (!isPlainRecord(value) || !exactKeys(value, VALUE_TOKEN_SNAPSHOT_KEYS)) {
    fail(`Persisted ${kind} token has an invalid shape.`);
  }
  const tokenValue =
    kind === "color"
      ? normalizeColor(value.value, "Persisted color token")
      : kind === "shadow"
        ? normalizeShadow(value.value, "Persisted shadow token")
        : normalizeDimension(value.value, `Persisted ${kind} token`);
  return {
    name: normalizeSemanticName(value.name, `Persisted ${kind} token name`),
    value: tokenValue,
    sourceHash: normalizeHash(value.sourceHash, "Persisted token source hash"),
  };
}

function parseSnapshotTypography(value: unknown): DesignSystemTypographyToken {
  if (
    !isPlainRecord(value) ||
    !optionalExactKeys(value, TYPE_TOKEN_SNAPSHOT_KEYS, [
      "name",
      "families",
      "size",
      "lineHeight",
      "weight",
      "sourceHash",
    ])
  ) {
    fail("Persisted typography token has an invalid shape.");
  }
  if (!Array.isArray(value.families) || value.families.length < 1 || value.families.length > 8) {
    fail("Persisted typography families are outside the count limit.");
  }
  const families = value.families.map((family, index) => {
    const normalized = normalizeDisplayText(family, `Persisted typography family ${index}`, 80);
    if (!FONT_FAMILY.test(normalized)) fail("Persisted typography family is unsupported.");
    return normalized;
  });
  if (
    !Number.isSafeInteger(value.weight) ||
    (value.weight as number) < 1 ||
    (value.weight as number) > 1_000
  ) {
    fail("Persisted typography weight is invalid.");
  }
  return {
    name: normalizeSemanticName(value.name, "Persisted typography token name"),
    families,
    size: normalizeDimension(value.size, "Persisted typography size"),
    lineHeight: normalizeLineHeight(value.lineHeight, "Persisted typography line height"),
    weight: value.weight as number,
    ...(value.letterSpacing === undefined
      ? {}
      : {
          letterSpacing: normalizeDimension(value.letterSpacing, "Persisted letter spacing", true),
        }),
    sourceHash: normalizeHash(value.sourceHash, "Persisted typography source hash"),
  };
}

function parseSnapshotComponent(value: unknown): DesignSystemComponent {
  if (
    !isPlainRecord(value) ||
    !optionalExactKeys(value, COMPONENT_SNAPSHOT_KEYS, ["name", "variants", "states", "sourceHash"])
  ) {
    fail("Persisted component metadata has an invalid shape.");
  }
  return {
    name: normalizeSemanticName(value.name, "Persisted component name"),
    ...(value.description === undefined
      ? {}
      : {
          description: normalizeDisplayText(
            value.description,
            "Persisted component description",
            320,
          ),
        }),
    variants: normalizeStringList(
      value.variants,
      "Persisted component variants",
      DESIGN_SYSTEM_MAX_VARIANTS,
      64,
    ),
    states: normalizeStringList(
      value.states,
      "Persisted component states",
      DESIGN_SYSTEM_MAX_STATES,
      64,
    ),
    sourceHash: normalizeHash(value.sourceHash, "Persisted component source hash"),
  };
}

function parseSnapshotIcon(value: unknown): DesignSystemIcon {
  if (
    !isPlainRecord(value) ||
    !optionalExactKeys(value, ICON_SNAPSHOT_KEYS, ["name", "tags", "sourceHash"])
  ) {
    fail("Persisted icon metadata has an invalid shape.");
  }
  return {
    name: normalizeSemanticName(value.name, "Persisted icon name"),
    ...(value.label === undefined
      ? {}
      : { label: normalizeDisplayText(value.label, "Persisted icon label", 96) }),
    ...(value.style === undefined
      ? {}
      : { style: normalizeSemanticName(value.style, "Persisted icon style") }),
    tags: normalizeStringList(value.tags, "Persisted icon tags", DESIGN_SYSTEM_MAX_TAGS, 48),
    sourceHash: normalizeHash(value.sourceHash, "Persisted icon source hash"),
  };
}

export function parseDesignSystemSnapshot(value: unknown): DesignSystemSnapshotV1 {
  assertStructure(value, DESIGN_SYSTEM_MAX_SNAPSHOT_BYTES, "Design-system snapshot");
  if (!isPlainRecord(value) || !exactKeys(value, SNAPSHOT_KEYS) || value.version !== 1) {
    fail("Design-system snapshot must use schema version 1.");
  }
  if (!isPlainRecord(value.tokens) || !exactKeys(value.tokens, TOKEN_GROUP_KEYS)) {
    fail("Persisted design-system tokens have an invalid shape.");
  }
  const snapshot: DesignSystemSnapshotV1 = {
    version: 1,
    id: normalizeId(value.id, "Design-system snapshot ID"),
    revision: normalizeRevision(value.revision, "Design-system snapshot revision"),
    name: normalizeDisplayText(value.name, "Design-system snapshot name", 120),
    refreshedAt: normalizeTimestamp(value.refreshedAt, "Design-system snapshot refresh time"),
    contentHash: normalizeHash(value.contentHash, "Design-system content hash"),
    sourceHashes: normalizeStringList(
      value.sourceHashes,
      "Design-system source hashes",
      DESIGN_SYSTEM_MAX_SOURCES,
      64,
    ).map((hash) => normalizeHash(hash, "Design-system source hash")),
    tokens: {
      colors: uniqueByName(
        normalizeBoundedArray(
          value.tokens.colors,
          "Persisted colors",
          DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
          (entry) => parseSnapshotValueToken(entry, "color"),
        ),
        "Persisted colors",
      ),
      spacing: uniqueByName(
        normalizeBoundedArray(
          value.tokens.spacing,
          "Persisted spacing",
          DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
          (entry) => parseSnapshotValueToken(entry, "spacing"),
        ),
        "Persisted spacing",
      ),
      typography: uniqueByName(
        normalizeBoundedArray(
          value.tokens.typography,
          "Persisted typography",
          DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
          parseSnapshotTypography,
        ),
        "Persisted typography",
      ),
      radii: uniqueByName(
        normalizeBoundedArray(
          value.tokens.radii,
          "Persisted radii",
          DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
          (entry) => parseSnapshotValueToken(entry, "radius"),
        ),
        "Persisted radii",
      ),
      shadows: uniqueByName(
        normalizeBoundedArray(
          value.tokens.shadows,
          "Persisted shadows",
          DESIGN_SYSTEM_MAX_TOKENS_PER_KIND,
          (entry) => parseSnapshotValueToken(entry, "shadow"),
        ),
        "Persisted shadows",
      ),
    },
    components: uniqueByName(
      normalizeBoundedArray(
        value.components,
        "Persisted components",
        DESIGN_SYSTEM_MAX_COMPONENTS,
        parseSnapshotComponent,
      ),
      "Persisted components",
    ),
    icons: uniqueByName(
      normalizeBoundedArray(
        value.icons,
        "Persisted icons",
        DESIGN_SYSTEM_MAX_ICONS,
        parseSnapshotIcon,
      ),
      "Persisted icons",
    ),
  };
  const referenced = new Set<string>();
  for (const token of [
    ...snapshot.tokens.colors,
    ...snapshot.tokens.spacing,
    ...snapshot.tokens.typography,
    ...snapshot.tokens.radii,
    ...snapshot.tokens.shadows,
    ...snapshot.components,
    ...snapshot.icons,
  ]) {
    referenced.add(token.sourceHash);
  }
  if (
    referenced.size === 0 ||
    [...referenced].some((hash) => !snapshot.sourceHashes.includes(hash)) ||
    hashJson(snapshotPayload(snapshot)) !== snapshot.contentHash
  ) {
    fail("Design-system snapshot hashes do not match its normalized content.");
  }
  return snapshot;
}

function parseProvenance(value: unknown): DesignSystemSourceProvenance[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > DESIGN_SYSTEM_MAX_SOURCES) {
    fail("Design-system provenance is outside the count limit.");
  }
  const entries = value.map((entry) => {
    if (!isPlainRecord(entry) || !exactKeys(entry, PROVENANCE_KEYS)) {
      fail("Design-system provenance has an invalid shape.");
    }
    return {
      sourceId: normalizeId(entry.sourceId, "Design-system provenance source ID"),
      workspaceRelativePath: normalizeRelativePath(entry.workspaceRelativePath),
      sha256: normalizeHash(entry.sha256, "Design-system provenance hash"),
    };
  });
  const identities = entries.map(({ sourceId }) => sourceId);
  const paths = entries.map(({ workspaceRelativePath }) => workspaceRelativePath);
  if (new Set(identities).size !== identities.length || new Set(paths).size !== paths.length)
    fail("Design-system provenance contains duplicates.");
  return entries.sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en"));
}

export function parseDesignSystemAttachmentRecord(value: unknown): DesignSystemAttachmentRecordV1 {
  assertStructure(value, DESIGN_SYSTEM_MAX_RECORD_BYTES, "Design-system attachment record");
  if (!isPlainRecord(value) || value.version !== 1) {
    fail("Design-system attachment must use schema version 1.");
  }
  const attachmentId = normalizeId(value.attachmentId, "Design-system attachment ID");
  const revision = normalizeRevision(value.revision, "Design-system attachment revision");
  const createdAt = normalizeTimestamp(value.createdAt, "Design-system attachment creation time");
  const updatedAt = normalizeTimestamp(value.updatedAt, "Design-system attachment update time");
  if (updatedAt < createdAt) fail("Design-system attachment timestamps are inconsistent.");
  if (value.state === "attached") {
    if (!exactKeys(value, ATTACHED_KEYS))
      fail("Attached design-system record has an invalid shape.");
    const snapshot = parseDesignSystemSnapshot(value.snapshot);
    const provenance = parseProvenance(value.provenance);
    if (
      snapshot.id !== attachmentId ||
      snapshot.revision !== revision ||
      snapshot.refreshedAt !== updatedAt ||
      provenance.some(({ sha256 }) => !snapshot.sourceHashes.includes(sha256)) ||
      snapshot.sourceHashes.some((hash) => !provenance.some(({ sha256 }) => sha256 === hash))
    ) {
      fail("Attached design-system record has inconsistent snapshot provenance.");
    }
    return {
      version: 1,
      attachmentId,
      revision,
      state: "attached",
      createdAt,
      updatedAt,
      snapshot,
      provenance,
    };
  }
  if (value.state === "detached") {
    if (!exactKeys(value, DETACHED_KEYS))
      fail("Detached design-system record has an invalid shape.");
    const detachedAt = normalizeTimestamp(value.detachedAt, "Design-system detach time");
    if (detachedAt !== updatedAt) fail("Detached design-system timestamps are inconsistent.");
    return {
      version: 1,
      attachmentId,
      revision,
      state: "detached",
      createdAt,
      updatedAt,
      detachedAt,
      priorSnapshotHash: normalizeHash(
        value.priorSnapshotHash,
        "Detached design-system snapshot hash",
      ),
      sourceHashes: normalizeStringList(
        value.sourceHashes,
        "Detached design-system source hashes",
        DESIGN_SYSTEM_MAX_SOURCES,
        64,
      ).map((hash) => normalizeHash(hash, "Detached design-system source hash")),
    };
  }
  fail("Design-system attachment state is invalid.");
}

function freshnessAgainstSources(
  record: AttachedDesignSystemRecordV1,
  sources: unknown,
): Exclude<DesignSystemFreshness, "detached"> {
  const normalized = normalizeSources(sources, true);
  const current = new Map(normalized.map((source) => [source.sourceId, source]));
  if (record.provenance.some(({ sourceId }) => !current.has(sourceId))) return "missing";
  if (
    normalized.length !== record.provenance.length ||
    record.provenance.some((expected) => {
      const actual = current.get(expected.sourceId);
      return (
        !actual ||
        actual.workspaceRelativePath !== expected.workspaceRelativePath ||
        actual.sha256 !== expected.sha256
      );
    })
  ) {
    return "changed";
  }
  return "current";
}

export function inspectDesignSystemFreshness(
  record: DesignSystemAttachmentRecordV1,
  currentAuthorizedSources: unknown,
): DesignSystemFreshness {
  const parsed = parseDesignSystemAttachmentRecord(record);
  if (parsed.state === "detached") return "detached";
  return freshnessAgainstSources(parsed, currentAuthorizedSources);
}

/** Returns model/renderer-safe data only when current source hashes are proven. */
export function getCurrentDesignSystemSnapshot(
  record: DesignSystemAttachmentRecordV1,
  currentAuthorizedSources: unknown,
): DesignSystemSnapshotAvailability {
  const parsed = parseDesignSystemAttachmentRecord(record);
  if (parsed.state === "detached") return { freshness: "detached", snapshot: null };
  const freshness = freshnessAgainstSources(parsed, currentAuthorizedSources);
  return { freshness, snapshot: freshness === "current" ? parsed.snapshot : null };
}
