import type { AppSettings } from "./types.js";

export interface SettingsEffects {
  invalidateSkills(): void;
  revokeBotSkills(): void;
  cancelSkillWork(): Promise<void>;
  refreshCommands(): Promise<void>;
  reconfigureIdleUnload(): Promise<void>;
  publishAppearance(saved: AppSettings): void;
  publishControls(): void;
}
/** Called after persistence by both Settings and conversational operations. */
export function createSettingsApplicationEffects(effects: SettingsEffects) {
  return async (saved: AppSettings, patch: Partial<AppSettings>): Promise<void> => {
    if (patch.localVoiceIdleUnloadMinutes !== undefined) await effects.reconfigureIdleUnload();
    if (patch.skillsEnabled !== undefined) {
      effects.invalidateSkills();
      effects.revokeBotSkills();
      if (!patch.skillsEnabled) await effects.cancelSkillWork();
      await effects.refreshCommands();
    }
    if (patch.appearance) effects.publishAppearance(saved);
    effects.publishControls();
  };
}
