import type {
  PortableConfigShape,
  ProviderModelCacheShape,
  SettingsShape,
} from "./portable-config-core.js";
import type { BotRuntimeInventoryMutation } from "./bot-runtime-inventory-lease.js";

type Invalidate = (reason: BotRuntimeInventoryMutation) => void;

/**
 * Fence both sides of a Pi catalog refresh. Its durable store write happens
 * before Pi publishes the refreshed in-memory models, so either edge alone
 * leaves a window where a Bot turn could acquire stale authority.
 */
export async function withBotProviderInventoryMutation<T>(
  action: () => Promise<T>,
  invalidate: Invalidate,
): Promise<T> {
  invalidate("provider_configuration");
  try {
    return await action();
  } finally {
    invalidate("provider_configuration");
  }
}

export function invalidateChangedBotPortableAuthority(
  previous: PortableConfigShape | null,
  next: PortableConfigShape,
  invalidate: Invalidate,
): void {
  if (!previous) return;
  if (JSON.stringify(previous.providers) !== JSON.stringify(next.providers)) {
    invalidate("provider_configuration");
  }
  if (JSON.stringify(previous.mcpServers) !== JSON.stringify(next.mcpServers)) {
    invalidate("mcp_configuration");
  }
  if (JSON.stringify(previous.skills) !== JSON.stringify(next.skills)) {
    invalidate("skill_configuration");
  }
}

export function invalidateChangedBotProviderModelAuthority(
  previous: ProviderModelCacheShape | null,
  next: ProviderModelCacheShape,
  invalidate: Invalidate,
): void {
  if (previous && JSON.stringify(previous.byProvider) !== JSON.stringify(next.byProvider)) {
    invalidate("provider_configuration");
  }
}

export function invalidateChangedBotSettingsAuthority(
  previous: SettingsShape | null,
  next: SettingsShape,
  invalidate: Invalidate,
): void {
  if (
    previous &&
    (
      previous.settings.exaEnabled !== next.settings.exaEnabled ||
      previous.settings.computerUseEnabled !== next.settings.computerUseEnabled ||
      previous.settings.scheduledTasksEnabled !== next.settings.scheduledTasksEnabled
    )
  ) {
    invalidate("settings");
  }
}
