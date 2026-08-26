import type {
  AmbientMusicApplyResult,
  AmbientMusicConfigV1,
  AmbientMusicFeatureSnapshot,
} from "../../renderer/shared/ambient-music.js";
import type { AppSettings } from "./types.js";

export interface AmbientMusicConfigurationRuntime {
  applyConfiguration(
    config: AmbientMusicConfigV1,
    playAfter: boolean,
  ): Promise<AmbientMusicFeatureSnapshot>;
}

export interface AmbientMusicConfigurationSettings {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}

/**
 * Save and apply one authoritative configuration. A runtime failure restores
 * the prior persisted value; the runtime itself is responsible for unloading
 * its helper transaction on failure so audible state cannot remain partial.
 */
export async function applyAmbientMusicConfiguration(
  runtime: AmbientMusicConfigurationRuntime,
  settings: AmbientMusicConfigurationSettings,
  config: AmbientMusicConfigV1,
  playAfter: boolean,
): Promise<AmbientMusicApplyResult> {
  const previous = (await settings.getSettings()).ambientMusic;
  const saved = await settings.setSettings({ ambientMusic: config });
  try {
    const snapshot = await runtime.applyConfiguration(config, playAfter);
    return { snapshot, config: saved.ambientMusic ?? config };
  } catch (error) {
    try {
      await settings.setSettings({ ambientMusic: previous });
    } catch {
      const failure = new Error(
        "Ambient Music could not apply the mix or restore the previous saved settings.",
      ) as Error & { cause?: unknown };
      failure.cause = error;
      throw failure;
    }
    throw error;
  }
}
