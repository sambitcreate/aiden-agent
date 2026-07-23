import type { ArtificialAnalysisActionErrorCode } from "./types.js";

export const ARTIFICIAL_ANALYSIS_KEY_MANAGEMENT_URL =
  "https://artificialanalysis.ai/api-key-management-redirect";
export const ARTIFICIAL_ANALYSIS_ATTRIBUTION_URL = "https://artificialanalysis.ai/";

export function isArtificialAnalysisKeyError(code: ArtificialAnalysisActionErrorCode): boolean {
  return code === "invalid_key" || code === "access_denied" || code === "invalid_input";
}
