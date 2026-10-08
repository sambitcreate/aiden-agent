/**
 * Adapted from t3code apps/desktop/src/window/DesktopWindow.ts @ a6ec88f7 (MIT).
 *
 * A trackpad swipe reaches the page as wheel events with no end marker, so a 3D
 * device orbit could only settle after a timeout. Chromium reports the native
 * `gestureScrollEnd` to main; forwarding it lets the Simulator tab settle the
 * device the moment the fingers lift. No payload, no network, no persistence.
 */
export const TRACKPAD_SCROLL_END_CHANNEL = "devices:trackpad-scroll-end";

export interface TrackpadInputSource {
  on(event: "input-event", listener: (event: unknown, input: { type: string }) => void): unknown;
  send(channel: string): void;
  isDestroyed(): boolean;
}

export function forwardTrackpadScrollEnd(webContents: TrackpadInputSource): void {
  webContents.on("input-event", (_event, input) => {
    if (input.type === "gestureScrollEnd" && !webContents.isDestroyed()) {
      webContents.send(TRACKPAD_SCROLL_END_CHANNEL);
    }
  });
}
