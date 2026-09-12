import { createHash } from "node:crypto";
import { parseDesignLanguageBindingV1, type DesignLanguageDocumentV1, type DesignLanguageProvenanceV1, type DesignLanguageSnapshotV1 } from "../../renderer/shared/design-language.js";

export const MAX_DESIGN_LANGUAGE_BYTES = 24 * 1024;
export const MAX_DESIGN_LANGUAGE_HISTORY = 16;
const HEADER = "# Aiden Design Language v1\n\n```json\n";
const FOOTER = "\n```\n";
const GROUPS = ["colors", "spacing", "typography", "radii"] as const;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:@+-]{1,256}$/;
const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
// Reject control characters at the imported-document boundary.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const UNSAFE_TEXT = /[<>`]|(?:https?|file|data|javascript):|www\.|\$\{|#\{|\b(?:url|var|env|calc|attr|expression)\s*\(|(?:^|\s)(?:\/|~\/|\.{1,2}\/|[a-z]:\\)|\b[\w.-]+\/[\w./-]+|\\|%[0-9a-f]{2}|&#|\b(?:bearer\s+\S+|password\s*[:=]|api[_ -]?key\s*[:=]|secret\s*[:=]|sk-[a-z0-9]{12,}|AKIA[A-Z0-9]{12,})|(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|prior|system|developer)\b|\b(?:execute|eval|curl|wget)\b|!\[[^\]]*\]/iu;
const fail = (): never => { throw new Error("Invalid or unsafe Design Language document."); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== "string" || value.length > limit || CONTROL.test(value) || /[\ud800-\udfff]/u.test(value) || UNSAFE_TEXT.test(value)) return fail();
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if ((!empty && !normalized) || normalized.length > limit || CONTROL.test(normalized) || UNSAFE_TEXT.test(normalized)) return fail();
  return normalized;
}
function scalar(group: typeof GROUPS[number], value: unknown): string {
  const normalized = text(value, 128);
  if (group === "colors") {
    if (!/^(?:#[a-f0-9]{3}|#[a-f0-9]{4}|#[a-f0-9]{6}|#[a-f0-9]{8}|transparent|(?:rgb|rgba|hsl|hsla|oklab|oklch|lab|lch)\([0-9.+,% /-]{1,120}\))$/iu.test(normalized)) return fail();
    return normalized.toLowerCase();
  }
  if (group === "spacing" || group === "radii") {
    if (!/^(?:0|(?:[0-9]{1,4})(?:\.[0-9]{1,4})?(?:px|rem|em|%))$/u.test(normalized)) return fail();
    return normalized;
  }
  if (!/^(?:[\p{L}][\p{L}\p{N} ._-]{0,79}|[0-9]{1,4}(?:\.[0-9]{1,4})?(?:px|rem|em|%)?)$/u.test(normalized)) return fail();
  return normalized;
}
export function normalizeDesignLanguageDocument(value: unknown): DesignLanguageDocumentV1 {
  const input = record(value);
  exact(input, ["version", "name", "guidance", "tokens"]);
  if (input.version !== 1) return fail();
  const rawTokens = record(input.tokens);
  exact(rawTokens, GROUPS);
  const tokens = {} as DesignLanguageDocumentV1["tokens"];
  for (const group of GROUPS) {
    const raw = record(rawTokens[group]);
    if (Object.keys(raw).length > 48) return fail();
    tokens[group] = {};
    for (const key of Object.keys(raw).sort()) {
      if (!NAME.test(key) || ["constructor", "prototype", "__proto__"].includes(key)) return fail();
      tokens[group][key] = scalar(group, raw[key]);
    }
  }
  const document: DesignLanguageDocumentV1 = { version: 1, name: text(input.name, 100), guidance: text(input.guidance, 4000, true), tokens };
  if (Buffer.byteLength(HEADER + JSON.stringify(document, null, 2) + FOOTER, "utf8") > MAX_DESIGN_LANGUAGE_BYTES) return fail();
  return document;
}
export function designLanguageContentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeDesignLanguageDocument(value))).digest("hex");
}
export function exportDesignLanguageMarkdown(value: unknown): string {
  return HEADER + JSON.stringify(normalizeDesignLanguageDocument(value), null, 2) + FOOTER;
}
export function importDesignLanguageMarkdown(value: unknown): DesignLanguageDocumentV1 {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_DESIGN_LANGUAGE_BYTES ||
      !value.startsWith(HEADER) || !value.endsWith(FOOTER) || /\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/iu.test(value)) return fail();
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice(HEADER.length, -FOOTER.length)); } catch { return fail(); }
  const document = normalizeDesignLanguageDocument(parsed);
  // One canonical subset rejects duplicate keys, hidden payloads, and alternate
  // encodings instead of accepting a larger Markdown or YAML language.
  if (exportDesignLanguageMarkdown(document) !== value) return fail();
  return document;
}
export function normalizeDesignLanguageProvenance(value: unknown): DesignLanguageProvenanceV1 {
  const provenance = record(value);
  if (provenance.kind === "authored" || provenance.kind === "imported") {
    exact(provenance, ["kind"]);
    return { kind: provenance.kind };
  }
  if (provenance.kind === "derived") {
    exact(provenance, ["kind", "lineageId", "mediaId", "contentHash"]);
    if (typeof provenance.lineageId !== "string" || !ID.test(provenance.lineageId) || typeof provenance.mediaId !== "string" || !ID.test(provenance.mediaId) || !provenance.mediaId.startsWith("design:") || typeof provenance.contentHash !== "string" || !HASH.test(provenance.contentHash)) return fail();
    return { kind: "derived", lineageId: provenance.lineageId, mediaId: provenance.mediaId, contentHash: provenance.contentHash };
  }
  if (provenance.kind === "workspace-snapshot") {
    exact(provenance, ["kind", "id", "revision", "contentHash"]);
    const binding = parseDesignLanguageBindingV1({id: provenance.id, revision: provenance.revision, contentHash: provenance.contentHash});
    if (!binding) return fail();
    return { kind: "workspace-snapshot", ...binding };
  }
  return fail();
}
export function parseDesignLanguageSnapshots(value: unknown): DesignLanguageSnapshotV1[] | undefined {
  try {
    if (!Array.isArray(value) || value.length > MAX_DESIGN_LANGUAGE_HISTORY) return undefined;
    const ids = new Set<string>();
    return value.map(item => {
      const raw = record(item);
      exact(raw, ["id", "revision", "contentHash", "document", "provenance", "createdAt"]);
      const binding = parseDesignLanguageBindingV1({id:raw.id, revision:raw.revision, contentHash:raw.contentHash});
      if (!binding || ids.has(binding.id) || !Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) < 0) return fail();
      ids.add(binding.id);
      const document = normalizeDesignLanguageDocument(raw.document);
      if (designLanguageContentHash(document) !== binding.contentHash) return fail();
      return {...binding, document, provenance:normalizeDesignLanguageProvenance(raw.provenance), createdAt:raw.createdAt as number};
    });
  } catch { return undefined; }
}
/** Return a proposal only. Caller presents it for explicit review before saving. */
export function mergeDesignLanguageDocuments(base: unknown, incoming: unknown): DesignLanguageDocumentV1 {
  const left = normalizeDesignLanguageDocument(base);
  const right = normalizeDesignLanguageDocument(incoming);
  return normalizeDesignLanguageDocument({ ...right, tokens: Object.fromEntries(GROUPS.map(group => [group, {...left.tokens[group], ...right.tokens[group]}])) });
}
