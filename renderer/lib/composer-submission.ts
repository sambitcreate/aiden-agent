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
