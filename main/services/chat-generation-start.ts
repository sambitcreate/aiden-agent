import type { ChatStartParams } from "./types.js";

interface ChatGenerationStartDependencies {
  start(streamId: string, params: ChatStartParams): Promise<boolean>;
  startTitle(input: { chatId: string; providerId: string; model: string }): void;
}

/** Keep a stopped initialization from starting a second, background model request. */
export async function startGenerationAndMaybeTitle(
  dependencies: ChatGenerationStartDependencies,
  streamId: string,
  params: ChatStartParams,
): Promise<boolean> {
  // A send never changes the model for new chats: an existing chat keeps its
  // own model, and the desktop's new-chat pick is mirrored to the host's
  // lastProviderId/lastModel when it is made (use-model-selection.ts).
  const started = await dependencies.start(streamId, params);
  if (started) {
    dependencies.startTitle({
      chatId: params.chatId,
      providerId: params.providerId,
      model: params.model,
    });
  }
  return started;
}

/** The main-owned execution policy used by the ordinary desktop chat handler. */
export function desktopChatExecutionOptions(turnId: string, onTurnAccepted: () => void) {
  return { allowSubagents: true, usageSource: "chat" as const, turnId, onTurnAccepted };
}
