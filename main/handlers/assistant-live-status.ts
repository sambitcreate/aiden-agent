import type { AssistantLiveSnapshot } from "../../renderer/shared/assistant-live.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import type { GeminiLiveService } from "../services/gemini-live/service.js";

type AssistantLiveStatusReader = Pick<GeminiLiveService, "availability">;

function unavailableStatus(): AssistantLiveSnapshot {
  return { available: false, reason: "live_model_unverified", state: "idle" };
}

/** Last defense before Electron serializes an Assistant Live status result. */
export async function invokeAssistantLiveStatus(
  service: AssistantLiveStatusReader,
  owner: RendererDocumentOwner,
): Promise<AssistantLiveSnapshot> {
  try {
    return await service.availability(owner);
  } catch {
    return unavailableStatus();
  }
}
