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
