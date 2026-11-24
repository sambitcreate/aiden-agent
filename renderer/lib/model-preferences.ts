// The single renderer read/save path for model-list pins and recent models.
// They live in main-process AppSettings; reads come from the shared settings
// query, so every surface (and window) stays in step with it.

import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { settingsApi } from "./ipc";
import { queryKeys, useSettings } from "./queries";
import {
  normalizePinnedModels,
  normalizeRecentModels,
  type ModelPreferencesPatch,
} from "../shared/model-preferences";
import type { AppSettings } from "./types";

export type { ModelPreferencesPatch } from "../shared/model-preferences";

/** The persisted pins and recent models, normalized fail-closed. */
export interface ModelPreferences {
  pinnedModels: string[];
  /** Newest first. */
  recentModels: string[];
}

export type ModelPreferencesUpdate =
  | ModelPreferencesPatch
  | ((current: ModelPreferences) => ModelPreferencesPatch);

export function modelPreferencesFrom(settings: AppSettings | undefined): ModelPreferences {
  return {
    pinnedModels: normalizePinnedModels(settings?.pinnedModels) ?? [],
    recentModels: normalizeRecentModels(settings?.recentModels) ?? [],
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
 * Persist pins and recent models through `settings:set`.
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
 * An empty patch writes nothing and resolves with the current settings.
 */
export async function saveModelPreferences(
  queryClient: QueryClient,
  update: ModelPreferencesUpdate,
): Promise<AppSettings> {
  let queue = saveQueues.get(queryClient);
  if (!queue) {
    queue = { tail: Promise.resolve(), latest: 0 };
    saveQueues.set(queryClient, queue);
  }
  await queryClient.cancelQueries({ queryKey: queryKeys.settings });
  // An updater must never compose onto an unloaded (empty) view, or it would
  // overwrite the persisted pins with only the new change.
  if (typeof update === "function") {
    await queryClient.ensureQueryData({ queryKey: queryKeys.settings, queryFn: settingsApi.get });
  }
  // From here to queueing the write is synchronous, so the read, the
  // optimistic write and the ticket cannot interleave with another save.
  const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
  const patch = typeof update === "function" ? update(modelPreferencesFrom(previous)) : update;
  // Nothing to store: skip the disk write (and any error it could raise).
  if (Object.keys(patch).length === 0) {
    return (
      previous ??
      queryClient.ensureQueryData({ queryKey: queryKeys.settings, queryFn: settingsApi.get })
    );
  }
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

/** Read the pins and recent models and get the one save function every model list uses. */
export function useModelPreferences(): ModelPreferences & {
  /** False until the settings query has resolved at least once. */
  ready: boolean;
  save: (update: ModelPreferencesUpdate) => Promise<AppSettings>;
} {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const pins = settings.data?.pinnedModels;
  const recents = settings.data?.recentModels;
  const preferences = React.useMemo(
    () => modelPreferencesFrom({ pinnedModels: pins, recentModels: recents }),
    [pins, recents],
  );
  const save = React.useCallback(
    (update: ModelPreferencesUpdate) => saveModelPreferences(queryClient, update),
    [queryClient],
  );
  return { ...preferences, ready: settings.data !== undefined, save };
}
