// The single renderer read/save path for Model Pad preferences (layout and
// picker pins). They live in main-process AppSettings; reads come from the
// shared settings query, so every surface (and window) stays in step with it.

import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { settingsApi } from "./ipc";
import { queryKeys, useSettings } from "./queries";
import { parseModelPadLayout, type ModelPadLayout } from "./model-pad-layout";
import {
  normalizePinnedModels,
  type ModelPadPlacements,
  type ModelPadPreferencesPatch,
} from "../shared/model-pad-preferences";
import type { AppSettings } from "./types";

export type { ModelPadPreferencesPatch } from "../shared/model-pad-preferences";

/** The persisted Pad preferences, normalized fail-closed. */
export interface ModelPadPreferences {
  placements: ModelPadPlacements;
  pinnedModels: string[];
}

export type ModelPadPreferencesUpdate =
  | ModelPadPreferencesPatch
  | ((current: ModelPadPreferences) => ModelPadPreferencesPatch);

export function modelPadPreferencesFrom(settings: AppSettings | undefined): ModelPadPreferences {
  return {
    placements: parseModelPadLayout({ placements: settings?.modelPadPlacements }).placements,
    pinnedModels: normalizePinnedModels(settings?.pinnedModels) ?? [],
  };
}

/**
 * Persist Pad fields through `settings:set`. The settings cache is updated
 * optimistically so rapid successive saves compose; a failed write refetches
 * the persisted settings and rethrows. Each field in the patch replaces the
 * stored value; omitted fields are untouched.
 */
export async function saveModelPadPreferences(
  queryClient: QueryClient,
  update: ModelPadPreferencesUpdate,
): Promise<AppSettings> {
  // An updater must never compose onto an unloaded (empty) view, or it would
  // overwrite the persisted pins/layout with only the new change.
  if (typeof update === "function") {
    await queryClient.ensureQueryData({ queryKey: queryKeys.settings, queryFn: settingsApi.get });
  }
  // Re-read after the await so back-to-back saves compose on each other.
  const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
  const patch = typeof update === "function" ? update(modelPadPreferencesFrom(previous)) : update;
  if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, { ...previous, ...patch });
  try {
    const saved = await settingsApi.set(patch);
    queryClient.setQueryData(queryKeys.settings, saved);
    return saved;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    throw error;
  }
}

/** Read the Pad preferences and get the one save function every Pad surface uses. */
export function useModelPadPreferences(): ModelPadPreferences & {
  /** False until the settings query has resolved at least once. */
  ready: boolean;
  save: (update: ModelPadPreferencesUpdate) => Promise<AppSettings>;
} {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const placements = settings.data?.modelPadPlacements;
  const pins = settings.data?.pinnedModels;
  const preferences = React.useMemo(
    () => modelPadPreferencesFrom({ modelPadPlacements: placements, pinnedModels: pins }),
    [placements, pins],
  );
  const save = React.useCallback(
    (update: ModelPadPreferencesUpdate) => saveModelPadPreferences(queryClient, update),
    [queryClient],
  );
  return { ...preferences, ready: settings.data !== undefined, save };
}

/** The saved Pad layout from settings. */
export function useModelPadLayout(): ModelPadLayout {
  const { placements } = useModelPadPreferences();
  return React.useMemo(() => ({ placements }), [placements]);
}
