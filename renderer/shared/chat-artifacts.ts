import { isCanonicalRasterImageMimeType, MAX_INLINE_IMAGE_BYTES } from "./attachment-contract.js";

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

/** Versioned union so future Pi extensions can add GUI artifact kinds safely. */
export type ChatArtifactV1 = ChatImageArtifactV1;

export type ChatArtifactEventV1 =
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      operation: "present";
      artifact: ChatArtifactV1;
    }
  | {
      version: typeof CHAT_ARTIFACT_EVENT_VERSION;
      operation: "reset";
    };

const ARTIFACT_KEYS = new Set(["version", "kind", "attachment"]);
const IMAGE_KEYS = new Set(["id", "name", "mimeType", "kind", "size", "data"]);
const PRESENT_EVENT_KEYS = new Set(["version", "operation", "artifact"]);
const RESET_EVENT_KEYS = new Set(["version", "operation"]);
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

/** Fail closed before a main-process notification reaches React state. */
export function parseChatArtifactV1(value: unknown): ChatArtifactV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  if (
    !hasExactKeys(artifact, ARTIFACT_KEYS) ||
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

/** Parse the live event envelope independently from any future artifact payload versions. */
export function parseChatArtifactEventV1(value: unknown): ChatArtifactEventV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.version !== CHAT_ARTIFACT_EVENT_VERSION) return undefined;
  if (event.operation === "reset" && hasExactKeys(event, RESET_EVENT_KEYS)) {
    return { version: CHAT_ARTIFACT_EVENT_VERSION, operation: "reset" };
  }
  if (event.operation !== "present" || !hasExactKeys(event, PRESENT_EVENT_KEYS)) {
    return undefined;
  }
  const artifact = parseChatArtifactV1(event.artifact);
  return artifact
    ? { version: CHAT_ARTIFACT_EVENT_VERSION, operation: "present", artifact }
    : undefined;
}
