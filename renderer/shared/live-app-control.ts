// Shared limits for Aiden Live moving through Aiden's own window. Main reads
// the window and acts on it; the renderer counts actions, shows the Live
// outline, hands control back on the user's input and asks for spoken OKs.

/** The window-side tool main asks for admission, take-over watching, OKs and notes. */
export const LIVE_APP_CONTROL_RENDERER_TOOL = "aiden_app_control";

/** The ribbon/outline activity source for app control. */
export const LIVE_APP_CONTROL_ACTIVITY_SOURCE = "app-control";

/** Actions Live may take for one request; the user's next words start a new count. */
export const LIVE_APP_CONTROL_MAX_ACTIONS = 30;

/** How long a guarded action waits for the user's OK before it is refused. */
export const LIVE_APP_CONTROL_CONFIRM_TIMEOUT_MS = 20_000;

/** Element attribute that marks controls Live must not use alone. */
export const LIVE_GUARD_ATTRIBUTE = "data-live-guard";

export type LiveGuard = "you" | "confirm";
