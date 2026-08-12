export const CUSTOM_HANDLER_MODE = "deterministic-custom-handler";
export const NATIVE_SYSTEM_PICKER_MODE = "operator-native-system-picker";

export function evaluateDisplayCaptureEvidence({
  captureMode,
  customDisplayRequests,
  displayPermissionPath,
  nativeFallbackRequests,
  navigationRejected,
  replacementChooserFallbackRequests,
  replacementDocumentDenied,
  pickerCancelled,
  pickerCancellationErrorName,
  requireDisplay,
  externalSourceEnded,
  localTrackStopTeardown,
}) {
  const deterministicCustomHandlerContract =
    captureMode === CUSTOM_HANDLER_MODE &&
    customDisplayRequests === 3 &&
    pickerCancelled &&
    navigationRejected &&
    localTrackStopTeardown;
  const operatorNativeChooserAcceptance =
    requireDisplay === true &&
    captureMode === NATIVE_SYSTEM_PICKER_MODE &&
    customDisplayRequests === 0 &&
    nativeFallbackRequests === 0 &&
    replacementChooserFallbackRequests === 0 &&
    replacementDocumentDenied &&
    displayPermissionPath &&
    pickerCancelled &&
    (pickerCancellationErrorName === "AbortError" ||
      pickerCancellationErrorName === "NotAllowedError") &&
    externalSourceEnded &&
    navigationRejected;
  return {
    deterministicCustomHandlerContract,
    operatorNativeChooserAcceptance,
  };
}
