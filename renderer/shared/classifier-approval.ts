/** Full classification inputs stay on the owning desktop approval surface. */
export const CLASSIFIER_JSON_BYTES = 32_768;
export interface ClassifierApprovalDetails {
  kind: "model-classification";
  providerId: string;
  providerLabel: string;
  modelId: string;
  stateJson: string;
  questionsJson: string;
  stateBytes: number;
  questionsBytes: number;
  payloadComplete: true;
}

function jsonBytes(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > CLASSIFIER_JSON_BYTES * 6) return;
  try {
    const decoded: unknown = JSON.parse(value);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return;
    const bytes = new TextEncoder().encode(JSON.stringify(decoded)).byteLength;
    return bytes <= CLASSIFIER_JSON_BYTES ? bytes : undefined;
  } catch { return; }
}

export function isClassifierApprovalDetails(value: unknown): value is ClassifierApprovalDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "kind,modelId,payloadComplete,providerId,providerLabel,questionsBytes,questionsJson,stateBytes,stateJson") return false;
  // Reject control and direction characters in recipient labels; payload JSON escapes these.
  // eslint-disable-next-line no-control-regex
  const label = (entry: unknown, maximum: number) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(entry);
  return input.kind === "model-classification" && input.payloadComplete === true &&
    label(input.providerId, 128) && label(input.providerLabel, 512) && label(input.modelId, 256) &&
    typeof input.stateBytes === "number" && input.stateBytes === jsonBytes(input.stateJson) &&
    typeof input.questionsBytes === "number" && input.questionsBytes === jsonBytes(input.questionsJson);
}

/** A missing or damaged payload must never fall back to a summary-only Allow button. */
export function classifierApprovalState(toolName: string, details: unknown): { details?: ClassifierApprovalDetails; invalid: boolean } {
  const claimed = toolName === "classify" || (!!details && typeof details === "object" && (details as { kind?: unknown }).kind === "model-classification");
  if (!claimed) return { invalid: false };
  return isClassifierApprovalDetails(details) ? { details, invalid: false } : { invalid: true };
}
