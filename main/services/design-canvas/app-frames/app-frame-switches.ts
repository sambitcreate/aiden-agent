// Chromium switches for live app frames (design mode v2 Phase 3a, S75, K1).
//
// A page's own `focus()` in a cross-process app frame takes keyboard routing
// from Aiden's window, and no parent-side guard gets it back without leaking
// keys (Space probes, Electron 43.8.4). Blink's
// BlockingFocusWithoutUserActivation feature makes the iframe's
// `focus-without-user-activation 'none'` policy (in APP_FRAME_ALLOW) refuse
// such focus until the person clicks into the page. The feature does nothing
// for a frame whose policy allows it, and the policy's default allowlist is
// `*`, so Aiden's own pages are unaffected. It's turned on only with the flag.

export const DESIGN_LIVE_BLINK_FEATURE = "BlockingFocusWithoutUserActivation";

type CommandLine = {
  hasSwitch(name: string): boolean;
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value?: string): void;
};

/** Adds the Blink feature live frames need, keeping any features already enabled. Call before `app.ready`. */
export function applyDesignLiveSwitches(commandLine: CommandLine, designLive: boolean): void {
  if (!designLive) return;
  const current = commandLine.hasSwitch("enable-blink-features") ? commandLine.getSwitchValue("enable-blink-features") : "";
  const features = current.split(",").filter((feature) => feature.length > 0);
  if (features.includes(DESIGN_LIVE_BLINK_FEATURE)) return;
  commandLine.appendSwitch("enable-blink-features", [...features, DESIGN_LIVE_BLINK_FEATURE].join(","));
}
