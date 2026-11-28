import type { GenerationCancellationOrigin } from "../../renderer/shared/generation-timeline.js";
import { generationModelMeta } from "./chat-model-selection-meta.js";
import { GenerationTimelineProjector } from "./generation-timeline.js";

export interface GenerationInitializationTerminalState {
  attempted: boolean;
}

export interface GenerationInitializationTerminalMessage {
  role: "assistant";
  content: "";
  model: string;
  timeline: ReturnType<GenerationTimelineProjector["snapshot"]>;
}

export interface GenerationInitializationTerminalMeta {
  providerId: string;
  model: string;
  expectedWorkspaceId: string;
  isCurrent: () => boolean;
}

/**
 * The `append` a generation start hands `persistGenerationInitializationTerminal`:
 * the outcome goes into the chat store in the same write that checks the run
 * still owns the chat, and moves the chat to the run's model unless the run
 * keeps the chat's own (an in-chat task run).
 */
export function chatStoreInitializationTerminalAppend(
  chatStore: {
    appendMessage(
      chatId: string,
      message: GenerationInitializationTerminalMessage,
      meta: {
        expectedWorkspaceId: string;
        isCurrent: () => boolean;
        providerId?: string;
        model?: string;
      },
    ): Promise<unknown>;
  },
  chatId: string,
  keepChatModel: boolean | undefined,
): (
  message: GenerationInitializationTerminalMessage,
  meta: GenerationInitializationTerminalMeta,
) => Promise<unknown> {
  return (message, meta) =>
    chatStore.appendMessage(chatId, message, {
      expectedWorkspaceId: meta.expectedWorkspaceId,
      isCurrent: meta.isCurrent,
      ...generationModelMeta(meta, keepChatModel),
    });
}

export async function persistGenerationInitializationTerminal(options: {
  state: GenerationInitializationTerminalState;
  hasAuthoritativeChat: boolean;
  workspaceId?: string;
  streamId: string;
  providerId: string;
  model: string;
  status: "failed" | "cancelled";
  cancellationOrigin?: GenerationCancellationOrigin;
  isCurrent: () => boolean;
  append: (
    message: GenerationInitializationTerminalMessage,
    meta: GenerationInitializationTerminalMeta,
  ) => Promise<unknown>;
  onUnknownOutcome: (error: unknown) => void;
}): Promise<"persisted" | "skipped" | "unknown"> {
  if (
    options.state.attempted ||
    !options.hasAuthoritativeChat ||
    options.workspaceId === undefined ||
    !options.isCurrent()
  ) {
    return "skipped";
  }
  options.state.attempted = true;
  const timeline = new GenerationTimelineProjector(options.streamId, () => {}).finish(
    options.status,
    options.cancellationOrigin,
  );
  try {
    await options.append(
      { role: "assistant", content: "", model: options.model, timeline },
      {
        providerId: options.providerId,
        model: options.model,
        expectedWorkspaceId: options.workspaceId,
        isCurrent: options.isCurrent,
      },
    );
    return "persisted";
  } catch (error) {
    // A thrown append has an unknown durable outcome. Never retry it and risk
    // duplicating the terminal assistant message.
    options.onUnknownOutcome(error);
    return "unknown";
  }
}
