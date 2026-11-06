import type { GenerationThinkingLevel } from "../../../renderer/shared/generation-thinking.js";
import { resolveProviderDeployment } from "../../../renderer/shared/provider-deployment.js";
import { getMcpPresetForServerId } from "../mcp-presets.js";
import type { McpServer, StoredProvider } from "../types.js";
import type { AnalyticsEventProps } from "./analytics-events.js";
import {
  analyticsConnectorPresetId,
  analyticsModelId,
  analyticsProviderId,
  analyticsThinking,
} from "./analytics-ids.js";
import { captureAnalyticsReporter, reportAnalyticsEvent } from "./analytics-report.js";

type MessageOrigin = AnalyticsEventProps<"chat_message_sent">["origin"];

export interface ChatMessageSent {
  readonly providerId: string;
  readonly model: string;
  readonly thinkingLevel?: GenerationThinkingLevel;
  // Both looked up after the turn has started, so a send never waits for them.
  readonly origin: MessageOrigin | (() => Promise<MessageOrigin>);
  readonly inWorkspace: () => boolean | Promise<boolean>;
}

/** One person's message reached a running turn. Subagent turns never come through here. */
export function reportChatMessageSent(sent: ChatMessageSent): void {
  const report = captureAnalyticsReporter();
  void Promise.all([
    Promise.resolve().then(sent.inWorkspace).catch(() => false),
    Promise.resolve().then(() => (typeof sent.origin === "function" ? sent.origin() : sent.origin)),
  ])
    .then(([inWorkspace, origin]) =>
      report("chat_message_sent", {
        provider_id: analyticsProviderId(sent.providerId),
        model_id: analyticsModelId(sent.providerId, sent.model),
        in_workspace: inWorkspace,
        thinking: analyticsThinking(sent.thinkingLevel),
        origin,
      }),
    )
    .catch(() => undefined);
}

/** A person's own connection is only ever counted as "custom"; its name and URL stay here. */
export function reportCustomProviderConnected(provider: StoredProvider): void {
  const local = !provider.needsKey || resolveProviderDeployment(provider) === "local";
  reportAnalyticsEvent("provider_connected", { provider_id: "custom", auth: local ? "local" : "key" });
}

/** A connector the person added: a preset's id, otherwise `custom`. */
export function reportConnectorAdded(server: Pick<McpServer, "id" | "transport">): void {
  reportAnalyticsEvent("connector_added", {
    preset_id: analyticsConnectorPresetId(getMcpPresetForServerId(server.id)?.id),
    transport: server.transport,
  });
}
