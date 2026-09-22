export const PARAKEET_PROTOCOL_VERSION = 1 as const;

export type ParakeetParentMessage =
  | {
      version: typeof PARAKEET_PROTOCOL_VERSION;
      kind: "status";
      requestId: string;
    }
  | {
      version: typeof PARAKEET_PROTOCOL_VERSION;
      kind: "transcribe";
      requestId: string;
      modelId: string;
      modelDirectory: string;
      pcmBase64: string;
      encoding: "float32le" | "pcm_s16le";
    }
  | {
      version: typeof PARAKEET_PROTOCOL_VERSION;
      kind: "release";
      requestId: string;
      modelId: string;
    };

export type ParakeetWorkerMessage =
  | {
      version: typeof PARAKEET_PROTOCOL_VERSION;
      kind: "result";
      requestId: string;
      ready?: boolean;
      error?: string | null;
      text?: string;
    }
  | {
      version: typeof PARAKEET_PROTOCOL_VERSION;
      kind: "failure";
      requestId: string;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isParakeetParentMessage(value: unknown): value is ParakeetParentMessage {
  if (!isRecord(value) || value.version !== PARAKEET_PROTOCOL_VERSION) return false;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false;
  if (value.kind === "status") return true;
  if (value.kind === "release") return typeof value.modelId === "string";
  return (
    value.kind === "transcribe" &&
    typeof value.modelId === "string" &&
    typeof value.modelDirectory === "string" &&
    typeof value.pcmBase64 === "string" &&
    (value.encoding === "float32le" || value.encoding === "pcm_s16le")
  );
}

export function isParakeetWorkerMessage(value: unknown): value is ParakeetWorkerMessage {
  if (!isRecord(value) || value.version !== PARAKEET_PROTOCOL_VERSION) return false;
  if (typeof value.requestId !== "string" || value.requestId.length === 0) return false;
  if (value.kind === "failure") return typeof value.message === "string";
  if (value.kind !== "result") return false;
  if (value.ready !== undefined && typeof value.ready !== "boolean") return false;
  if (value.error !== undefined && value.error !== null && typeof value.error !== "string") {
    return false;
  }
  if (value.text !== undefined && typeof value.text !== "string") return false;
  return true;
}
