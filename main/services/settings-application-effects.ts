import { ipcMain } from "../platform.js";
import { stopAllPiCacheWarmers } from "./pi-cache-warming.js";
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
  refreshCommands: async () => {
    const { telegramService } = await import("./telegram/telegram-service.js");
    void telegramService.refreshCommands();
  },
  reconfigureIdleUnload: async () => {
    const { reconfigureLocalSpeechIdleUnload } = await import("./local-speech.js");
    void reconfigureLocalSpeechIdleUnload();
  },
  preloadLocalVoice: () => {
    void import("./local-voice-preload.js").then(({ preloadLocalVoice }) => preloadLocalVoice());
  },
  stopCacheWarmers: () => stopAllPiCacheWarmers(),
  revokeComputerUseGrants: async () => {
    const { revokeComputerUseGrants } = await import("./computer-use/access-gate.js");
    revokeComputerUseGrants();
  },
  stopLiveSessions: async () => {
    const { geminiLiveService } = await import("./gemini-live/service-main.js");
    geminiLiveService.stopAllSessions();
  },
  publishAppearance: (saved) =>
    ipcMain.broadcast(
      "settings:appearance-changed",
      appearancePreview.persisted(normalizeAppearanceConfig(saved.appearance)),
    ),
  publishControls: publishAppControlsChanged,
});
