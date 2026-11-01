import * as React from "react";
import { toast } from "../../components/ui";
import { createImagesIpc } from "../../lib/create-images-ipc";
import { SAVE_ALL_MAX_IMAGES, type ImageActionRequest, type ImageActionResponse } from "../../shared/images/ipc-types";
import { actionOutcome, revealLabel, thrownOutcome, type ActionOutcome, type ImageActionOp } from "./viewer-core";

export const IS_MAC = typeof navigator !== "undefined" && /Mac/u.test(navigator.userAgent);
export const REVEAL_LABEL = revealLabel(IS_MAC);

async function perform(request: ImageActionRequest): Promise<ImageActionResponse | null> {
  try {
    return await createImagesIpc.imageAction(request);
  } catch {
    return null;
  }
}

function announce(outcome: ActionOutcome) {
  if (!outcome) return;
  if (outcome.kind === "error") toast.error(outcome.text);
  else toast(outcome.text);
}

/**
 * Save, copy and reveal for generated images, each followed by one toast. Every op names
 * images by asset id; dialogs and paths stay in the main process. Stable identities, so the
 * editor context that carries them does not re-render every node.
 */
export function useImageActions(options: { onSaved?: () => void } = {}) {
  const onSaved = React.useRef(options.onSaved);
  onSaved.current = options.onSaved;

  return React.useMemo(() => {
    const run = async (op: ImageActionOp, request: ImageActionRequest) => {
      const response = await perform(request);
      announce(response ? actionOutcome(op, response) : thrownOutcome(op));
      // Reveal saves a missing auto-saved copy first, so the saved state may have changed.
      if (response?.ok && op === "reveal") onSaved.current?.();
      return response;
    };
    return {
      saveAs: (assetId: string) => void run("save-as", { op: "save-as", assetId }),
      copy: (assetId: string) => void run("copy", { op: "copy", assetId }),
      reveal: (assetId: string) => void run("reveal", { op: "reveal", assetId }),
      revealFolder: () => void run("reveal-folder", { op: "reveal-folder" }),
      saveAll: (assetIds: readonly string[]) =>
        void run("save-all", { op: "save-all", assetIds: assetIds.slice(0, SAVE_ALL_MAX_IMAGES) }),
      /** Starts a native drag of the image file; the HTML drag must already be prevented. */
      drag: (assetId: string) => void run("drag", { op: "drag", assetId }),
      /** A document-bound URL for the full-size original, or null when it cannot be had. */
      view: async (assetId: string): Promise<string | null> => {
        const response = await perform({ op: "view", assetId });
        return response?.ok && response.url ? response.url : null;
      },
    };
  }, []);
}

export type ImageActions = ReturnType<typeof useImageActions>;
