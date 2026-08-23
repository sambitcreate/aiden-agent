import type { PortableConfigShape, SettingsShape } from "./portable-config-core.js";
import type { BotRuntimeInventoryMutation } from "./bot-runtime-inventory-lease.js";

type Invalidate = (reason: BotRuntimeInventoryMutation) => void;

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
