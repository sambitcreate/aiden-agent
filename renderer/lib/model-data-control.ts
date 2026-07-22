import type {
  ArtificialAnalysisActionErrorCode,
  ArtificialAnalysisStatus,
} from "./types.js";

export const ARTIFICIAL_ANALYSIS_KEY_MANAGEMENT_URL =
  "https://artificialanalysis.ai/api-key-management-redirect";
export const ARTIFICIAL_ANALYSIS_ATTRIBUTION_URL = "https://artificialanalysis.ai/";

export interface ModelPadGate {
  unlocked: boolean;
  title: string;
  detail: string;
}

export function isArtificialAnalysisKeyError(code: ArtificialAnalysisActionErrorCode): boolean {
  return code === "invalid_key" || code === "access_denied" || code === "invalid_input";
}

export function resolveModelPadGate(
  status: ArtificialAnalysisStatus | undefined,
  state: { loading?: boolean; failed?: boolean } = {},
): ModelPadGate {
  if (state.failed) {
    return {
      unlocked: false,
      title: "Model Pad is locked",
      detail: "Aiden couldn’t check the local model-data connection. Open Settings to try again.",
    };
  }
  if (state.loading || !status) {
    return {
      unlocked: false,
      title: "Checking Model Pad",
      detail: "Aiden is checking for cached model data on this Mac.",
    };
  }
  if (status.ready) {
    return {
      unlocked: true,
      title: "Model Pad is ready",
      detail: `${status.rankedModelCount} ranked model${status.rankedModelCount === 1 ? "" : "s"} available offline.`,
    };
  }
  if (status.cleanupNeeded) {
    return {
      unlocked: false,
      title: "Finish removing model data",
      detail: "The API key is gone, but Aiden still needs to remove cached model data on this Mac.",
    };
  }
  if (status.hasKey) {
    return {
      unlocked: false,
      title: "Model Pad needs model data",
      detail: "Your API key is saved. Fetch model data in Settings to finish unlocking the Pad.",
    };
  }
  return {
    unlocked: false,
    title: "Unlock Model Pad",
    detail: "Connect your Artificial Analysis API key in Settings to fetch and cache model data.",
  };
}
