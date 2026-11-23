import * as React from "react";
import { LayoutDashboard, PencilRuler } from "lucide-react";
import { toast } from "../components/ui";
import type { VisualMenuAction } from "../components/visual-actions-menu";
import { designCanvasApi, workspaceArtifactsApi } from "./ipc";
import { userFacingErrorMessage } from "./ipc-error";
import { designCanvasViewFor, useDesignModeControls, type DesignModeControls } from "./design-mode";

/**
 * The chat whose settled native visuals may be kept in Artifacts, or null.
 * The chat pane sets it for a local chat that lives in a workspace (not a Bot
 * or the Assistant); a remote chat's view never does.
 */
export const KeepVisualChatContext = React.createContext<string | null>(null);

export const KEEP_VISUAL_FAILED = "Aiden couldn't keep that visual in Artifacts.";
export const SEND_TO_CANVAS_FAILED = "Aiden couldn't send that visual to the canvas.";

type PlaceResult = Awaited<ReturnType<typeof designCanvasApi.placeDesignArtifact>>;

/** What the person is told once a Send to canvas request comes back. */
export function sendToCanvasOutcome(result: PlaceResult): { ok: boolean; message: string } {
  if ("status" in result) {
    if (result.status === "placed") return { ok: true, message: "Sent to the canvas." };
    return {
      ok: true,
      message: result.page ? `That visual is already on the canvas, on the page “${result.page}”.` : "That visual is already on the canvas.",
    };
  }
  switch (result.error) {
    case "missing":
      return { ok: false, message: "That visual is no longer in this chat." };
    case "unsafe":
      return { ok: false, message: "That visual can't go on the canvas because Aiden can't confirm it's safe." };
    case "full":
      return { ok: false, message: "The canvas has no room for another frame. Remove one and try again." };
  }
}

/** Saves a settled native visual as a workspace artifact; Artifacts then shows it beside the chat. */
export async function keepVisualInArtifacts(chatId: string, messageId: string, visualId: string): Promise<void> {
  try {
    await workspaceArtifactsApi.keepVisual(chatId, messageId, visualId);
    toast.success("Kept in Artifacts.");
  } catch (error) {
    toast.error(userFacingErrorMessage(error, KEEP_VISUAL_FAILED));
  }
}

/** Puts an HTML visual on the workspace canvas, on the chat's page, turning design mode on so the person sees it there. */
export async function sendVisualToCanvas(controls: DesignModeControls, mediaId: string): Promise<void> {
  let result: PlaceResult;
  try {
    // The open canvas's size on screen, so the frame lands where the person is looking.
    result = await designCanvasApi.placeDesignArtifact(controls.chatId, mediaId, designCanvasViewFor(controls.chatId)?.viewSize);
  } catch (error) {
    toast.error(userFacingErrorMessage(error, SEND_TO_CANVAS_FAILED));
    return;
  }
  const outcome = sendToCanvasOutcome(result);
  if (!outcome.ok) {
    toast.error(outcome.message);
    return;
  }
  if (!controls.on) controls.set(true, "toggle");
  toast.success(outcome.message);
}

/** The Keep in Artifacts entry for a settled native visual, when this chat allows it. */
export function useKeepVisualActions(messageId: string | undefined, visualId: string): VisualMenuAction[] | undefined {
  const chatId = React.useContext(KeepVisualChatContext);
  const [busy, setBusy] = React.useState(false);
  return React.useMemo(() => {
    if (!chatId || !messageId) return undefined;
    return [
      {
        key: "keep-in-artifacts",
        label: "Keep in Artifacts",
        icon: LayoutDashboard,
        disabled: busy,
        onSelect: () => {
          setBusy(true);
          void keepVisualInArtifacts(chatId, messageId, visualId).finally(() => setBusy(false));
        },
      },
    ];
  }, [busy, chatId, messageId, visualId]);
}

/** The Send to canvas entry for an HTML visual, when design mode is available to this chat. */
export function useSendToCanvasActions(chatId: string, mediaId: string): VisualMenuAction[] | undefined {
  const controls = useDesignModeControls(chatId);
  const [busy, setBusy] = React.useState(false);
  return React.useMemo(() => {
    if (!controls) return undefined;
    return [
      {
        key: "send-to-canvas",
        label: "Send to canvas",
        icon: PencilRuler,
        disabled: busy,
        onSelect: () => {
          setBusy(true);
          void sendVisualToCanvas(controls, mediaId).finally(() => setBusy(false));
        },
      },
    ];
  }, [busy, controls, mediaId]);
}
