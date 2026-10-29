import { localVoicePreloadRelevant } from "./local-voice-preload.js";
import type { AppSettings } from "./types.js";

export interface SettingsEffects {
  invalidateSkills(): void;
  revokeBotSkills(): void;
  refreshCommands(): Promise<void>;
  reconfigureIdleUnload(): Promise<void>;
  /** Load the on-device model the new settings would dictate with. Best effort, never awaited. */
  preloadLocalVoice(): void;
  stopCacheWarmers(): void;
  /** Live streams drop a cached grant on their next Computer Use call. */
  revokeComputerUseGrants(): Promise<void>;
  /** A disabled feature must not keep an attended session running in any window. */
  stopLiveSessions(): Promise<void>;
  publishAppearance(saved: AppSettings): void;
  publishControls(): void;
}
/** Called after persistence by both Settings and conversational operations. */
export function createSettingsApplicationEffects(effects: SettingsEffects) {
  return async (saved: AppSettings, patch: Partial<AppSettings>): Promise<void> => {
    if (patch.cacheWarmingEnabled === false) effects.stopCacheWarmers();
    if (patch.computerUseAlwaysAllow === false) await effects.revokeComputerUseGrants();
    if (patch.aidenLiveEnabled === false) await effects.stopLiveSessions();
    if (patch.localVoiceIdleUnloadMinutes !== undefined) await effects.reconfigureIdleUnload();
    if (localVoicePreloadRelevant(patch)) effects.preloadLocalVoice();
    // Turning Skills off stops later skill loads: every skill tool re-checks
    // the setting when called. Replies already running, including the one that
    // made the change, carry on (owner decision 2026-10-27).
    if (patch.skillsEnabled !== undefined) {
      effects.invalidateSkills();
      effects.revokeBotSkills();
      await effects.refreshCommands();
    }
    if (patch.appearance) effects.publishAppearance(saved);
    effects.publishControls();
  };
}
