/**
 * Clipboard transfer in the Device tools drawer. Paste to device puts the
 * Mac clipboard's text on the simulator's pasteboard and presses Cmd+V there;
 * Cmd+V on the focused screen does the same. Copy from device brings the
 * simulator's pasteboard text to the Mac clipboard. Text only, up to 64 KB.
 * On an Android emulator the text is typed into the focused field instead,
 * and Copy from device stays disabled with the reason: adb cannot read it.
 */
import * as React from "react";
import { ClipboardCopy, ClipboardPaste } from "lucide-react";
import { Button, Text, toast } from "./ui";
import { ToolsSection } from "./device-tools-panel";
import { devicesApi } from "../lib/ipc";
import { pasteHostClipboardToDevice } from "../lib/device-clipboard";
import type { DeviceFeatureAvailability, DeviceFeatureTarget } from "../shared/device-features";

const sizeLabel = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`);

/** Paste with toasts for the outcome; shared by the drawer button and the Cmd+V shortcut. */
export async function pasteToDeviceWithFeedback(
  target: DeviceFeatureTarget,
  sendKey: ((code: string, phase: "down" | "up") => void) | null,
): Promise<void> {
  try {
    await pasteHostClipboardToDevice({ target, copy: (value) => devicesApi.pasteClipboard(value), sendKey });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "The clipboard could not be pasted.");
  }
}

export function DeviceClipboardSection(props: {
  target: DeviceFeatureTarget;
  /** Sends a key to the device; null while input is disconnected. */
  sendKey: ((code: string, phase: "down" | "up") => void) | null;
  disabled: boolean;
  /** Whether Copy from device works here; when it cannot, the button stays visible and says why. */
  copy?: DeviceFeatureAvailability;
}) {
  const [busy, setBusy] = React.useState<"paste" | "copy" | null>(null);
  const copy = props.copy ?? { available: true };
  const noun = props.target.platform === "android" ? "emulator" : "simulator";
  const reasonId = React.useId();
  const run = async (kind: "paste" | "copy") => {
    setBusy(kind);
    try {
      if (kind === "paste") {
        await pasteToDeviceWithFeedback(props.target, props.sendKey);
      } else {
        const { bytes } = await devicesApi.copyClipboard(props.target);
        toast.success(`Copied ${sizeLabel(bytes)} from the ${noun}.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `The ${noun} clipboard could not be read.`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <ToolsSection title="Clipboard">
      <div className="device-tools-actions">
        <Button
          size="small"
          variant="muted"
          disabled={props.disabled || busy !== null || !props.sendKey}
          onClick={() => void run("paste")}
        >
          <ClipboardPaste aria-hidden />
          Paste to device
        </Button>
        <Button
          size="small"
          variant="muted"
          disabled={props.disabled || busy !== null || !copy.available}
          aria-describedby={copy.available ? undefined : reasonId}
          title={copy.available ? undefined : copy.reason}
          onClick={() => void run("copy")}
        >
          <ClipboardCopy aria-hidden />
          Copy from device
        </Button>
      </div>
      <Text variant="small" color="secondary">
        {props.target.platform === "android"
          ? "Text only, up to 64 KB, typed into the focused field. Cmd+V on the screen does the same."
          : "Text only, up to 64 KB. Cmd+V on the screen pastes into the focused field."}
      </Text>
      {copy.available ? null : (
        <Text variant="small" color="secondary" id={reasonId}>
          {copy.reason}
        </Text>
      )}
    </ToolsSection>
  );
}
