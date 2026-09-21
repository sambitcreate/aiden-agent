/**
 * Pure TypeScript port of the pinned upstream CUA-S1 planner semantics
 * (trycua/cua libs/cua-s1 @ b7f7e2d8714609853a29c7d049140bc46aec0954:
 * schema.py + planner.py) plus Aiden's needs-review policy.
 *
 * No AX, Core ML, or I/O — unit tests run against recorded fixtures.
 * The planner never invents, transforms, normalizes, or concatenates values,
 * never emits a mutation for an entity outside the validated source set, and
 * never includes submit in a plan.
 */

import type { FormFillEntity } from "./extract-core.js";

// ---- Model tensor bounds (must match native/cua-s1-forms Encoding.swift) ----
export const FORM_FILL_CONTEXT_BYTES = 224;
export const FORM_FILL_OPTION_BYTES = 96;
export const FORM_FILL_MAX_OPTIONS = 32;
export const FORM_FILL_FIXED_ACTIONS = ["check", "click", "skip"] as const;

export type FormFillAction = "fill" | "check" | "click" | "skip";
export const ACTION_ORDER: Record<FormFillAction, number> = {
  fill: 0,
  check: 1,
  click: 2,
  skip: 3,
};

const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "edit",
  "textfield",
  "axbutton",
  "axcheckbox",
  "axcombobox",
  "axtextfield",
]);
const SUBMIT_CONTROL_ROLES = new Set(["button", "axbutton"]);
const SUBMIT_CONTROL_LABELS = new Set(["submit", "submit form"]);
const CHECKBOX_ROLES = new Set(["checkbox", "axcheckbox"]);

/** Controls whose toggle has consequential meaning — never auto-batch. */
const CONSEQUENTIAL_CHECKBOX_PATTERN =
  /\b(consent|terms|conditions|agree|agreement|legal|waiver|liability|privacy|policy|subscribe|newsletter|marketing|opt[\s-]?in|opt[\s-]?out|share my|third[\s-]?party|sms|texts|alerts)\b/iu;

// ---- Inputs -----------------------------------------------------------------

/** Planner-facing element view (normalized from controller ElementRecord). */
export interface FormFillElement {
  index: number;
  token?: string;
  role?: string;
  label?: string;
  value?: string;
  checked?: boolean;
  actions?: string[];
}

export interface FormFillPlannerInput {
  /** Exact extracted entities — the only value source. */
  entities: readonly FormFillEntity[];
  /** Current exact-window observation. */
  elements: readonly FormFillElement[];
  /** Target window title (form title source). */
  formTitle: string;
  /** Model score for each element: aligned distributions over options. */
  scores: readonly FormFillElementScore[];
}

export interface FormFillElementScore {
  elementIndex: number;
  /** Argmax option index within the rendered option list. */
  selectedIndex: number;
  /** Stable probabilities aligned with rendered options. */
  probabilities: readonly number[];
  contextWasTruncated: boolean;
  truncatedOptionIndices: readonly number[];
}

// ---- Thresholds (evaluated against fixtures; see plan doc) -------------------

export interface FormFillPlannerThresholds {
  /** Below this top probability → needs_review (probs are NOT calibrated). */
  minTopProbability: number;
  /** Below this top-two margin → needs_review. */
  minMargin: number;
  /** Context or selected-option truncation beyond this byte share is material. */
  materialTruncation: "any" | "never";
}

export const FORM_FILL_DEFAULT_THRESHOLDS: FormFillPlannerThresholds = {
  minTopProbability: 0.5,
  minMargin: 0.15,
  materialTruncation: "any",
};

// ---- Upstream rendering (byte-exact) -----------------------------------------

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Whether a string exceeds a UTF-8 byte budget (matches the model encoding). */
export function utf8Truncated(text: string, maxBytes: number): boolean {
  return utf8Bytes(text).length > maxBytes;
}

/**
 * Byte-limit truncation for display/provenance copies — stops at the last
 * complete code point. The scorer itself truncates raw bytes exactly like
 * upstream; this only reports whether truncation occurred.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = utf8Bytes(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder("utf-8").decode(bytes.subarray(0, end)), truncated: true };
}

export function normalizeRole(role: string): string {
  return role.replace(/[_\s]/gu, "").toLowerCase();
}

export function normalizedControlLabel(label: string): string {
  return (label.toLowerCase().match(/[a-z0-9]+/gu) ?? []).join(" ");
}

export function isSubmitControl(element: FormFillElement): boolean {
  return (
    !!element.role &&
    SUBMIT_CONTROL_ROLES.has(normalizeRole(element.role)) &&
    SUBMIT_CONTROL_LABELS.has(normalizedControlLabel(element.label ?? ""))
  );
}

/** Upstream `render_context` — exact format, byte-limit truncation only. */
export function renderContext(
  formTitle: string,
  element: FormFillElement,
  placeholder = "",
): string {
  const role = element.role ?? "";
  const state =
    normalizeRole(role) === "checkbox" || role === "CheckBox"
      ? element.checked === true
        ? "checked"
        : "unchecked"
      : `value="${(element.value ?? "").slice(0, 48)}"`;
  const hint = placeholder ? ` hint="${placeholder.slice(0, 72)}"` : "";
  return (
    "TASK fill the form from the document, then submit\n" +
    `FORM ${formTitle.slice(0, 64)}\n` +
    `ELEMENT ${role} "${(element.label ?? "").slice(0, 72)}" ${state}${hint}`
  );
}

/** Upstream `render_options` — one fill option per entity plus fixed actions. */
export function renderOptions(entities: readonly FormFillEntity[]): string[] {
  return [
    ...entities.map((entity) => `fill ${entity.label}: ${entity.value}`),
    ...FORM_FILL_FIXED_ACTIONS,
  ];
}

/** Upstream `decode` — only valid indices decode to an action. */
export function decodeOption(
  optionIndex: number,
  entityCount: number,
): { action: FormFillAction; entityIndex?: number } {
  const optionCount = entityCount + FORM_FILL_FIXED_ACTIONS.length;
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= optionCount) {
    throw new Error(`Option index ${optionIndex} is outside 0..${optionCount - 1}`);
  }
  if (optionIndex < entityCount) return { action: "fill", entityIndex: optionIndex };
  return { action: FORM_FILL_FIXED_ACTIONS[optionIndex - entityCount] };
}

export function filterActionable(elements: readonly FormFillElement[]): FormFillElement[] {
  return elements.filter(
    (element) => element.role && ACTIONABLE_ROLES.has(normalizeRole(element.role)),
  );
}

// ---- Plan rows ----------------------------------------------------------------

export type FormFillPlanOutcome = "fill" | "needs_review" | "skip";

export interface FormFillPlanRow {
  elementIndex: number;
  /** Element token at plan time; execution always reacquires on a fresh snapshot. */
  elementToken?: string;
  role: string;
  label: string;
  action: FormFillAction;
  outcome: FormFillPlanOutcome;
  /** Entity index into the source set when action === "fill". */
  entityIndex?: number;
  /** Exact value to write — copied verbatim from the entity, never derived. */
  value?: string;
  /** Human-readable reason when outcome !== "fill". */
  reason?: string;
  /** Provenance echoed back for the review card. */
  source?: { entityIndex: number; label: string; line: number };
}

export interface FormFillPlan {
  rows: FormFillPlanRow[];
  /** Fills only — the only executable v1 mutations. */
  fills: FormFillPlanRow[];
  /** True when any row needs review. */
  hasReview: boolean;
}

function topTwo(probabilities: readonly number[]): { top: number; margin: number } {
  let first = -Infinity;
  let second = -Infinity;
  for (const p of probabilities) {
    if (p > first) {
      second = first;
      first = p;
    } else if (p > second) {
      second = p;
    }
  }
  return { top: first, margin: first - (second === -Infinity ? 0 : second) };
}

function optionTruncated(
  score: FormFillElementScore,
  selectedIndex: number,
): boolean {
  return score.truncatedOptionIndices.includes(selectedIndex);
}

/**
 * Decide the outcome of one element from its score + element state.
 * Order of checks is deliberate: anything unsafe resolves to needs_review or
 * skip before a fill is allowed.
 */
function decideElement(
  element: FormFillElement,
  entities: readonly FormFillEntity[],
  score: FormFillElementScore,
  thresholds: FormFillPlannerThresholds,
): FormFillPlanRow {
  const base = {
    elementIndex: element.index,
    elementToken: element.token,
    role: element.role ?? "",
    label: element.label ?? "",
  };
  const review = (reason: string, action: FormFillAction = "skip"): FormFillPlanRow => ({
    ...base,
    action,
    outcome: "needs_review",
    reason,
  });
  const skip = (reason: string): FormFillPlanRow => ({
    ...base,
    action: "skip",
    outcome: "skip",
    reason,
  });

  const role = normalizeRole(element.role ?? "");
  if (!ACTIONABLE_ROLES.has(role)) {
    return skip("Element is not a form control.");
  }
  if (isSubmitControl(element)) {
    return skip("Submit buttons are never part of the fill batch.");
  }

  let decoded: { action: FormFillAction; entityIndex?: number };
  try {
    decoded = decodeOption(score.selectedIndex, entities.length);
  } catch {
    return review("The model selected an invalid option.");
  }

  const { top, margin } = topTwo(score.probabilities);

  if (decoded.action === "skip") {
    return review("The model chose to skip this field.", "skip");
  }
  if (top < thresholds.minTopProbability) {
    return review("The model was not confident enough to fill this field.", decoded.action);
  }
  if (margin < thresholds.minMargin) {
    return review("The model could not clearly choose one field value.", decoded.action);
  }
  if (thresholds.materialTruncation === "any" && score.contextWasTruncated) {
    return review("The field context was truncated before scoring.", decoded.action);
  }
  if (optionTruncated(score, score.selectedIndex)) {
    return review("The selected option was truncated before scoring.", decoded.action);
  }

  if (decoded.action === "check") {
    if (!CHECKBOX_ROLES.has(role)) {
      return review("The model tried to check a non-checkbox control.", "check");
    }
    if (element.checked === undefined || element.checked === null) {
      return review("Checkbox state is unknown; it was not toggled.", "check");
    }
    if (element.checked) {
      return skip("Checkbox is already checked.");
    }
    const label = `${element.label ?? ""}`;
    if (CONSEQUENTIAL_CHECKBOX_PATTERN.test(label)) {
      return review("This control needs your review (consent, terms, or similar).", "check");
    }
    if (!element.actions?.some((a) => /press|click|toggle|check/iu.test(a))) {
      return review("The control does not advertise a toggle action.", "check");
    }
    // v1: `check` is scored but not auto-executed; keep it reviewable.
    return review("Checkbox fills require your confirmation per field.", "check");
  }
  if (decoded.action === "click") {
    // Submit is filtered above; any other click is unsupported in v1.
    return review("This control is not a text field Aiden can fill.", "click");
  }

  // action === "fill"
  const entityIndex = decoded.entityIndex!;
  const entity = entities[entityIndex];
  if (!entity) {
    return review("The model selected an entity that does not exist.");
  }
  const fillable =
    role === "edit" ||
    role === "textfield" ||
    role === "combobox" ||
    role === "axedit" ||
    role === "axtextfield" ||
    role === "axcombobox" ||
    role === "axsecuretextfield";
  if (!fillable) {
    return review(`A ${element.role ?? "control"} cannot be filled with text.`, "fill");
  }
  const existing = (element.value ?? "").trim();
  if (existing.length > 0) {
    if (existing === entity.value.trim()) {
      return skip("Field already contains this value.");
    }
    return review("Field already contains a different value.", "fill");
  }
  return {
    ...base,
    action: "fill",
    outcome: "fill",
    entityIndex,
    value: entity.value,
    source: { entityIndex, label: entity.label, line: entity.line },
  };
}

/**
 * Build the full plan. Every actionable element gets exactly one row;
 * fills are ordered deterministically by element index (upstream ACTION_ORDER
 * is moot in v1 since only fills execute).
 */
export function planFormFill(
  input: FormFillPlannerInput,
  thresholds: FormFillPlannerThresholds = FORM_FILL_DEFAULT_THRESHOLDS,
): FormFillPlan {
  const actionable = filterActionable(input.elements);
  const scoreByIndex = new Map(input.scores.map((s) => [s.elementIndex, s]));
  const rows: FormFillPlanRow[] = [];
  for (const element of actionable) {
    const score = scoreByIndex.get(element.index);
    if (!score) {
      rows.push({
        elementIndex: element.index,
        elementToken: element.token,
        role: element.role ?? "",
        label: element.label ?? "",
        action: "skip",
        outcome: "needs_review",
        reason: "No model score was returned for this field.",
      });
      continue;
    }
    rows.push(decideElement(element, input.entities, score, thresholds));
  }
  // Upstream ordering semantics on executable rows; deterministic ties by index.
  const fills = rows
    .filter((row) => row.outcome === "fill" && row.action === "fill")
    .sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.elementIndex - b.elementIndex);
  return { rows, fills, hasReview: rows.some((row) => row.outcome === "needs_review") };
}
