import type {
  AssistantLiveSnapshot,
  AssistantLiveStartIntent,
} from "../../renderer/shared/assistant-live.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import {
  safeGeminiLiveStartError,
  type GeminiLiveService,
} from "../services/gemini-live/service.js";

type AssistantLiveStarter = Pick<GeminiLiveService, "start">;

/** Last defense before Electron serializes an Assistant Live start rejection. */
export async function invokeAssistantLiveStart(
  service: AssistantLiveStarter,
  owner: RendererDocumentOwner,
  intent: AssistantLiveStartIntent,
): Promise<AssistantLiveSnapshot> {
  try {
    return await service.start(owner, intent);
  } catch (error) {
    throw safeGeminiLiveStartError(error);
  }
}
