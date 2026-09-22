import type { GenerationCancellationOrigin } from "../../renderer/shared/generation-timeline.js";
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
