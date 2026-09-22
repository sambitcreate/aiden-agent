import { createHash } from "node:crypto";

/**
 * Bounded extraction of explicit `Label: value` pairs from a user-selected
 * text document. Pure TypeScript — no I/O, no AX, no Core ML.
 *
 * Contract (docs/plans/form-fill-specialist-plan.md):
 * - Only explicit `Label: value` lines become entities; every entity keeps the
 *   attachment id, content hash, original label/value, and source line.
 * - Rejects binary, truncated, empty, over-limit, or conflicting input. An
 *   empty or invalid extraction fails closed before any form mutation.
 */

export const FORM_FILL_MAX_DOCUMENT_BYTES = 256 * 1024;
export const FORM_FILL_MAX_LABEL_CHARS = 96;
export const FORM_FILL_MAX_VALUE_CHARS = 256;
export const FORM_FILL_MAX_LINE_CHARS = 8 * 1024;
export const FORM_FILL_MAX_ENTITIES = 29; // 32 scorer options − 3 fixed actions
export const FORM_FILL_TRUNCATION_SUFFIX = "\n… [truncated]";

export type FormFillSourceKind = "extracted" | "derived";

export interface FormFillEntity {
  /** Position in document order. */
  index: number;
  /** Exact label text as written, minus surrounding whitespace. */
  label: string;
  /** Exact value text as written, minus surrounding whitespace. */
  value: string;
  /** 1-based source line. */
  line: number;
  /** v1 is always "extracted"; "derived" requires a separately reviewed policy. */
  sourceKind: FormFillSourceKind;
}

export interface FormFillExtraction {
  attachmentId: string;
  /** sha256 of the exact document text the entities came from. */
  contentHash: string;
  entities: FormFillEntity[];
  /** Non-fatal notes shown on the review card (e.g. duplicate identical rows). */
  issues: string[];
}

export type FormFillExtractionFailure =
  | "unsupported_type"
  | "empty"
  | "binary"
  | "truncated"
  | "too_large"
  | "too_many_entities"
  | "conflicting_duplicates"
  | "no_entities";

export class FormFillExtractionError extends Error {
  constructor(
    readonly failure: FormFillExtractionFailure,
    message: string,
  ) {
    super(message);
    this.name = "FormFillExtractionError";
  }
}

export function formFillContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const LABEL_VALUE = /^([^:\n]{1,}?):\s+(.+)$/u;

/**
 * Extract `Label: value` entities. Throws FormFillExtractionError on any fatal
 * condition — callers never continue past a rejection.
 */
export function extractFormFillEntities(input: {
  attachmentId: string;
  /** Inlined document text (Attachment.text for kind:"text" attachments). */
  text: string | undefined;
  /** Declared file size from the attachment record. */
  size: number;
  /** Attachment display name for error context. */
  name: string;
}): FormFillExtraction {
  const { attachmentId, name } = input;
  const text = input.text ?? "";
  if (input.size > FORM_FILL_MAX_DOCUMENT_BYTES) {
    throw new FormFillExtractionError(
      "too_large",
      `${name} is too large to use for form filling.`,
    );
  }
  if (text.length === 0 || text.trim().length === 0) {
    throw new FormFillExtractionError(
      "empty",
      `${name} does not contain any text to fill from.`,
    );
  }
  if (text.includes("\0") || /[￾￿]/u.test(text)) {
    throw new FormFillExtractionError(
      "binary",
      `${name} is not a plain-text document.`,
    );
  }
  if (
    text.endsWith(FORM_FILL_TRUNCATION_SUFFIX.trimEnd()) ||
    text.endsWith(FORM_FILL_TRUNCATION_SUFFIX)
  ) {
    throw new FormFillExtractionError(
      "truncated",
      `${name} is too large — its content was truncated when attached.`,
    );
  }

  const entities: FormFillEntity[] = [];
  const issues: string[] = [];
  const byNormalizedLabel = new Map<string, FormFillEntity>();
  const lines = text.split(/\r\n|\r|\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.length > FORM_FILL_MAX_LINE_CHARS) {
      issues.push(`Line ${index + 1} was too long and was skipped.`);
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//"))
      continue;
    const match = LABEL_VALUE.exec(trimmed);
    if (!match) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    if (!label.length || !value.length) continue;
    if (
      label.length > FORM_FILL_MAX_LABEL_CHARS ||
      value.length > FORM_FILL_MAX_VALUE_CHARS
    ) {
      issues.push(
        `Line ${index + 1} has an oversized label or value and was skipped.`,
      );
      continue;
    }
    const normalized = normalizeLabel(label);
    const existing = byNormalizedLabel.get(normalized);
    if (existing) {
      if (existing.value === value) {
        issues.push(`Duplicate “${label}” on line ${index + 1} was ignored.`);
        continue;
      }
      throw new FormFillExtractionError(
        "conflicting_duplicates",
        `${name} gives conflicting values for “${existing.label}” (lines ${existing.line} and ${index + 1}).`,
      );
    }
    const entity: FormFillEntity = {
      index: entities.length,
      label,
      value,
      line: index + 1,
      sourceKind: "extracted",
    };
    entities.push(entity);
    byNormalizedLabel.set(normalized, entity);
  }

  if (entities.length === 0) {
    throw new FormFillExtractionError(
      "no_entities",
      `${name} does not contain any “Label: value” lines.`,
    );
  }
  if (entities.length > FORM_FILL_MAX_ENTITIES) {
    throw new FormFillExtractionError(
      "too_many_entities",
      `${name} has ${entities.length} fields; form fill supports at most ${FORM_FILL_MAX_ENTITIES}.`,
    );
  }
  return {
    attachmentId,
    contentHash: formFillContentHash(text),
    entities,
    issues,
  };
}

/** Label normalization for de-duplication only — display keeps the original. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/gu, " ");
}
