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

interface SaveQueue {
  /** Settles after the most recently queued write. */
  tail: Promise<unknown>;
  /** Ticket of the most recently queued write. */
  latest: number;
}

const saveQueues = new WeakMap<QueryClient, SaveQueue>();

/**
 * Persist Pad fields through `settings:set`.
 *
 * - The settings cache is updated optimistically, after cancelling any
 *   in-flight settings refetch so it cannot clobber the optimistic value.
 * - Writes are sent one at a time per QueryClient, in call order, so main
 *   applies them in order; each patch was composed on the optimistic cache,
 *   so the newest write carries every earlier change.
 * - Only the newest write's reply (or failure refetch) touches the cache, so a
 *   late reply to an older write never rolls back a newer optimistic state.
 *
 * Each field in the patch replaces the stored value; omitted fields are untouched.
 */
export async function saveModelPadPreferences(
  queryClient: QueryClient,
  update: ModelPadPreferencesUpdate,
): Promise<AppSettings> {
  let queue = saveQueues.get(queryClient);
  if (!queue) {
    queue = { tail: Promise.resolve(), latest: 0 };
    saveQueues.set(queryClient, queue);
  }
  await queryClient.cancelQueries({ queryKey: queryKeys.settings });
  // An updater must never compose onto an unloaded (empty) view, or it would
  // overwrite the persisted pins/layout with only the new change.
  if (typeof update === "function") {
    await queryClient.ensureQueryData({ queryKey: queryKeys.settings, queryFn: settingsApi.get });
  }
  // From here to queueing the write is synchronous, so the read, the
  // optimistic write and the ticket cannot interleave with another save.
  const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
  const patch = typeof update === "function" ? update(modelPadPreferencesFrom(previous)) : update;
  if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, { ...previous, ...patch });
  const ticket = ++queue.latest;
  const write = queue.tail.catch(() => undefined).then(() => settingsApi.set(patch));
  queue.tail = write;
  try {
    const saved = await write;
    if (ticket === queue.latest) queryClient.setQueryData(queryKeys.settings, saved);
    return saved;
  } catch (error) {
    if (ticket === queue.latest) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    }
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
