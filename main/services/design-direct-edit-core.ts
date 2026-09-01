import { createHash } from "node:crypto";

export const DESIGN_DIRECT_EDIT_VERSION = 1 as const;
export const MAX_DESIGN_DIRECT_EDIT_BYTES = 96 * 1024;
export const MAX_DESIGN_DIRECT_EDIT_PREIMAGE_BYTES = 64 * 1024;

const SAFE_ID = /^[A-Za-z0-9._:@+-]{1,256}$/u;
const SAFE_HASH = /^[a-f0-9]{64}$/u;
const SAFE_SELECTOR_TAG = /^[a-z][a-z0-9-]{0,31}$/u;
const SAFE_TOKEN = /^--[a-z][a-z0-9-]{0,62}$/u;
const SAFE_PATH_SEGMENT = /^(?!\.\.?$)[^/\\]+$/u;
const CSS_NUMBER = /^(0|(?:[0-9]{1,4}(?:\.[0-9]{1,3})?)(px|rem))$/u;
const CSS_SIZE =
  /^(auto|0|(?:[0-9]{1,4}(?:\.[0-9]{1,3})?)(px|rem)|(?:[0-9]{1,3}(?:\.[0-9]{1,3})?)%)$/u;

export interface DesignDirectEditSelectionV1 {
  selector: string;
  tagName: string;
  elementId?: string;
}

export interface DesignDirectEditProofV1 {
  selectorMatchCount: 1;
  componentMatchCount: 1;
  literalDefinitionMatchCount: 1;
  computedClass: false;
  dynamicValue: false;
  localizedText: false;
  richText: false;
  /** Exact semantic color tokens available in the bound design-system snapshot. */
  semanticColorTokens: string[];
}

export type DesignDirectEditTargetV1 =
  | {
      origin: "prototype";
      projectId: string;
      lineageId: string;
      mediaId: string;
      artifactId: string;
      selection: DesignDirectEditSelectionV1;
      proof: DesignDirectEditProofV1;
    }
  | {
      origin: "connected-app";
      projectId: string;
      lineageId: string;
      mediaId: string;
      workspaceId: string;
      path: string;
      sourceVersion: string;
      start: number;
      end: number;
      preimage: string;
      preimageHash: string;
      selection: DesignDirectEditSelectionV1;
      proof: DesignDirectEditProofV1;
    };

export type DesignDirectEditV1 =
  | {
      kind: "spacing";
      property:
        | "margin"
        | "margin-top"
        | "margin-right"
        | "margin-bottom"
        | "margin-left"
        | "padding"
        | "padding-top"
        | "padding-right"
        | "padding-bottom"
        | "padding-left"
        | "gap"
        | "row-gap"
        | "column-gap";
      value: string;
    }
  | { kind: "size"; property: "width" | "height"; value: string }
  | {
      kind: "alignment";
      property: "align-items" | "justify-content" | "text-align";
      value:
        | "start"
        | "center"
        | "end"
        | "stretch"
        | "space-between"
        | "space-around"
        | "left"
        | "right";
    }
  | {
      kind: "color-token";
      property: "color" | "background-color" | "border-color";
      token: string;
    }
  | {
      kind: "radius";
      property:
        | "border-radius"
        | "border-top-left-radius"
        | "border-top-right-radius"
        | "border-bottom-right-radius"
        | "border-bottom-left-radius";
      value: string;
    }
  | { kind: "static-text"; text: string };

export interface PrototypeDirectEditRevisionRequestV1 {
  version: typeof DESIGN_DIRECT_EDIT_VERSION;
  kind: "prototype-revision-request";
  proposalId: string;
  undoId: string;
  gestureId: string;
  projectId: string;
  lineageId: string;
  baseMediaId: string;
  expectedArtifactId: string;
  selection: DesignDirectEditSelectionV1;
  edit: DesignDirectEditV1;
  mutationRule: "create-immutable-artifact-revision";
}

export interface ConnectedDirectEditDesignerActionRequestV1 {
  version: typeof DESIGN_DIRECT_EDIT_VERSION;
  kind: "designer-action-request";
  proposalId: string;
  undoId: string;
  gestureId: string;
  projectId: string;
  lineageId: string;
  baseMediaId: string;
  workspaceId: string;
  path: string;
  sourceVersion: string;
  start: number;
  end: number;
  preimage: string;
  preimageHash: string;
  selection: DesignDirectEditSelectionV1;
  edit: DesignDirectEditV1;
  mutationRule: "review-designer-action";
}

export type DesignDirectEditProposalV1 =
  | PrototypeDirectEditRevisionRequestV1
  | ConnectedDirectEditDesignerActionRequestV1;

const PROTOTYPE_TARGET_KEYS = new Set([
  "origin",
  "projectId",
  "lineageId",
  "mediaId",
  "artifactId",
  "selection",
  "proof",
]);
const CONNECTED_TARGET_KEYS = new Set([
  "origin",
  "projectId",
  "lineageId",
  "mediaId",
  "workspaceId",
  "path",
  "sourceVersion",
  "start",
  "end",
  "preimage",
  "preimageHash",
  "selection",
  "proof",
]);
const SELECTION_KEYS = new Set(["selector", "tagName", "elementId"]);
const SELECTION_REQUIRED_KEYS = new Set(["selector", "tagName"]);
const PROOF_KEYS = new Set([
  "selectorMatchCount",
  "componentMatchCount",
  "literalDefinitionMatchCount",
  "computedClass",
  "dynamicValue",
  "localizedText",
  "richText",
  "semanticColorTokens",
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
  allowNewlines = false,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > maxChars ||
    value.normalize("NFKC") !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f || code === 0 || (!allowNewlines && code <= 0x1f))
      return false;
    if (allowNewlines && code <= 0x1f && code !== 0x09 && code !== 0x0a)
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

function parseSelection(
  value: unknown,
): DesignDirectEditSelectionV1 | undefined {
  const selection = record(value);
  if (
    !selection ||
    !exactKeys(selection, SELECTION_KEYS, SELECTION_REQUIRED_KEYS)
  )
    return undefined;
  if (
    !safePlainText(selection.selector, 512) ||
    selection.selector.trim() !== selection.selector ||
    !safePlainText(selection.tagName, 32) ||
    !SAFE_SELECTOR_TAG.test(selection.tagName) ||
    (selection.elementId !== undefined && !safeId(selection.elementId))
  ) {
    return undefined;
  }
  return {
    selector: selection.selector,
    tagName: selection.tagName,
    ...(selection.elementId === undefined
      ? {}
      : { elementId: selection.elementId }),
  };
}

function parseProof(value: unknown): DesignDirectEditProofV1 | undefined {
  const proof = record(value);
  const suppliedSemanticColorTokens = Array.isArray(proof?.semanticColorTokens)
    ? proof.semanticColorTokens
    : undefined;
  const semanticColorTokens = Array.isArray(proof?.semanticColorTokens)
    ? proof.semanticColorTokens.filter(
        (token): token is string =>
          typeof token === "string" && SAFE_TOKEN.test(token),
      )
    : undefined;
  return proof &&
    exactKeys(proof, PROOF_KEYS) &&
    proof.selectorMatchCount === 1 &&
    proof.componentMatchCount === 1 &&
    proof.literalDefinitionMatchCount === 1 &&
    proof.computedClass === false &&
    proof.dynamicValue === false &&
    proof.localizedText === false &&
    proof.richText === false &&
    semanticColorTokens !== undefined &&
    suppliedSemanticColorTokens !== undefined &&
    semanticColorTokens.length <= 256 &&
    semanticColorTokens.length === suppliedSemanticColorTokens.length &&
    new Set(semanticColorTokens).size === semanticColorTokens.length
    ? {
        selectorMatchCount: 1,
        componentMatchCount: 1,
        literalDefinitionMatchCount: 1,
        computedClass: false,
        dynamicValue: false,
        localizedText: false,
        richText: false,
        semanticColorTokens: [...semanticColorTokens].sort(),
      }
    : undefined;
}

export function parseDesignDirectEditTarget(
  value: unknown,
): DesignDirectEditTargetV1 | undefined {
  const target = record(value);
  if (!target) return undefined;
  const keys =
    target.origin === "prototype"
      ? PROTOTYPE_TARGET_KEYS
      : CONNECTED_TARGET_KEYS;
  if (!exactKeys(target, keys)) return undefined;
  if (
    !safeId(target.projectId) ||
    !safeId(target.lineageId) ||
    !safeId(target.mediaId)
  ) {
    return undefined;
  }
  const selection = parseSelection(target.selection);
  const proof = parseProof(target.proof);
  if (!selection || !proof) return undefined;
  if (target.origin === "prototype") {
    if (!safeHash(target.artifactId)) return undefined;
    return {
      origin: "prototype",
      projectId: target.projectId,
      lineageId: target.lineageId,
      mediaId: target.mediaId,
      artifactId: target.artifactId,
      selection,
      proof,
    };
  }
  if (
    target.origin !== "connected-app" ||
    !safeId(target.workspaceId) ||
    !safePath(target.path) ||
    !safeHash(target.sourceVersion) ||
    !safeOffset(target.start) ||
    !safeOffset(target.end) ||
    target.end <= target.start ||
    !safePlainText(target.preimage, 64 * 1024, true) ||
    Buffer.byteLength(target.preimage, "utf8") >
      MAX_DESIGN_DIRECT_EDIT_PREIMAGE_BYTES ||
    target.end - target.start !== target.preimage.length ||
    !safeHash(target.preimageHash) ||
    createHash("sha256").update(target.preimage).digest("hex") !==
      target.preimageHash
  ) {
    return undefined;
  }
  return {
    origin: "connected-app",
    projectId: target.projectId,
    lineageId: target.lineageId,
    mediaId: target.mediaId,
    workspaceId: target.workspaceId,
    path: target.path,
    sourceVersion: target.sourceVersion,
    start: target.start,
    end: target.end,
    preimage: target.preimage,
    preimageHash: target.preimageHash,
    selection,
    proof,
  };
}

const SPACING_PROPERTIES = new Set([
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "gap",
  "row-gap",
  "column-gap",
]);
const ALIGNMENT_VALUES: Record<string, ReadonlySet<string>> = {
  "align-items": new Set(["start", "center", "end", "stretch"]),
  "justify-content": new Set([
    "start",
    "center",
    "end",
    "space-between",
    "space-around",
  ]),
  "text-align": new Set(["left", "center", "right", "start", "end"]),
};
const RADIUS_PROPERTIES = new Set([
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
]);

function boundedCssNumber(value: unknown, expression: RegExp): value is string {
  if (typeof value !== "string" || !expression.test(value)) return false;
  if (value === "0" || value === "auto") return true;
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number) || number < 0) return false;
  if (value.endsWith("%")) return number <= 100;
  if (value.endsWith("rem")) return number <= 256;
  return number <= 4096;
}

export function parseDesignDirectEdit(
  value: unknown,
): DesignDirectEditV1 | undefined {
  const edit = record(value);
  if (!edit || typeof edit.kind !== "string") return undefined;
  if (edit.kind === "spacing") {
    return exactKeys(edit, new Set(["kind", "property", "value"])) &&
      typeof edit.property === "string" &&
      SPACING_PROPERTIES.has(edit.property) &&
      boundedCssNumber(edit.value, CSS_NUMBER)
      ? (edit as unknown as DesignDirectEditV1)
      : undefined;
  }
  if (edit.kind === "size") {
    return exactKeys(edit, new Set(["kind", "property", "value"])) &&
      (edit.property === "width" || edit.property === "height") &&
      boundedCssNumber(edit.value, CSS_SIZE)
      ? (edit as unknown as DesignDirectEditV1)
      : undefined;
  }
  if (edit.kind === "alignment") {
    return exactKeys(edit, new Set(["kind", "property", "value"])) &&
      typeof edit.property === "string" &&
      typeof edit.value === "string" &&
      ALIGNMENT_VALUES[edit.property]?.has(edit.value)
      ? (edit as unknown as DesignDirectEditV1)
      : undefined;
  }
  if (edit.kind === "color-token") {
    return exactKeys(edit, new Set(["kind", "property", "token"])) &&
      (edit.property === "color" ||
        edit.property === "background-color" ||
        edit.property === "border-color") &&
      typeof edit.token === "string" &&
      SAFE_TOKEN.test(edit.token)
      ? (edit as unknown as DesignDirectEditV1)
      : undefined;
  }
  if (edit.kind === "radius") {
    return exactKeys(edit, new Set(["kind", "property", "value"])) &&
      typeof edit.property === "string" &&
      RADIUS_PROPERTIES.has(edit.property) &&
      boundedCssNumber(edit.value, CSS_NUMBER)
      ? (edit as unknown as DesignDirectEditV1)
      : undefined;
  }
  if (edit.kind === "static-text") {
    return exactKeys(edit, new Set(["kind", "text"])) &&
      safePlainText(edit.text, 2_000, true) &&
      Buffer.byteLength(edit.text, "utf8") <= 8 * 1024 &&
      !/[<>{}]/u.test(edit.text)
      ? { kind: "static-text", text: edit.text }
      : undefined;
  }
  return undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function proposeDesignDirectEdit(input: {
  gestureId: string;
  target: DesignDirectEditTargetV1;
  edit: DesignDirectEditV1;
}): DesignDirectEditProposalV1 {
  if (!safeId(input.gestureId))
    throw new Error("Invalid Design direct-edit gesture identity.");
  const target = parseDesignDirectEditTarget(input.target);
  const edit = parseDesignDirectEdit(input.edit);
  if (!target || !edit)
    throw new Error("The direct edit is not proven safe and literal.");
  if (
    edit.kind === "color-token" &&
    !target.proof.semanticColorTokens.includes(edit.token)
  ) {
    throw new Error(
      "The color token is not present in the bound semantic design system.",
    );
  }
  const bounded = { gestureId: input.gestureId, target, edit };
  if (
    Buffer.byteLength(canonical(bounded), "utf8") > MAX_DESIGN_DIRECT_EDIT_BYTES
  ) {
    throw new Error("The Design direct edit is too large.");
  }
  const identity = createHash("sha256")
    .update(canonical(bounded))
    .digest("hex");
  const common = {
    version: DESIGN_DIRECT_EDIT_VERSION,
    proposalId: `proposal:${identity}`,
    undoId: `undo:${identity}`,
    gestureId: input.gestureId,
    projectId: target.projectId,
    lineageId: target.lineageId,
    baseMediaId: target.mediaId,
    selection: target.selection,
    edit,
  } as const;
  if (target.origin === "prototype") {
    return {
      ...common,
      kind: "prototype-revision-request",
      expectedArtifactId: target.artifactId,
      mutationRule: "create-immutable-artifact-revision",
    };
  }
  return {
    ...common,
    kind: "designer-action-request",
    workspaceId: target.workspaceId,
    path: target.path,
    sourceVersion: target.sourceVersion,
    start: target.start,
    end: target.end,
    preimage: target.preimage,
    preimageHash: target.preimageHash,
    mutationRule: "review-designer-action",
  };
}
