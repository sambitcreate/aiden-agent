import type { NotificationChannel } from "../../renderer/preload-channels.js";
import { logger } from "../platform.js";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import {
  HostRunRegistry,
  type HostRunOrigin,
  type HostRunPromptResolution,
} from "./host-run-registry.js";

/** The host-wide journal of every generation run in this process. */
export const hostRunRegistry = new HostRunRegistry({ now: Date.now });

export function hostRunOriginFor(owner: Pick<ChatGenerationOwner, "kind" | "id">): HostRunOrigin {
  if (owner.kind === "remote") return "remote";
  return owner.id > 0 ? "renderer" : "headless";
}

// The recorders below are the only way the generation lifecycle feeds the
// journal. A journal fault is logged and must never break the generation.

export function recordRunBegin(
  registry: HostRunRegistry,
  streamId: string,
  chatId: string,
  owner: Pick<ChatGenerationOwner, "kind" | "id">,
): void {
  try {
    registry.begin({ runId: streamId, chatId, origin: hostRunOriginFor(owner) });
  } catch (error) {
    logger.warn("remote", `Could not journal the start of run ${streamId}.`, error);
  }
}

export function recordRunNotification(
  registry: HostRunRegistry,
  streamId: string,
  channel: NotificationChannel,
  payload: unknown,
): void {
  try {
    registry.publish(streamId, channel, payload);
  } catch (error) {
    logger.warn("remote", `Could not journal ${channel} for run ${streamId}.`, error);
  }
}

export function recordRunAttentionResolved(
  registry: HostRunRegistry,
  promptId: string,
  resolution?: HostRunPromptResolution,
): void {
  try {
    registry.resolveAttention(promptId, resolution);
  } catch (error) {
    logger.warn("remote", "Could not journal a resolved run prompt.", error);
  }
}

export function recordRunSettled(registry: HostRunRegistry, streamId: string): void {
  try {
    registry.settle(streamId);
  } catch (error) {
    logger.warn("remote", `Could not journal the end of run ${streamId}.`, error);
  }
}
