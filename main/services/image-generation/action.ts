import type {
  ImageGenerationActionResult,
  ImageGenerationState,
} from "../../../renderer/shared/image-generation/types.js";
import { ImageGenerationError } from "./runtime.js";

export const INVALID_IMAGE_GENERATION_REQUEST = "Invalid Image Generation request.";

/** Run one IPC action; only safe, known messages ever reach the renderer. */
export async function runImageGenerationAction(
  operation: () => Promise<ImageGenerationState>,
  onUnexpected?: (error: unknown) => void,
): Promise<ImageGenerationActionResult> {
  try {
    return { ok: true, state: await operation() };
  } catch (error) {
    if (error instanceof ImageGenerationError) return { ok: false, code: error.code, message: error.message };
    if (error instanceof Error && error.message === INVALID_IMAGE_GENERATION_REQUEST) {
      return { ok: false, code: "invalid_request", message: INVALID_IMAGE_GENERATION_REQUEST };
    }
    try {
      onUnexpected?.(error);
    } catch {
      /* diagnostics cannot change IPC output */
    }
    return { ok: false, code: "storage_error", message: "Aiden couldn't save your Image Generation settings." };
  }
}
