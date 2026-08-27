export type AccessibilityPermissionState =
  | { status: "checking" }
  | { status: "granted" }
  | { status: "needed" }
  | { status: "error"; message: string };

const CHECK_FAILURE =
  "Aiden couldn’t check Accessibility access. Try again or open System Settings.";
const REQUEST_FAILURE =
  "Aiden couldn’t request Accessibility access. Open System Settings and add the current Aiden app manually.";

export async function checkAccessibilityPermission(
  isTrusted: () => Promise<boolean>,
): Promise<AccessibilityPermissionState> {
  try {
    return (await isTrusted()) ? { status: "granted" } : { status: "needed" };
  } catch {
    return { status: "error", message: CHECK_FAILURE };
  }
}

export async function requestAccessibilityPermission(
  request: () => Promise<boolean>,
): Promise<AccessibilityPermissionState> {
  try {
    return (await request()) ? { status: "granted" } : { status: "needed" };
  } catch {
    return { status: "error", message: REQUEST_FAILURE };
  }
}
