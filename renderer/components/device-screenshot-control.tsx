/**
 * The rail's screenshot control: a joined action whose main half sends a
 * screenshot to the chat and whose menu half offers "Screenshot to chat",
 * "Save screenshot…", and, while the 3D view shows, "Save framed screenshot…"
 * (the device as drawn in 3D). Saves go through the system save dialog,
 * defaulting to Downloads with the device name and time, and the saved file
 * can be revealed in Finder.
 */
import { Box, Camera, ChevronDown, Download } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast } from "./ui";
import { devicesApi } from "../lib/ipc";
import type { DeviceSaveResult } from "../shared/device-features";

const fileName = (path: string) => path.split("/").pop() ?? path;

export function saveScreenshotWithFeedback(target: { hostId: string; deviceId: string }): Promise<void> {
  return saveWithFeedback(() => devicesApi.saveScreenshot(target));
}

/** Saves the 3D view's framed-device image; `capture` renders it, so it runs while the 3D view is shown. */
export function saveFramedScreenshotWithFeedback(
  target: { hostId: string; deviceId: string },
  capture: () => Promise<Blob | null>,
): Promise<void> {
  return saveWithFeedback(async () => {
    const image = await capture();
    if (!image) throw new Error("The 3D view could not be captured.");
    const png = new Uint8Array(await image.arrayBuffer());
    return devicesApi.saveFramedScreenshot({ ...target, png });
  });
}

async function saveWithFeedback(save: () => Promise<DeviceSaveResult>): Promise<void> {
  try {
    const result = await save();
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
  /** Offered only while the 3D view is showing: saves the device as framed in 3D. */
  onSaveFramedScreenshot?: () => void;
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
          {props.onSaveFramedScreenshot ? (
            <DropdownMenuItem onSelect={props.onSaveFramedScreenshot}>
              <Box aria-hidden />
              Save framed screenshot…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
