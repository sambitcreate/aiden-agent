/**
 * Paste to device: main copies the host clipboard's text onto the simulator's
 * pasteboard (`simctl pbcopy`), then the viewer presses Cmd+V on the device
 * through the HID input socket so the focused field receives it, as
 * Simulator.app's own paste does.
 */
import type { DeviceFeatureTarget } from "../shared/device-features";

/** Cmd down, V down, V up, Cmd up. */
export const DEVICE_PASTE_KEYS: ReadonlyArray<readonly [code: string, phase: "down" | "up"]> = [
  ["MetaLeft", "down"],
  ["KeyV", "down"],
  ["KeyV", "up"],
  ["MetaLeft", "up"],
];

/**
 * The pause between paste key events. Sent in one burst, iOS sometimes
 * handles V before it registers Cmd, so the field receives a literal "v" or
 * nothing at all; a short gap keeps Cmd held while V goes down and up.
 */
export const DEVICE_PASTE_KEY_GAP_MS = 40;

/** Plain Cmd+V while the device screen has focus. */
export function isDevicePasteShortcut(event: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.code === "KeyV" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export async function pasteHostClipboardToDevice(input: {
  target: DeviceFeatureTarget;
  copy(target: DeviceFeatureTarget): Promise<{ bytes: number }>;
  /** The stream client's key sender; absent while input is disconnected. */
  sendKey: ((code: string, phase: "down" | "up") => void) | null;
  /** Waits between key events; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
}): Promise<{ bytes: number }> {
  const sendKey = input.sendKey;
  if (!sendKey) throw new Error("The simulator is not accepting input right now.");
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result = await input.copy(input.target);
  for (const [index, [code, phase]] of DEVICE_PASTE_KEYS.entries()) {
    if (index > 0) await wait(DEVICE_PASTE_KEY_GAP_MS);
    sendKey(code, phase);
  }
  return result;
}
