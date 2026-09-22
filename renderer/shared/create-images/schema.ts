export const CREATE_IMAGES_SCHEMA_VERSION = 5 as const;
export const CREATE_IMAGES_LEGACY_SCHEMA_VERSION = 1 as const;
export const CREATE_IMAGES_PRESENTATION_SCHEMA_VERSION = 2 as const;
export const CREATE_IMAGES_ANNOTATION_SCHEMA_VERSION = 3 as const;
export const CREATE_IMAGES_POWER_SCHEMA_VERSION = 4 as const;
export const CREATE_IMAGES_MAX_NODES = 500;
export const CREATE_IMAGES_MAX_EDGES = 2_000;
export const CREATE_IMAGES_MAX_ASSET_REFS = 2_000;
export const CREATE_IMAGES_MAX_PROMPT_LENGTH = 32_000;
export const CREATE_IMAGES_MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;
export const CREATE_IMAGES_MAX_TOTAL_ASSET_BYTES = 10 * 1024 * 1024 * 1024;
export const CREATE_IMAGES_MIN_ZOOM = 0.1;
export const CREATE_IMAGES_MAX_ZOOM = 2;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
export const CREATE_IMAGES_ASSET_ID_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const TIMESTAMP_MAX_LENGTH = 64;
export const CREATE_IMAGES_POSITION_LIMIT = 1_000_000;

export const CREATE_IMAGES_NODE_TYPES = [
  "image-input",
  "prompt",
  "prompt-list",
  "generate-image",
  "output",
  "output-gallery",
  "image-compare",
  "annotation",
  "group",
] as const;

export type CreateImagesNodeType = (typeof CREATE_IMAGES_NODE_TYPES)[number];
export type CreateImagesAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";
export type CreateImagesImageSize = "1K" | "2K" | "4K";
export type CreateImagesOutputMime = "image/png" | "image/jpeg";
export const CREATE_IMAGES_MAX_ANNOTATION_SHAPES = 256;
export const CREATE_IMAGES_MAX_ANNOTATION_POINTS = 2_048;
export const CREATE_IMAGES_ANNOTATION_COLORS = [
  "accent",
  "red",
  "green",
  "yellow",
  "white",
  "black",
] as const;
export type CreateImagesAnnotationColor = (typeof CREATE_IMAGES_ANNOTATION_COLORS)[number];
export const CREATE_IMAGES_MAX_PROMPT_VARIABLES = 32;
export const CREATE_IMAGES_PROMPT_VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;

export interface CreateImagesPromptVariable {
  id: string;
  name: string;
  required: boolean;
}

interface CreateImagesAnnotationShapeBase {
  id: string;
  x: number;
  y: number;
  stroke: CreateImagesAnnotationColor;
  strokeWidth: number;
}

export type CreateImagesAnnotationShape =
  | (CreateImagesAnnotationShapeBase & {
      type: "rectangle";
      width: number;
      height: number;
      fill?: CreateImagesAnnotationColor;
    })
  | (CreateImagesAnnotationShapeBase & {
      type: "ellipse";
      width: number;
      height: number;
      fill?: CreateImagesAnnotationColor;
    })
  | (CreateImagesAnnotationShapeBase & {
      type: "arrow";
      points: [number, number, number, number];
    })
  | (CreateImagesAnnotationShapeBase & {
      type: "freehand";
      points: number[];
    })
  | (CreateImagesAnnotationShapeBase & {
      type: "text";
      text: string;
      fontSize: number;
    });

export interface CreateImagesPosition {
  x: number;
  y: number;
}

export interface CreateImagesNodeDimensions {
  width: number;
  height: number;
}

export interface CreateImagesNodeComment {
  text: string;
  unread?: boolean;
}

interface CreateImagesNodeBase<TType extends CreateImagesNodeType, TData> {
  id: string;
  type: TType;
  position: CreateImagesPosition;
  data: TData;
  title?: string;
  dimensions?: CreateImagesNodeDimensions;
  comment?: CreateImagesNodeComment;
}

export type ImageInputNodeV1 = CreateImagesNodeBase<
  "image-input",
  { assetId?: string; label?: string }
>;
export type PromptNodeV1 = CreateImagesNodeBase<
  "prompt",
  { text: string; variables?: CreateImagesPromptVariable[] }
>;
export type PromptListNodeV5 = CreateImagesNodeBase<
  "prompt-list",
  { source: string; format: "lines" | "json" }
>;
export type GenerateImageNodeV1 = CreateImagesNodeBase<
  "generate-image",
  {
    providerId?: "gemini";
    modelId?: string;
    aspectRatio: CreateImagesAspectRatio;
    imageSize: CreateImagesImageSize;
    outputMime: CreateImagesOutputMime;
    count: 1 | 2 | 3 | 4;
  }
>;
export type OutputNodeV1 = CreateImagesNodeBase<"output", { label?: string }>;
export type OutputGalleryNodeV1 = CreateImagesNodeBase<"output-gallery", { label?: string }>;
export type ImageCompareNodeV2 = CreateImagesNodeBase<"image-compare", { divider: number }>;
export type AnnotationNodeV3 = CreateImagesNodeBase<
  "annotation",
  { shapes: CreateImagesAnnotationShape[] }
>;
export type GroupNodeV4 = CreateImagesNodeBase<
  "group",
  {
    memberNodeIds: string[];
    color: "blue" | "green" | "orange" | "purple" | "gray";
    locked: boolean;
  }
>;

export type WorkflowNodeV1 =
  | ImageInputNodeV1
  | PromptNodeV1
  | PromptListNodeV5
  | GenerateImageNodeV1
  | OutputNodeV1
  | OutputGalleryNodeV1
  | ImageCompareNodeV2
  | AnnotationNodeV3
  | GroupNodeV4;

export interface WorkflowEdgeV1 {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  breakpoint?: boolean;
}

export interface WorkflowDocumentV1 {
  schemaVersion:
    | typeof CREATE_IMAGES_LEGACY_SCHEMA_VERSION
    | typeof CREATE_IMAGES_PRESENTATION_SCHEMA_VERSION
    | typeof CREATE_IMAGES_ANNOTATION_SCHEMA_VERSION
    | typeof CREATE_IMAGES_POWER_SCHEMA_VERSION
    | typeof CREATE_IMAGES_SCHEMA_VERSION;
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  viewport?: { x: number; y: number; zoom: number };
  nodes: WorkflowNodeV1[];
  edges: WorkflowEdgeV1[];
  assetRefs: string[];
  settings: {
    concurrency: 1 | 2 | 3 | 4;
    defaultProviderId?: "gemini";
  };
}

export interface WorkflowParseIssue {
  path: string;
  code: "invalid_type" | "invalid_value" | "unknown_field" | "too_large" | "duplicate";
  message: string;
}

export type WorkflowParseResult =
  | { success: true; value: WorkflowDocumentV1 }
  | { success: false; issues: WorkflowParseIssue[] };

export function createImagesWorkflowSerializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized !== "string") return undefined;
    return new TextEncoder().encode(`${serialized}\n`).byteLength;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push({ path, code: "invalid_type", message: "Expected an object." });
    return undefined;
  }
  return value;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: WorkflowParseIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(record)) {
    if (!allowedSet.has(field)) {
      issues.push({
        path: `${path}.${field}`,
        code: "unknown_field",
        message: `Unknown field "${field}".`,
      });
    }
  }
}

function stringAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
  options: { maxLength: number; pattern?: RegExp; optional?: boolean },
): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") {
    issues.push({ path, code: "invalid_type", message: "Expected a string." });
    return undefined;
  }
  if (value.length === 0 || value.length > options.maxLength) {
    issues.push({
      path,
      code: value.length > options.maxLength ? "too_large" : "invalid_value",
      message: `Expected between 1 and ${options.maxLength} characters.`,
    });
    return undefined;
  }
  if (options.pattern && !options.pattern.test(value)) {
    issues.push({ path, code: "invalid_value", message: "Invalid identifier." });
    return undefined;
  }
  return value;
}

function optionalLabelAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({ path, code: "invalid_type", message: "Expected a string." });
    return undefined;
  }
  if (value.length > 120) {
    issues.push({ path, code: "too_large", message: "Labels are limited to 120 characters." });
    return undefined;
  }
  return value;
}

function finiteNumberAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, code: "invalid_type", message: "Expected a finite number." });
    return undefined;
  }
  if (value < min || value > max) {
    issues.push({ path, code: "invalid_value", message: `Expected ${min} through ${max}.` });
    return undefined;
  }
  return value;
}

function integerAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
  min: number,
  max: number,
): number | undefined {
  const number = finiteNumberAt(value, path, issues, min, max);
  if (number !== undefined && !Number.isInteger(number)) {
    issues.push({ path, code: "invalid_value", message: "Expected an integer." });
    return undefined;
  }
  return number;
}

function enumAt<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: WorkflowParseIssue[],
  optional = false,
): T | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.push({
      path,
      code: "invalid_value",
      message: `Expected one of: ${allowed.join(", ")}.`,
    });
    return undefined;
  }
  return value as T;
}

function timestampAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
): string | undefined {
  const timestamp = stringAt(value, path, issues, { maxLength: TIMESTAMP_MAX_LENGTH });
  if (timestamp !== undefined && !Number.isFinite(Date.parse(timestamp))) {
    issues.push({ path, code: "invalid_value", message: "Expected an ISO-8601 timestamp." });
    return undefined;
  }
  return timestamp;
}

function positionAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
): CreateImagesPosition | undefined {
  const record = recordAt(value, path, issues);
  if (!record) return undefined;
  rejectUnknownFields(record, ["x", "y"], path, issues);
  const x = finiteNumberAt(
    record.x,
    `${path}.x`,
    issues,
    -CREATE_IMAGES_POSITION_LIMIT,
    CREATE_IMAGES_POSITION_LIMIT,
  );
  const y = finiteNumberAt(
    record.y,
    `${path}.y`,
    issues,
    -CREATE_IMAGES_POSITION_LIMIT,
    CREATE_IMAGES_POSITION_LIMIT,
  );
  return x === undefined || y === undefined ? undefined : { x, y };
}

function nodePresentationAt(
  record: Record<string, unknown>,
  path: string,
  issues: WorkflowParseIssue[],
): Pick<WorkflowNodeV1, "title" | "dimensions" | "comment"> {
  const title = stringAt(record.title, `${path}.title`, issues, {
    maxLength: 120,
    optional: true,
  });
  let dimensions: CreateImagesNodeDimensions | undefined;
  if (record.dimensions !== undefined) {
    const value = recordAt(record.dimensions, `${path}.dimensions`, issues);
    if (value) {
      rejectUnknownFields(value, ["width", "height"], `${path}.dimensions`, issues);
      const width = finiteNumberAt(value.width, `${path}.dimensions.width`, issues, 180, 1_200);
      const height = finiteNumberAt(value.height, `${path}.dimensions.height`, issues, 120, 1_600);
      if (width !== undefined && height !== undefined) dimensions = { width, height };
    }
  }
  let comment: CreateImagesNodeComment | undefined;
  if (record.comment !== undefined) {
    const value = recordAt(record.comment, `${path}.comment`, issues);
    if (value) {
      rejectUnknownFields(value, ["text", "unread"], `${path}.comment`, issues);
      const text = stringAt(value.text, `${path}.comment.text`, issues, { maxLength: 2_000 });
      const unread = value.unread;
      if (unread !== undefined && typeof unread !== "boolean") {
        issues.push({
          path: `${path}.comment.unread`,
          code: "invalid_type",
          message: "Expected a boolean.",
        });
      }
      if (text && (unread === undefined || typeof unread === "boolean")) {
        comment = { text, ...(unread === true ? { unread: true } : {}) };
      }
    }
  }
  return {
    ...(title ? { title } : {}),
    ...(dimensions ? { dimensions } : {}),
    ...(comment ? { comment } : {}),
  };
}

const ASPECT_RATIOS: readonly CreateImagesAspectRatio[] = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];
const IMAGE_SIZES: readonly CreateImagesImageSize[] = ["1K", "2K", "4K"];
const OUTPUT_MIMES: readonly CreateImagesOutputMime[] = ["image/png", "image/jpeg"];

function annotationShapeAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
): CreateImagesAnnotationShape | undefined {
  const record = recordAt(value, path, issues);
  if (!record) return undefined;
  const type = enumAt(
    record.type,
    ["rectangle", "ellipse", "arrow", "freehand", "text"] as const,
    `${path}.type`,
    issues,
  );
  const common = ["id", "type", "x", "y", "stroke", "strokeWidth"];
  const allowed =
    type === "rectangle" || type === "ellipse"
      ? [...common, "width", "height", "fill"]
      : type === "arrow" || type === "freehand"
        ? [...common, "points"]
        : [...common, "text", "fontSize"];
  rejectUnknownFields(record, allowed, path, issues);
  const id = stringAt(record.id, `${path}.id`, issues, {
    maxLength: 128,
    pattern: OPAQUE_ID_PATTERN,
  });
  const x = finiteNumberAt(record.x, `${path}.x`, issues, -1, 1);
  const y = finiteNumberAt(record.y, `${path}.y`, issues, -1, 1);
  const stroke = enumAt(
    record.stroke,
    CREATE_IMAGES_ANNOTATION_COLORS,
    `${path}.stroke`,
    issues,
  );
  const strokeWidth = finiteNumberAt(record.strokeWidth, `${path}.strokeWidth`, issues, 0.5, 64);
  if (!type || !id || x === undefined || y === undefined || !stroke || strokeWidth === undefined) {
    return undefined;
  }
  if (type === "rectangle" || type === "ellipse") {
    const width = finiteNumberAt(record.width, `${path}.width`, issues, 0.001, 2);
    const height = finiteNumberAt(record.height, `${path}.height`, issues, 0.001, 2);
    const fill = enumAt(
      record.fill,
      CREATE_IMAGES_ANNOTATION_COLORS,
      `${path}.fill`,
      issues,
      true,
    );
    if (
      width === undefined ||
      height === undefined ||
      (record.fill !== undefined && fill === undefined)
    ) {
      return undefined;
    }
    return {
      id,
      type,
      x,
      y,
      width,
      height,
      stroke,
      strokeWidth,
      ...(fill ? { fill } : {}),
    };
  }
  if (type === "arrow" || type === "freehand") {
    const points = Array.isArray(record.points) ? record.points : undefined;
    const maximum = type === "arrow" ? 4 : CREATE_IMAGES_MAX_ANNOTATION_POINTS * 2;
    if (
      !points ||
      points.length < 4 ||
      points.length > maximum ||
      points.length % 2 !== 0 ||
      (type === "arrow" && points.length !== 4)
    ) {
      issues.push({
        path: `${path}.points`,
        code: "invalid_value",
        message: `Expected an even point list between 4 and ${maximum} values.`,
      });
      return undefined;
    }
    const parsed: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = finiteNumberAt(points[index], `${path}.points[${index}]`, issues, -1, 2);
      if (point === undefined) return undefined;
      parsed.push(point);
    }
    return type === "arrow"
      ? { id, type, x, y, points: parsed as [number, number, number, number], stroke, strokeWidth }
      : { id, type, x, y, points: parsed, stroke, strokeWidth };
  }
  const text = stringAt(record.text, `${path}.text`, issues, { maxLength: 1_000 });
  const fontSize = finiteNumberAt(record.fontSize, `${path}.fontSize`, issues, 8, 256);
  return text && fontSize !== undefined
    ? { id, type, x, y, text, fontSize, stroke, strokeWidth }
    : undefined;
}

function promptVariableAt(
  value: unknown,
  path: string,
  issues: WorkflowParseIssue[],
): CreateImagesPromptVariable | undefined {
  const record = recordAt(value, path, issues);
  if (!record) return undefined;
  rejectUnknownFields(record, ["id", "name", "required"], path, issues);
  const id = stringAt(record.id, `${path}.id`, issues, {
    maxLength: 128,
    pattern: OPAQUE_ID_PATTERN,
  });
  const name = stringAt(record.name, `${path}.name`, issues, {
    maxLength: 32,
    pattern: CREATE_IMAGES_PROMPT_VARIABLE_NAME,
  });
  if (typeof record.required !== "boolean") {
    issues.push({ path: `${path}.required`, code: "invalid_type", message: "Expected a boolean." });
  }
  return id && name && typeof record.required === "boolean"
    ? { id, name, required: record.required }
    : undefined;
}

function nodeAt(
  value: unknown,
  index: number,
  issues: WorkflowParseIssue[],
): WorkflowNodeV1 | undefined {
  const path = `nodes[${index}]`;
  const record = recordAt(value, path, issues);
  if (!record) return undefined;
  rejectUnknownFields(
    record,
    ["id", "type", "position", "data", "title", "dimensions", "comment"],
    path,
    issues,
  );
  const id = stringAt(record.id, `${path}.id`, issues, {
    maxLength: 128,
    pattern: OPAQUE_ID_PATTERN,
  });
  const type = enumAt(record.type, CREATE_IMAGES_NODE_TYPES, `${path}.type`, issues);
  const position = positionAt(record.position, `${path}.position`, issues);
  const data = recordAt(record.data, `${path}.data`, issues);
  if (!id || !type || !position || !data) return undefined;
  const presentation = nodePresentationAt(record, path, issues);

  if (type === "image-input") {
    rejectUnknownFields(data, ["assetId", "label"], `${path}.data`, issues);
    const assetId = stringAt(data.assetId, `${path}.data.assetId`, issues, {
      maxLength: 64,
      pattern: CREATE_IMAGES_ASSET_ID_PATTERN,
      optional: true,
    });
    const label = optionalLabelAt(data.label, `${path}.data.label`, issues);
    if (data.assetId !== undefined && assetId === undefined) return undefined;
    return {
      id,
      type,
      position,
      ...presentation,
      data: { ...(assetId ? { assetId } : {}), ...(label !== undefined ? { label } : {}) },
    };
  }

  if (type === "prompt") {
    rejectUnknownFields(data, ["text", "variables"], `${path}.data`, issues);
    if (typeof data.text !== "string") {
      issues.push({
        path: `${path}.data.text`,
        code: "invalid_type",
        message: "Expected a string.",
      });
      return undefined;
    }
    if (data.text.length > CREATE_IMAGES_MAX_PROMPT_LENGTH) {
      issues.push({
        path: `${path}.data.text`,
        code: "too_large",
        message: `Prompts are limited to ${CREATE_IMAGES_MAX_PROMPT_LENGTH} characters.`,
      });
      return undefined;
    }
    let variables: CreateImagesPromptVariable[] | undefined;
    if (data.variables !== undefined) {
      if (
        !Array.isArray(data.variables) ||
        data.variables.length > CREATE_IMAGES_MAX_PROMPT_VARIABLES
      ) {
        issues.push({
          path: `${path}.data.variables`,
          code: Array.isArray(data.variables) ? "too_large" : "invalid_type",
          message: `Prompts are limited to ${CREATE_IMAGES_MAX_PROMPT_VARIABLES} variables.`,
        });
        return undefined;
      }
      variables = [];
      for (let variableIndex = 0; variableIndex < data.variables.length; variableIndex += 1) {
        const variable = promptVariableAt(
          data.variables[variableIndex],
          `${path}.data.variables[${variableIndex}]`,
          issues,
        );
        if (variable) variables.push(variable);
      }
      for (const duplicate of duplicates(variables.map((variable) => variable.id))) {
        issues.push({
          path: `${path}.data.variables`,
          code: "duplicate",
          message: `Duplicate prompt variable ID "${duplicate}".`,
        });
      }
      for (const duplicate of duplicates(variables.map((variable) => variable.name))) {
        issues.push({
          path: `${path}.data.variables`,
          code: "duplicate",
          message: `Duplicate prompt variable name "${duplicate}".`,
        });
      }
    }
    return {
      id,
      type,
      position,
      ...presentation,
      data: { text: data.text, ...(variables ? { variables } : {}) },
    };
  }

  if (type === "prompt-list") {
    rejectUnknownFields(data, ["source", "format"], `${path}.data`, issues);
    if (typeof data.source !== "string") {
      issues.push({ path: `${path}.data.source`, code: "invalid_type", message: "Expected a string." });
      return undefined;
    }
    if (data.source.length > CREATE_IMAGES_MAX_PROMPT_LENGTH) {
      issues.push({
        path: `${path}.data.source`,
        code: "too_large",
        message: `Prompt lists are limited to ${CREATE_IMAGES_MAX_PROMPT_LENGTH} characters.`,
      });
      return undefined;
    }
    const format = enumAt(data.format, ["lines", "json"] as const, `${path}.data.format`, issues);
    return format
      ? { id, type, position, ...presentation, data: { source: data.source, format } }
      : undefined;
  }

  if (type === "generate-image") {
    rejectUnknownFields(
      data,
      ["providerId", "modelId", "aspectRatio", "imageSize", "outputMime", "count"],
      `${path}.data`,
      issues,
    );
    const providerId = enumAt(
      data.providerId,
      ["gemini"] as const,
      `${path}.data.providerId`,
      issues,
      true,
    );
    const modelId = stringAt(data.modelId, `${path}.data.modelId`, issues, {
      maxLength: 192,
      pattern: MODEL_ID_PATTERN,
      optional: true,
    });
    const aspectRatio = enumAt(data.aspectRatio, ASPECT_RATIOS, `${path}.data.aspectRatio`, issues);
    const imageSize = enumAt(data.imageSize, IMAGE_SIZES, `${path}.data.imageSize`, issues);
    const outputMime = enumAt(data.outputMime, OUTPUT_MIMES, `${path}.data.outputMime`, issues);
    const count = integerAt(data.count, `${path}.data.count`, issues, 1, 4);
    if (
      (data.providerId !== undefined && providerId === undefined) ||
      (data.modelId !== undefined && modelId === undefined) ||
      !aspectRatio ||
      !imageSize ||
      !outputMime ||
      !count
    ) {
      return undefined;
    }
    return {
      id,
      type,
      position,
      ...presentation,
      data: {
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
        aspectRatio,
        imageSize,
        outputMime,
        count: count as 1 | 2 | 3 | 4,
      },
    };
  }

  if (type === "image-compare") {
    rejectUnknownFields(data, ["divider"], `${path}.data`, issues);
    const divider = finiteNumberAt(data.divider, `${path}.data.divider`, issues, 0, 1);
    return divider === undefined
      ? undefined
      : { id, type, position, ...presentation, data: { divider } };
  }

  if (type === "annotation") {
    rejectUnknownFields(data, ["shapes"], `${path}.data`, issues);
    if (!Array.isArray(data.shapes) || data.shapes.length > CREATE_IMAGES_MAX_ANNOTATION_SHAPES) {
      issues.push({
        path: `${path}.data.shapes`,
        code: Array.isArray(data.shapes) ? "too_large" : "invalid_type",
        message: `Annotations are limited to ${CREATE_IMAGES_MAX_ANNOTATION_SHAPES} shapes.`,
      });
      return undefined;
    }
    const shapes: CreateImagesAnnotationShape[] = [];
    for (let shapeIndex = 0; shapeIndex < data.shapes.length; shapeIndex += 1) {
      if (!hasOwn(data.shapes, shapeIndex)) {
        issues.push({
          path: `${path}.data.shapes[${shapeIndex}]`,
          code: "invalid_type",
          message: "Sparse shape arrays are not supported.",
        });
        continue;
      }
      const shape = annotationShapeAt(
        data.shapes[shapeIndex],
        `${path}.data.shapes[${shapeIndex}]`,
        issues,
      );
      if (shape) shapes.push(shape);
    }
    for (const duplicate of duplicates(shapes.map((shape) => shape.id))) {
      issues.push({
        path: `${path}.data.shapes`,
        code: "duplicate",
        message: `Duplicate annotation shape ID "${duplicate}".`,
      });
    }
    return { id, type, position, ...presentation, data: { shapes } };
  }

  if (type === "group") {
    rejectUnknownFields(data, ["memberNodeIds", "color", "locked"], `${path}.data`, issues);
    const memberValues = Array.isArray(data.memberNodeIds) ? data.memberNodeIds : undefined;
    if (!memberValues || memberValues.length > CREATE_IMAGES_MAX_NODES) {
      issues.push({
        path: `${path}.data.memberNodeIds`,
        code: memberValues ? "too_large" : "invalid_type",
        message: "Group members must be a bounded node ID list.",
      });
      return undefined;
    }
    const memberNodeIds: string[] = [];
    for (let memberIndex = 0; memberIndex < memberValues.length; memberIndex += 1) {
      const memberId = stringAt(
        memberValues[memberIndex],
        `${path}.data.memberNodeIds[${memberIndex}]`,
        issues,
        { maxLength: 128, pattern: OPAQUE_ID_PATTERN },
      );
      if (memberId) memberNodeIds.push(memberId);
    }
    if (new Set(memberNodeIds).size !== memberNodeIds.length || memberNodeIds.includes(id)) {
      issues.push({
        path: `${path}.data.memberNodeIds`,
        code: "duplicate",
        message: "Group member IDs must be unique and cannot include the group itself.",
      });
    }
    const color = enumAt(
      data.color,
      ["blue", "green", "orange", "purple", "gray"] as const,
      `${path}.data.color`,
      issues,
    );
    if (typeof data.locked !== "boolean") {
      issues.push({ path: `${path}.data.locked`, code: "invalid_type", message: "Expected a boolean." });
    }
    return color && typeof data.locked === "boolean"
      ? { id, type, position, ...presentation, data: { memberNodeIds, color, locked: data.locked } }
      : undefined;
  }

  rejectUnknownFields(data, ["label"], `${path}.data`, issues);
  const label = optionalLabelAt(data.label, `${path}.data.label`, issues);
  const outputData = label === undefined ? {} : { label };
  return type === "output"
    ? { id, type, position, ...presentation, data: outputData }
    : { id, type, position, ...presentation, data: outputData };
}

function edgeAt(
  value: unknown,
  index: number,
  issues: WorkflowParseIssue[],
): WorkflowEdgeV1 | undefined {
  const path = `edges[${index}]`;
  const record = recordAt(value, path, issues);
  if (!record) return undefined;
  rejectUnknownFields(
    record,
    ["id", "source", "sourcePort", "target", "targetPort", "breakpoint"],
    path,
    issues,
  );
  const readId = (field: string): string | undefined =>
    stringAt(record[field], `${path}.${field}`, issues, {
      maxLength: 128,
      pattern: OPAQUE_ID_PATTERN,
    });
  const id = readId("id");
  const source = readId("source");
  const sourcePort = readId("sourcePort");
  const target = readId("target");
  const targetPort = readId("targetPort");
  const breakpoint = record.breakpoint;
  if (breakpoint !== undefined && typeof breakpoint !== "boolean") {
    issues.push({ path: `${path}.breakpoint`, code: "invalid_type", message: "Expected a boolean." });
  }
  return id && source && sourcePort && target && targetPort
    ? {
        id,
        source,
        sourcePort,
        target,
        targetPort,
        ...(breakpoint === true ? { breakpoint: true } : {}),
      }
    : undefined;
}

function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return duplicate;
}

export function parseWorkflowDocument(value: unknown): WorkflowParseResult {
  const issues: WorkflowParseIssue[] = [];
  const sourceRecord = recordAt(value, "$", issues);
  if (!sourceRecord) return { success: false, issues };
  const serializedBytes = createImagesWorkflowSerializedBytes(value);
  if (serializedBytes === undefined || serializedBytes > CREATE_IMAGES_MAX_WORKFLOW_BYTES) {
    issues.push({
      path: "$",
      code: "too_large",
      message: "Workflow metadata exceeds its 8 MiB storage limit.",
    });
    return { success: false, issues };
  }
  const record =
    sourceRecord.schemaVersion === CREATE_IMAGES_LEGACY_SCHEMA_VERSION ||
    sourceRecord.schemaVersion === CREATE_IMAGES_PRESENTATION_SCHEMA_VERSION ||
    sourceRecord.schemaVersion === CREATE_IMAGES_ANNOTATION_SCHEMA_VERSION ||
    sourceRecord.schemaVersion === CREATE_IMAGES_POWER_SCHEMA_VERSION
      ? { ...sourceRecord, schemaVersion: CREATE_IMAGES_SCHEMA_VERSION }
      : sourceRecord;
  rejectUnknownFields(
    record,
    [
      "schemaVersion",
      "id",
      "title",
      "revision",
      "createdAt",
      "updatedAt",
      "viewport",
      "nodes",
      "edges",
      "assetRefs",
      "settings",
    ],
    "$",
    issues,
  );

  if (record.schemaVersion !== CREATE_IMAGES_SCHEMA_VERSION) {
    issues.push({
      path: "$.schemaVersion",
      code: "invalid_value",
      message: `Only schema version ${CREATE_IMAGES_SCHEMA_VERSION} is supported.`,
    });
  }
  const id = stringAt(record.id, "$.id", issues, {
    maxLength: 128,
    pattern: OPAQUE_ID_PATTERN,
  });
  const title = stringAt(record.title, "$.title", issues, { maxLength: 120 });
  const revision = integerAt(record.revision, "$.revision", issues, 1, Number.MAX_SAFE_INTEGER);
  const createdAt = timestampAt(record.createdAt, "$.createdAt", issues);
  const updatedAt = timestampAt(record.updatedAt, "$.updatedAt", issues);

  let viewport: WorkflowDocumentV1["viewport"];
  if (record.viewport !== undefined) {
    const viewportRecord = recordAt(record.viewport, "$.viewport", issues);
    if (viewportRecord) {
      rejectUnknownFields(viewportRecord, ["x", "y", "zoom"], "$.viewport", issues);
      const x = finiteNumberAt(
        viewportRecord.x,
        "$.viewport.x",
        issues,
        -CREATE_IMAGES_POSITION_LIMIT,
        CREATE_IMAGES_POSITION_LIMIT,
      );
      const y = finiteNumberAt(
        viewportRecord.y,
        "$.viewport.y",
        issues,
        -CREATE_IMAGES_POSITION_LIMIT,
        CREATE_IMAGES_POSITION_LIMIT,
      );
      const zoom = finiteNumberAt(
        viewportRecord.zoom,
        "$.viewport.zoom",
        issues,
        CREATE_IMAGES_MIN_ZOOM,
        CREATE_IMAGES_MAX_ZOOM,
      );
      if (x !== undefined && y !== undefined && zoom !== undefined) viewport = { x, y, zoom };
    }
  }

  const nodeValues = Array.isArray(record.nodes) ? record.nodes : undefined;
  if (!nodeValues) {
    issues.push({ path: "$.nodes", code: "invalid_type", message: "Expected an array." });
  } else if (nodeValues.length > CREATE_IMAGES_MAX_NODES) {
    issues.push({
      path: "$.nodes",
      code: "too_large",
      message: `Workflows are limited to ${CREATE_IMAGES_MAX_NODES} nodes.`,
    });
  }
  // Reject oversized collections without walking attacker-controlled entries. IPC
  // callers perform a byte-size check too, but this parser remains safe in isolation.
  const nodes: WorkflowNodeV1[] = [];
  if (nodeValues && nodeValues.length <= CREATE_IMAGES_MAX_NODES) {
    for (let index = 0; index < nodeValues.length; index += 1) {
      if (!hasOwn(nodeValues, index)) {
        issues.push({
          path: `$.nodes[${index}]`,
          code: "invalid_type",
          message: "Sparse workflow arrays are not supported.",
        });
        continue;
      }
      const parsed = nodeAt(nodeValues[index], index, issues);
      if (parsed) nodes.push(parsed);
    }
  }

  const edgeValues = Array.isArray(record.edges) ? record.edges : undefined;
  if (!edgeValues) {
    issues.push({ path: "$.edges", code: "invalid_type", message: "Expected an array." });
  } else if (edgeValues.length > CREATE_IMAGES_MAX_EDGES) {
    issues.push({
      path: "$.edges",
      code: "too_large",
      message: `Workflows are limited to ${CREATE_IMAGES_MAX_EDGES} edges.`,
    });
  }
  const edges: WorkflowEdgeV1[] = [];
  if (edgeValues && edgeValues.length <= CREATE_IMAGES_MAX_EDGES) {
    for (let index = 0; index < edgeValues.length; index += 1) {
      if (!hasOwn(edgeValues, index)) {
        issues.push({
          path: `$.edges[${index}]`,
          code: "invalid_type",
          message: "Sparse workflow arrays are not supported.",
        });
        continue;
      }
      const parsed = edgeAt(edgeValues[index], index, issues);
      if (parsed) edges.push(parsed);
    }
  }

  const assetValues = Array.isArray(record.assetRefs) ? record.assetRefs : undefined;
  if (!assetValues) {
    issues.push({ path: "$.assetRefs", code: "invalid_type", message: "Expected an array." });
  } else if (assetValues.length > CREATE_IMAGES_MAX_ASSET_REFS) {
    issues.push({
      path: "$.assetRefs",
      code: "too_large",
      message: `Workflows are limited to ${CREATE_IMAGES_MAX_ASSET_REFS} asset references.`,
    });
  }
  const assetRefs: string[] = [];
  if (assetValues && assetValues.length <= CREATE_IMAGES_MAX_ASSET_REFS) {
    for (let index = 0; index < assetValues.length; index += 1) {
      if (!hasOwn(assetValues, index)) {
        issues.push({
          path: `$.assetRefs[${index}]`,
          code: "invalid_type",
          message: "Sparse workflow arrays are not supported.",
        });
        continue;
      }
      const parsed = stringAt(assetValues[index], `$.assetRefs[${index}]`, issues, {
        maxLength: 64,
        pattern: CREATE_IMAGES_ASSET_ID_PATTERN,
      });
      if (parsed) assetRefs.push(parsed);
    }
  }

  const settingsRecord = recordAt(record.settings, "$.settings", issues);
  let settings: WorkflowDocumentV1["settings"] | undefined;
  if (settingsRecord) {
    rejectUnknownFields(settingsRecord, ["concurrency", "defaultProviderId"], "$.settings", issues);
    const concurrency = integerAt(
      settingsRecord.concurrency,
      "$.settings.concurrency",
      issues,
      1,
      4,
    );
    const defaultProviderId = enumAt(
      settingsRecord.defaultProviderId,
      ["gemini"] as const,
      "$.settings.defaultProviderId",
      issues,
      true,
    );
    if (
      concurrency !== undefined &&
      (settingsRecord.defaultProviderId === undefined || defaultProviderId !== undefined)
    ) {
      settings = {
        concurrency: concurrency as 1 | 2 | 3 | 4,
        ...(defaultProviderId ? { defaultProviderId } : {}),
      };
    }
  }

  for (const duplicate of duplicates(nodes.map((node) => node.id))) {
    issues.push({
      path: "$.nodes",
      code: "duplicate",
      message: `Duplicate node ID "${duplicate}".`,
    });
  }
  const workflowNodeIds = new Set(nodes.map((node) => node.id));
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.type !== "group") continue;
    for (const memberId of node.data.memberNodeIds) {
      if (!workflowNodeIds.has(memberId)) {
        issues.push({
          path: `$.nodes[${index}].data.memberNodeIds`,
          code: "invalid_value",
          message: `Group member "${memberId}" does not exist.`,
        });
      }
    }
  }
  for (const duplicate of duplicates(edges.map((edge) => edge.id))) {
    issues.push({
      path: "$.edges",
      code: "duplicate",
      message: `Duplicate edge ID "${duplicate}".`,
    });
  }
  for (const duplicate of duplicates(assetRefs)) {
    issues.push({
      path: "$.assetRefs",
      code: "duplicate",
      message: `Duplicate asset reference "${duplicate}".`,
    });
  }
  const assetReferenceSet = new Set(assetRefs);
  const nodeAssetReferenceSet = new Set<string>();
  const nodeAssetReferences: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const assetId = node?.type === "image-input" ? node.data.assetId : undefined;
    if (assetId && !assetReferenceSet.has(assetId)) {
      issues.push({
        path: `$.nodes[${index}].data.assetId`,
        code: "invalid_value",
        message: `Asset "${assetId}" is missing from the workflow asset manifest.`,
      });
    }
    if (assetId && !nodeAssetReferenceSet.has(assetId)) {
      nodeAssetReferenceSet.add(assetId);
      nodeAssetReferences.push(assetId);
    }
  }
  for (let index = 0; index < assetRefs.length; index += 1) {
    const assetId = assetRefs[index];
    if (assetId && !nodeAssetReferenceSet.has(assetId)) {
      issues.push({
        path: `$.assetRefs[${index}]`,
        code: "invalid_value",
        message: `Asset "${assetId}" is not used by an Image Input node.`,
      });
    }
  }
  if (
    assetRefs.length === nodeAssetReferences.length &&
    assetRefs.some((assetId, index) => assetId !== nodeAssetReferences[index])
  ) {
    issues.push({
      path: "$.assetRefs",
      code: "invalid_value",
      message: "Asset references must follow their first Image Input node use.",
    });
  }

  if (
    issues.length > 0 ||
    !id ||
    !title ||
    revision === undefined ||
    !createdAt ||
    !updatedAt ||
    !nodeValues ||
    !edgeValues ||
    !assetValues ||
    !settings
  ) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      schemaVersion: CREATE_IMAGES_SCHEMA_VERSION,
      id,
      title,
      revision,
      createdAt,
      updatedAt,
      ...(viewport ? { viewport } : {}),
      nodes,
      edges,
      assetRefs,
      settings,
    },
  };
}

export function createStarterWorkflow(input: {
  workflowId: string;
  promptNodeId: string;
  generationNodeId: string;
  outputNodeId: string;
  promptEdgeId: string;
  outputEdgeId: string;
  now: string;
}): WorkflowDocumentV1 {
  const candidate: WorkflowDocumentV1 = {
    schemaVersion: CREATE_IMAGES_SCHEMA_VERSION,
    id: input.workflowId,
    title: "Untitled image workflow",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: input.promptNodeId,
        type: "prompt",
        position: { x: 80, y: 180 },
        data: { text: "" },
      },
      {
        id: input.generationNodeId,
        type: "generate-image",
        position: { x: 420, y: 150 },
        data: {
          aspectRatio: "1:1",
          imageSize: "1K",
          outputMime: "image/png",
          count: 1,
        },
      },
      {
        id: input.outputNodeId,
        type: "output",
        position: { x: 780, y: 180 },
        data: {},
      },
    ],
    edges: [
      {
        id: input.promptEdgeId,
        source: input.promptNodeId,
        sourcePort: "text",
        target: input.generationNodeId,
        targetPort: "prompt",
      },
      {
        id: input.outputEdgeId,
        source: input.generationNodeId,
        sourcePort: "images",
        target: input.outputNodeId,
        targetPort: "images",
      },
    ],
    assetRefs: [],
    settings: { concurrency: 1 },
  };
  const result = parseWorkflowDocument(candidate);
  if (!result.success) throw new Error("The built-in starter workflow is invalid.");
  return result.value;
}
