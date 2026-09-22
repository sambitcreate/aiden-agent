import type { GenerationEmergencyProjection } from "./generation-context.js";

/** Closed user-facing remediation for request-local context projection outcomes. */
export function generationEmergencyUserError(
  projection: GenerationEmergencyProjection | undefined,
): string | null {
  return projection?.kind === "active_payload_replaced"
    ? "The active request is too large for this model context. Retry with a larger-context model or fewer/lower-size attachments."
    : null;
}
