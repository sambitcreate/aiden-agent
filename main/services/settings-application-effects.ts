import { ipcMain } from "../platform.js";
import { publishAppControlsChanged } from "./app-controls-events-main.js";
import { AppearancePreviewState } from "./appearance-preview-core.js";
import { normalizeAppearanceConfig } from "../../renderer/shared/appearance.js";
import { skillRegistry } from "./skill-registry-main.js";
import { invalidateBotRuntimeInventoryAuthority } from "./bot-runtime-inventory-lease.js";
import { createSettingsApplicationEffects } from "./settings-application-effects-core.js";

/** Same preview ordering and side effects for Settings, chat and paired-device writes. */
export const appearancePreview = new AppearancePreviewState();
export const applySettingsEffects = createSettingsApplicationEffects({
  invalidateSkills: () => skillRegistry.invalidate(),
  revokeBotSkills: () => invalidateBotRuntimeInventoryAuthority("skill_configuration"),
  cancelSkillWork: async () => {
    const { llmClient } = await import("./llm-client.js");
    llmClient.cancelForSkillsDisabled();
    const { contextLifecycleService } = await import("./context-lifecycle-service-main.js");
    contextLifecycleService.cancelForSkillsDisabled();
  },
  refreshCommands: async () => {
    const { telegramService } = await import("./telegram/telegram-service.js");
    void telegramService.refreshCommands();
  },
  reconfigureIdleUnload: async () => {
    const { reconfigureParakeetIdleUnload } = await import("./parakeet.js");
    void reconfigureParakeetIdleUnload();
  },
  publishAppearance: (saved) =>
    ipcMain.broadcast(
      "settings:appearance-changed",
      appearancePreview.persisted(normalizeAppearanceConfig(saved.appearance)),
    ),
  publishControls: publishAppControlsChanged,
});
