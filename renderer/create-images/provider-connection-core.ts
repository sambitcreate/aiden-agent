import type { Provider } from "../lib/types";
import {
  CREATE_IMAGES_PROVIDER_STATUS_VERSION,
  type CreateImagesProviderBindingIssue,
  type CreateImagesProviderStatus,
} from "../shared/create-images/providers";

export interface CreateImagesProviderStatusViewModel {
  label: "Disconnected" | "Connecting" | "Connected" | "Invalid" | "Unavailable";
  title: string;
  detail: string;
  tone: "neutral" | "progress" | "success" | "danger" | "warning";
  manageActionLabel: "Set up in Providers" | "Review in Providers" | "Manage in Providers";
  canUseGemini: boolean;
}

const SAFE_ERROR_DETAIL: Readonly<
  Record<NonNullable<CreateImagesProviderStatus["safeErrorCode"]>, string>
> = {
  "credential-missing": "Add a Google API key in Aiden's existing Providers settings.",
  "credential-invalid": "The configured API-key credential is missing or malformed. Review it before cloud use.",
  "credential-scope-unverified":
    "A Google credential exists, but Aiden has not verified that its auth kind and image scope are compatible.",
  "capability-check-failed": "Aiden could not verify the current curated image-model capabilities.",
  "provider-unreachable": "Google Gemini could not be reached for a capability check.",
  "rate-limited": "Google temporarily limited the capability check. Local mock remains available.",
  "feature-unavailable": "Gemini image generation is unavailable in this Aiden build.",
};

export function createImagesProviderStatusViewModel(
  status: CreateImagesProviderStatus,
): CreateImagesProviderStatusViewModel {
  const safeDetail = status.safeErrorCode ? SAFE_ERROR_DETAIL[status.safeErrorCode] : undefined;
  switch (status.connectionState) {
    case "disconnected":
      return {
        label: "Disconnected",
        title: "Connect Google Gemini",
        detail: safeDetail ?? "Set up Google in Providers before using a remote image model.",
        tone: "neutral",
        manageActionLabel: "Set up in Providers",
        canUseGemini: false,
      };
    case "connecting":
      return {
        label: "Connecting",
        title: "Checking Google Gemini",
        detail: "Aiden is checking the main-owned credential and current image capabilities.",
        tone: "progress",
        manageActionLabel: "Manage in Providers",
        canUseGemini: false,
      };
    case "connected": {
      const snapshot = status.capabilitySnapshot;
      const capabilitiesReady = snapshot?.state === "current" && snapshot.models.length > 0;
      return {
        label: "Connected",
        title: capabilitiesReady ? "Google Gemini is ready" : "Google Gemini needs a refresh",
        detail: capabilitiesReady
          ? `${snapshot.models.length} release-curated image model${snapshot.models.length === 1 ? "" : "s"} available. Google validates the API key only when you explicitly submit a reviewed run.`
          : "An API-key connection is configured, but Aiden does not have a current image capability snapshot.",
        tone: capabilitiesReady ? "success" : "warning",
        manageActionLabel: "Manage in Providers",
        canUseGemini: capabilitiesReady,
      };
    }
    case "invalid":
      return {
        label: "Invalid",
        title: "Google credential needs attention",
        detail: safeDetail ?? "The configured API-key credential needs review.",
        tone: "danger",
        manageActionLabel: "Review in Providers",
        canUseGemini: false,
      };
    case "unavailable":
      return {
        label: "Unavailable",
        title: "Google Gemini is unavailable",
        detail: safeDetail ?? "Aiden could not verify this provider right now.",
        tone: "warning",
        manageActionLabel: "Review in Providers",
        canUseGemini: false,
      };
  }
}

export function createImagesBindingIssueLabel(issue: CreateImagesProviderBindingIssue): string {
  switch (issue) {
    case "connection-not-ready":
      return "Configure now; Google runs stay disabled until the connection is ready.";
    case "capabilities-unavailable":
      return "Current model capabilities are unavailable. Refresh the provider before cloud use.";
    case "capabilities-stale":
      return "Model capabilities changed or expired. Review the current catalog before cloud use.";
    case "model-unselected":
      return "Choose a curated Gemini image model.";
    case "model-not-curated":
      return "This model is not in Aiden's release-pinned Gemini catalog.";
    case "model-no-longer-available":
      return "This model is no longer in the current provider capability snapshot.";
    case "aspect-ratio-no-longer-supported":
      return "This aspect ratio is no longer supported by the selected model.";
    case "image-size-no-longer-supported":
      return "This image size is no longer supported by the selected model.";
    case "output-format-no-longer-supported":
      return "This output format is no longer supported by the selected model.";
    case "output-count-no-longer-supported":
      return "This output count is no longer supported by the selected model.";
  }
}

/**
 * The chat-provider list cannot prove image auth compatibility. A configured
 * Google record therefore stays fail-closed until the image-specific main
 * status seam verifies API-key auth and capabilities.
 */
export function createImagesProviderStatusFromExistingProvider(
  state:
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; providers: readonly Provider[] },
): CreateImagesProviderStatus {
  if (state.kind === "loading") {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "connecting",
    };
  }
  if (state.kind === "error") {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "unavailable",
      safeErrorCode: "capability-check-failed",
    };
  }
  const google = state.providers.find((provider) => provider.id === "google");
  if (!google?.hasKey) {
    return {
      schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: "disconnected",
      safeErrorCode: "credential-missing",
    };
  }
  return {
    schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
    providerId: "gemini",
    displayName: "Google Gemini",
    connectionState: "unavailable",
    safeErrorCode: "credential-scope-unverified",
  };
}
