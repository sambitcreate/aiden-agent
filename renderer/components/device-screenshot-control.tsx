/**
 * The rail's screenshot control: a joined action whose main half sends a
 * screenshot to the chat and whose menu half offers both "Screenshot to chat"
 * and "Save screenshot…". The save goes through the system save dialog,
 * defaulting to Downloads with the device name and time, and the saved file
 * can be revealed in Finder.
 */
import { Camera, ChevronDown, Download } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast } from "./ui";
import { devicesApi } from "../lib/ipc";

const fileName = (path: string) => path.split("/").pop() ?? path;

export async function saveScreenshotWithFeedback(target: { hostId: string; deviceId: string }): Promise<void> {
  try {
    const result = await devicesApi.saveScreenshot(target);
    if (result.status !== "saved") return;
    toast.success(`Saved ${fileName(result.path)}.`, {
      action: { label: "Reveal in Finder", onClick: () => void devicesApi.revealSaved(result.path).catch(() => undefined) },
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "The screenshot could not be saved.");
  }
}

export function DeviceScreenshotControl(props: {
  disabled: boolean;
  onScreenshotToChat(): void;
  onSaveScreenshot(): void;
}) {
  return (
    <div className="squircle-control squircle-action-group device-screenshot-group" role="group" aria-label="Screenshot">
      <Button
        variant="transparent"
        size="small"
        iconOnly
        aria-label="Screenshot to chat"
        title="Screenshot to chat"
        disabled={props.disabled}
        onClick={props.onScreenshotToChat}
      >
        <Camera aria-hidden />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="transparent"
            size="small"
            className="device-screenshot-menu"
            aria-label="Screenshot options"
            title="Screenshot options"
            disabled={props.disabled}
          >
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuItem onSelect={props.onScreenshotToChat}>
            <Camera aria-hidden />
            Screenshot to chat
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onSaveScreenshot}>
            <Download aria-hidden />
            Save screenshot…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
