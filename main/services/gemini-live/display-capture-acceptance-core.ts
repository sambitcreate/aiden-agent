import path from "node:path";

export const GEMINI_LIVE_CAPTURE_ACCEPTANCE_ENV =
  "AIDEN_GEMINI_LIVE_DISPLAY_CAPTURE_ACCEPTANCE";
export const GEMINI_LIVE_CAPTURE_ACCEPTANCE_TOKEN_ENV =
  "AIDEN_GEMINI_LIVE_DISPLAY_CAPTURE_ACCEPTANCE_TOKEN";
export const GEMINI_LIVE_CAPTURE_ACCEPTANCE_PROFILE_ENV =
  "AIDEN_GEMINI_LIVE_DISPLAY_CAPTURE_ACCEPTANCE_PROFILE";
export const GEMINI_LIVE_CAPTURE_ACCEPTANCE_SWITCH =
  "aiden-gemini-live-display-capture-acceptance";
export const GEMINI_LIVE_CAPTURE_ACCEPTANCE_RECEIPT =
  "gemini-live-display-capture-acceptance.json";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

export interface CaptureAcceptanceLaunchInput {
  argv: readonly string[];
  environment: NodeJS.ProcessEnv;
  executablePath: string;
  appPath: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  userDataPath: string;
}

export type CaptureAcceptanceLaunch =
  | { requested: false }
  | {
      requested: true;
      accepted: false;
      error: string;
    }
  | {
      requested: true;
      accepted: true;
      profilePath: string;
      token: string;
    };

function switchToken(argv: readonly string[]): string | undefined {
  const prefix = `--${GEMINI_LIVE_CAPTURE_ACCEPTANCE_SWITCH}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

export function parseCaptureAcceptanceLaunch(
  input: CaptureAcceptanceLaunchInput,
): CaptureAcceptanceLaunch {
  const enabled = input.environment[GEMINI_LIVE_CAPTURE_ACCEPTANCE_ENV]?.trim();
  const environmentToken = input.environment[GEMINI_LIVE_CAPTURE_ACCEPTANCE_TOKEN_ENV]?.trim();
  const profile = input.environment[GEMINI_LIVE_CAPTURE_ACCEPTANCE_PROFILE_ENV]?.trim();
  const argumentToken = switchToken(input.argv);
  if (!enabled && !environmentToken && !profile && argumentToken === undefined) {
    return { requested: false };
  }
  const reject = (error: string): CaptureAcceptanceLaunch => ({
    requested: true,
    accepted: false,
    error,
  });
  if (enabled !== "1") return reject("acceptance_flag_missing");
  if (!TOKEN_PATTERN.test(environmentToken ?? "") || environmentToken !== argumentToken) {
    return reject("acceptance_token_mismatch");
  }
  if (input.platform !== "darwin") return reject("macos_required");
  if (!input.isPackaged) return reject("packaged_app_required");
  if (!profile || !path.isAbsolute(profile) || path.resolve(profile) !== input.userDataPath) {
    return reject("isolated_profile_mismatch");
  }
  const executable = path.resolve(input.executablePath);
  const bundleRoot = path.resolve(executable, "../../..");
  if (
    path.basename(executable) !== "Aiden Agent" ||
    path.basename(bundleRoot) !== "Aiden Agent.app" ||
    path.resolve(input.appPath) !== path.join(bundleRoot, "Contents", "Resources", "app.asar")
  ) {
    return reject("aiden_bundle_identity_required");
  }
  return {
    requested: true,
    accepted: true,
    profilePath: path.resolve(profile),
    token: environmentToken!,
  };
}

export interface DisplayCaptureAcceptanceEvidence {
  displayPermissionPath: boolean;
  externalSourceEnded: boolean;
  nativeFallbackRequests: number;
  navigationRejected: boolean;
  pickerCancellationErrorName: string | null;
  pickerCancelled: boolean;
  replacementChooserFallbackRequests: number;
  replacementDocumentDenied: boolean;
}

export function evaluateDisplayCaptureAcceptance(
  evidence: DisplayCaptureAcceptanceEvidence,
): { accepted: boolean; checks: string[] } {
  const checks = [
    evidence.displayPermissionPath && "display_permission_path",
    evidence.externalSourceEnded && "external_source_ended",
    evidence.nativeFallbackRequests === 0 && "native_picker_without_handler_fallback",
    evidence.pickerCancelled && "picker_cancelled",
    (evidence.pickerCancellationErrorName === "AbortError" ||
      evidence.pickerCancellationErrorName === "NotAllowedError") &&
      "picker_cancellation_rejected",
    evidence.navigationRejected && "replacement_navigation_rejected",
    evidence.replacementDocumentDenied && "replacement_document_denied",
    evidence.replacementChooserFallbackRequests === 0 &&
      "replacement_without_chooser_fallback",
  ].filter((value): value is string => typeof value === "string");
  return { accepted: checks.length === 8, checks };
}
