import type { ChatUiVisualV1 } from "./aiden-ui/types.js";
import { parseChatUiVisualV1 } from "./aiden-ui/visual.js";
import { isCanonicalRasterImageMimeType, MAX_INLINE_IMAGE_BYTES } from "./attachment-contract.js";
import {
  HTML_ARTIFACT_MIME_TYPE,
  MAX_HTML_ARTIFACT_BYTES,
  generativeUiPreviewTokenFromUrl,
  isHtmlArtifactMediaId,
  isHtmlArtifactTitle,
} from "./generative-ui.js";

export const CHAT_ARTIFACT_VERSION = 1 as const;
export const CHAT_ARTIFACT_EVENT_VERSION = 1 as const;

export interface ChatImageArtifactV1 {
  version: typeof CHAT_ARTIFACT_VERSION;
  kind: "image";
  attachment: {
    id: string;
    name: string;
    mimeType: string;
    kind: "image";
    size: number;
    /** Base64 without a data-URL prefix. */
    data: string;
  };
}

export interface ChatHtmlArtifactV1 {
  version: typeof CHAT_ARTIFACT_VERSION;
  kind: "html";
  id: string;
  title: string;
  mimeType: typeof HTML_ARTIFACT_MIME_TYPE;
  size: number;
  /** Opaque app-owned media identity. Never a filesystem path. */
  mediaId: string;
}

/**
 * Which tool call produced an HTML artifact. Kept on the message beside, not
 * inside, `htmlArtifacts`: older builds parse artifacts with exact keys and drop
 * a message's whole list on an unknown key, but ignore unknown message fields.
 */
export interface HtmlArtifactPlacementV1 {
  mediaId: string;
  toolCallId: string;
  /** Absent means the reading column; only `wide` is ever stored. */
  layout?: "wide";
}

/** Where a visual sits: the reading column (default) or the full chat pane. */
export type HtmlArtifactLayout = "column" | "wide";

export function isHtmlArtifactLayout(value: unknown): value is HtmlArtifactLayout {
  return value === "column" || value === "wide";
}

/** Versioned union so future Pi extensions can add GUI artifact kinds safely. */
export type ChatArtifactV1 = ChatImageArtifactV1 | ChatHtmlArtifactV1;

export type ChatArtifactEventV1 =
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      operation: "present";
      artifact: ChatArtifactV1;
      /** The render_artifact call that produced it, for in-row placement. */
      toolCallId?: string;
      /** A ready main-built preview, so the final frame mounts without a round trip. */
      src?: string;
      layout?: "wide";
    }
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      operation: "reset";
    }
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      /** A render_artifact call is still streaming; `src` is its live draft preview. */
      operation: "draft";
      toolCallId: string;
      title?: string;
      src: string;
      layout?: "wide";
    }
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      operation: "draft_end";
      toolCallId: string;
    }
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      /** A native (render_ui) visual was presented or revised. */
      operation: "ui";
      visual: ChatUiVisualV1;
    }
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      /** A render_ui call is still streaming; `visual` is its partial tree. */
      operation: "ui_draft";
      toolCallId: string;
      visual: ChatUiVisualV1;
    };

const IMAGE_ARTIFACT_KEYS = new Set(["version", "kind", "attachment"]);
const HTML_ARTIFACT_KEYS = new Set(["version", "kind", "id", "title", "mimeType", "size", "mediaId"]);
const IMAGE_KEYS = new Set(["id", "name", "mimeType", "kind", "size", "data"]);
const PRESENT_EVENT_KEYS = new Set(["version", "operation", "artifact"]);
const RESET_EVENT_KEYS = new Set(["version", "operation"]);
const PRESENT_EVENT_ALLOWED_KEYS = new Set(["version", "operation", "artifact", "toolCallId", "src", "layout"]);
const DRAFT_EVENT_REQUIRED_KEYS = ["version", "operation", "toolCallId", "src"] as const;
const UI_EVENT_KEYS = new Set(["version", "operation", "visual"]);
const UI_DRAFT_EVENT_KEYS = new Set(["version", "operation", "toolCallId", "visual"]);
const DRAFT_EVENT_ALLOWED_KEYS = new Set(["version", "operation", "toolCallId", "title", "src", "layout"]);
const DRAFT_END_EVENT_KEYS = new Set(["version", "operation", "toolCallId"]);
const MAX_PLACEMENTS = 40;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 512;
const MAX_BASE64_CHARS = Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4;

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.size && ownKeys.every((key) => keys.has(key));
}

function decodedBase64Bytes(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || value.length > MAX_BASE64_CHARS) {
    return undefined;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const body = value.slice(0, value.length - padding);
  if (!/^[A-Za-z0-9+/]*$/u.test(body) || !/^={0,2}$/u.test(value.slice(body.length))) {
    return undefined;
  }
  const finalValue = base64Value(value.charCodeAt(body.length - 1));
  if (
    finalValue === undefined ||
    (padding === 2 && (finalValue & 15) !== 0) ||
    (padding === 1 && (finalValue & 3) !== 0)
  ) {
    return undefined;
  }
  return (value.length / 4) * 3 - padding;
}

function base64Value(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return undefined;
}

function parseChatImageArtifactV1(artifact: Record<string, unknown>): ChatImageArtifactV1 | undefined {
  if (
    !hasExactKeys(artifact, IMAGE_ARTIFACT_KEYS) ||
    artifact.version !== CHAT_ARTIFACT_VERSION ||
    artifact.kind !== "image" ||
    !artifact.attachment ||
    typeof artifact.attachment !== "object" ||
    Array.isArray(artifact.attachment)
  ) {
    return undefined;
  }
  const attachment = artifact.attachment as Record<string, unknown>;
  if (
    !hasExactKeys(attachment, IMAGE_KEYS) ||
    typeof attachment.id !== "string" ||
    attachment.id.length === 0 ||
    attachment.id.length > MAX_ID_CHARS ||
    typeof attachment.name !== "string" ||
    attachment.name.length === 0 ||
    attachment.name.length > MAX_NAME_CHARS ||
    attachment.kind !== "image" ||
    !isCanonicalRasterImageMimeType(attachment.mimeType) ||
    !Number.isSafeInteger(attachment.size) ||
    (attachment.size as number) < 1 ||
    (attachment.size as number) > MAX_INLINE_IMAGE_BYTES ||
    typeof attachment.data !== "string" ||
    decodedBase64Bytes(attachment.data) !== attachment.size
  ) {
    return undefined;
  }
  return {
    version: CHAT_ARTIFACT_VERSION,
    kind: "image",
    attachment: {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: "image",
      size: attachment.size as number,
      data: attachment.data,
    },
  };
}

export function parseChatHtmlArtifactV1(value: unknown): ChatHtmlArtifactV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  if (
    !hasExactKeys(artifact, HTML_ARTIFACT_KEYS) ||
    artifact.version !== CHAT_ARTIFACT_VERSION ||
    artifact.kind !== "html" ||
    typeof artifact.id !== "string" ||
    artifact.id.length === 0 ||
    artifact.id.length > MAX_ID_CHARS ||
    !isHtmlArtifactTitle(artifact.title) ||
    artifact.mimeType !== HTML_ARTIFACT_MIME_TYPE ||
    !Number.isSafeInteger(artifact.size) ||
    (artifact.size as number) < 1 ||
    (artifact.size as number) > MAX_HTML_ARTIFACT_BYTES ||
    !isHtmlArtifactMediaId(artifact.mediaId)
  ) {
    return undefined;
  }
  return {
    version: CHAT_ARTIFACT_VERSION,
    kind: "html",
    id: artifact.id,
    title: artifact.title as string,
    mimeType: HTML_ARTIFACT_MIME_TYPE,
    size: artifact.size as number,
    mediaId: artifact.mediaId,
  };
}

/** Fail closed before a main-process notification reaches React state. */
export function parseChatArtifactV1(value: unknown): ChatArtifactV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  if (artifact.kind === "html") return parseChatHtmlArtifactV1(artifact);
  return parseChatImageArtifactV1(artifact);
}

export function isChatImageArtifact(value: ChatArtifactV1): value is ChatImageArtifactV1 {
  return value.kind === "image";
}

export function isChatHtmlArtifact(value: ChatArtifactV1): value is ChatHtmlArtifactV1 {
  return value.kind === "html";
}

export function chatArtifactIdentity(artifact: ChatArtifactV1): string {
  return artifact.kind === "html" ? artifact.mediaId : artifact.attachment.id;
}

export function parseChatHtmlArtifacts(value: unknown): ChatHtmlArtifactV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 40) return undefined;
  const parsed: ChatHtmlArtifactV1[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const artifact = parseChatHtmlArtifactV1(entry);
    if (!artifact || ids.has(artifact.mediaId)) return undefined;
    ids.add(artifact.mediaId);
    parsed.push(artifact);
  }
  return parsed;
}

/** Parse the live event envelope independently from any future artifact payload versions. */
export function parseChatArtifactEventV1(value: unknown): ChatArtifactEventV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.version !== CHAT_ARTIFACT_EVENT_VERSION) return undefined;
  if (event.operation === "reset" && hasExactKeys(event, RESET_EVENT_KEYS)) {
    return { version: CHAT_ARTIFACT_EVENT_VERSION, operation: "reset" };
  }
  if (event.operation === "ui") {
    if (!hasExactKeys(event, UI_EVENT_KEYS)) return undefined;
    const visual = parseChatUiVisualV1(event.visual);
    return visual ? { version: CHAT_ARTIFACT_EVENT_VERSION, operation: "ui", visual } : undefined;
  }
  if (event.operation === "ui_draft") {
    if (!hasExactKeys(event, UI_DRAFT_EVENT_KEYS) || !isToolCallId(event.toolCallId)) return undefined;
    const visual = parseChatUiVisualV1(event.visual);
    return visual
      ? { version: CHAT_ARTIFACT_EVENT_VERSION, operation: "ui_draft", toolCallId: event.toolCallId, visual }
      : undefined;
  }
  if (event.operation === "draft_end") {
    return hasExactKeys(event, DRAFT_END_EVENT_KEYS) && isToolCallId(event.toolCallId)
      ? { version: CHAT_ARTIFACT_EVENT_VERSION, operation: "draft_end", toolCallId: event.toolCallId }
      : undefined;
  }
  if (event.operation === "draft") {
    if (!Object.keys(event).every((key) => DRAFT_EVENT_ALLOWED_KEYS.has(key))) return undefined;
    if (!DRAFT_EVENT_REQUIRED_KEYS.every((key) => key in event)) return undefined;
    if (!isToolCallId(event.toolCallId) || typeof event.src !== "string") return undefined;
    if (!generativeUiPreviewTokenFromUrl(event.src)) return undefined;
    const titled = "title" in event;
    if (titled && !isHtmlArtifactTitle(event.title)) return undefined;
    return {
      version: CHAT_ARTIFACT_EVENT_VERSION,
      operation: "draft",
      toolCallId: event.toolCallId,
      ...(titled ? { title: event.title as string } : {}),
      src: event.src,
      ...(event.layout === "wide" ? { layout: "wide" as const } : {}),
    };
  }
  if (event.operation !== "present") return undefined;
  if (!Object.keys(event).every((key) => PRESENT_EVENT_ALLOWED_KEYS.has(key))) return undefined;
  if (![...PRESENT_EVENT_KEYS].every((key) => key in event)) return undefined;
  if (event.toolCallId !== undefined && !isToolCallId(event.toolCallId)) return undefined;
  if (
    event.src !== undefined &&
    (typeof event.src !== "string" || !generativeUiPreviewTokenFromUrl(event.src))
  ) {
    return undefined;
  }
  const artifact = parseChatArtifactV1(event.artifact);
  if (!artifact) return undefined;
  return {
    version: CHAT_ARTIFACT_EVENT_VERSION,
    operation: "present",
    artifact,
    ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId as string } : {}),
    ...(event.src !== undefined ? { src: event.src as string } : {}),
    ...(event.layout === "wide" ? { layout: "wide" as const } : {}),
  };
}

function isToolCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

/**
 * Lenient on purpose: one bad placement must never hide the artifacts it
 * points at, and fields from newer builds are ignored rather than fatal.
 */
export function parseHtmlArtifactPlacements(value: unknown): HtmlArtifactPlacementV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const placements: HtmlArtifactPlacementV1[] = [];
  for (const entry of value.slice(0, MAX_PLACEMENTS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!isHtmlArtifactMediaId(record.mediaId) || !isToolCallId(record.toolCallId)) continue;
    if (seen.has(record.mediaId)) continue;
    seen.add(record.mediaId);
    placements.push({
      mediaId: record.mediaId,
      toolCallId: record.toolCallId,
      ...(record.layout === "wide" ? { layout: "wide" as const } : {}),
    });
  }
  return placements.length ? placements : undefined;
}
