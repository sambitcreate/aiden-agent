import type { NotificationChannel } from "../../renderer/preload-channels.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type { HostRunOrigin, HostRunPromptResolution, HostRunRegistry } from "./host-run-registry.js";

export function hostRunOriginFor(owner: Pick<ChatGenerationOwner, "kind" | "id">): HostRunOrigin {
  if (owner.kind === "remote") return "remote";
  return owner.id > 0 ? "renderer" : "headless";
}

/** Where a journal fault is reported; the main process passes its logger. */
export type HostRunWarn = (scope: "remote", message: string, error: unknown) => void;

export interface HostRunRecorders {
  recordRunBegin(
    registry: HostRunRegistry,
    streamId: string,
    chatId: string,
    owner: Pick<ChatGenerationOwner, "kind" | "id">,
  ): void;
  recordRunNotification(
    registry: HostRunRegistry,
    streamId: string,
    channel: NotificationChannel,
    payload: unknown,
  ): void;
  recordRunAttentionResolved(
    registry: HostRunRegistry,
    promptId: string,
    resolution?: HostRunPromptResolution,
  ): void;
  recordRunSettled(registry: HostRunRegistry, streamId: string): void;
}

/**
 * The recorders are the only way the generation lifecycle feeds the journal.
 * A journal fault is reported through `warn` and never breaks the generation.
 */
export function createHostRunRecorders(warn: HostRunWarn): HostRunRecorders {
  return {
    recordRunBegin(registry, streamId, chatId, owner) {
      try {
        registry.begin({ runId: streamId, chatId, origin: hostRunOriginFor(owner) });
      } catch (error) {
        warn("remote", `Could not journal the start of run ${streamId}.`, error);
      }
    },
    recordRunNotification(registry, streamId, channel, payload) {
      try {
        registry.publish(streamId, channel, payload);
      } catch (error) {
        warn("remote", `Could not journal ${channel} for run ${streamId}.`, error);
      }
    },
    recordRunAttentionResolved(registry, promptId, resolution) {
      try {
        registry.resolveAttention(promptId, resolution);
      } catch (error) {
        warn("remote", "Could not journal a resolved run prompt.", error);
      }
    },
    recordRunSettled(registry, streamId) {
      try {
        registry.settle(streamId);
      } catch (error) {
        warn("remote", `Could not journal the end of run ${streamId}.`, error);
      }
    },
  };
}
