import type { BusySendPreference } from "../shared/appearance";

/** Unsupported text steering falls back to the safe follow-up action. */
export function effectiveBusySendMode(mode: BusySendPreference, steerAvailable: boolean): BusySendPreference {
  return mode === "steer" && !steerAvailable ? "queue" : mode;
}

export interface ComposerSubmissionStateInput {
  ready: boolean;
  isGenerating: boolean;
  sending: boolean;
  permissionSaving: boolean;
  gitOperationBusy: boolean;
  attaching: boolean;
}

/** One gate shared by the Send button and Enter-key submission path. */
export function composerSubmissionAllowed(input: ComposerSubmissionStateInput): boolean {
  return (
    input.ready &&
    !input.isGenerating &&
    !input.sending &&
    !input.permissionSaving &&
    !input.gitOperationBusy &&
    !input.attaching
  );
}
