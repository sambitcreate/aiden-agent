import type { ChatStartParams } from "./types.js";

interface ChatGenerationStartDependencies {
  start(streamId: string, params: ChatStartParams): Promise<boolean>;
  startTitle(input: { chatId: string; providerId: string; model: string }): void;
  rememberSelection?(providerId: string, model: string): void;
}

/** Keep a stopped initialization from starting a second, background model request. */
export async function startGenerationAndMaybeTitle(
  dependencies: ChatGenerationStartDependencies,
  streamId: string,
  params: ChatStartParams,
): Promise<boolean> {
  // The selection reflects the user's explicit choice at send time, so persist
  // it before learning whether generation itself succeeded.
  if (params.providerId && params.model) {
    dependencies.rememberSelection?.(params.providerId, params.model);
  }
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
