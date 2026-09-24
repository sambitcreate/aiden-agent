// TTS credential resolution. Credentials stay in the encrypted secret store;
// the renderer only ever sees a safe source label and readiness booleans.
//
// Two sources exist, both explicit:
// - "saved-google": the user's existing Google provider API key, reused only
//   after the user explicitly selects that source in Text to Speech settings.
// - "dedicated": a separate API key stored under a main-owned internal secret
//   identity so removing it can never touch the shared Google provider key.

import type { TtsSettingsV1 } from "../../../renderer/shared/tts.js";

/** Internal secret identity for the dedicated TTS key. Never a provider id. */
export const TTS_DEDICATED_SECRET_ID = "aiden-internal:tts-api-key";

const MAX_TTS_KEY_LENGTH = 512;

export type TtsCredentialResolution =
  | {
      status: "ready";
      /** Never logged; passed only to the provider client in main. */
      apiKey: string;
      sourceLabel: string;
    }
  | { status: "setup_required" }
  | { status: "secure_storage_unavailable" };

export interface TtsCredentialDeps {
  /**
   * Reads the saved Google provider key. Resolves null when absent and rejects
   * when the secret store is unreadable (fail closed, never silent default).
   */
  getGoogleKey(): Promise<string | null>;
  /** Same contract for the dedicated internal TTS secret. */
  getDedicatedKey(): Promise<string | null>;
}

export async function resolveTtsCredential(
  deps: TtsCredentialDeps,
  settings: TtsSettingsV1,
): Promise<TtsCredentialResolution> {
  if (settings.credentialSource === "dedicated") {
    const key = await deps.getDedicatedKey();
    if (key) {
      return { status: "ready", apiKey: key, sourceLabel: "Dedicated key" };
    }
    return { status: "setup_required" };
  }
  const key = await deps.getGoogleKey();
  if (key) {
    return {
      status: "ready",
      apiKey: key,
      sourceLabel: "Saved Google key",
    };
  }
  return { status: "setup_required" };
}

export { MAX_TTS_KEY_LENGTH };
