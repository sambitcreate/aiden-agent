import { useQueryClient } from "@tanstack/react-query";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import {
  aidenLivePreferences,
  type AidenLivePreferences,
  type AidenLiveSettingsFields,
} from "../../shared/aiden-live-settings";
import { toast } from "../ui";

export type AidenLivePreferencesPatch = Pick<
  AidenLiveSettingsFields,
  "aidenLiveVoice" | "aidenLiveSpeed" | "aidenLiveRibbonColors"
>;

export interface LivePreferenceSaverTarget {
  read(): AppSettings | undefined;
  write(settings: AppSettings): void;
  persist(patch: AidenLivePreferencesPatch): Promise<AppSettings>;
  /** Reloads the saved settings after a failure. */
  reload(): void;
  onError(): void;
}

/**
 * Saves preference changes one after another. Each change shows at once; a
 * saved result is applied only by the newest save, so a quick run of menu
 * choices always ends on the last one.
 */
export function createLivePreferenceSaver(target: LivePreferenceSaverTarget): (
  patch: AidenLivePreferencesPatch,
) => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  let latest = 0;
  return (patch) => {
    const generation = ++latest;
    const current = target.read();
    if (current) target.write({ ...current, ...patch });
    const run = queue.then(async () => {
      try {
        const saved = await target.persist(patch);
        if (generation === latest) target.write(saved);
      } catch {
        target.onError();
        if (generation === latest) target.reload();
      }
    });
    queue = run;
    return run;
  };
}

const savers = new WeakMap<object, (patch: AidenLivePreferencesPatch) => Promise<void>>();

/**
 * Live's voice, speed and ribbon colours, shared by the ribbon's menu and
 * Settings. A change shows at once; saves run in order, and a failure reloads
 * the saved choice.
 */
export function useAidenLivePreferences(): {
  preferences: AidenLivePreferences;
  loaded: boolean;
  save(patch: AidenLivePreferencesPatch): Promise<void>;
} {
  const settings = useSettings();
  const queryClient = useQueryClient();
  // One queue per query client, shared by the ribbon's menu and Settings.
  let save = savers.get(queryClient);
  if (!save) {
    save = createLivePreferenceSaver({
      read: () => queryClient.getQueryData<AppSettings>(queryKeys.settings),
      write: (next) => queryClient.setQueryData<AppSettings>(queryKeys.settings, next),
      persist: (patch) => settingsApi.set(patch),
      reload: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
      onError: () => toast.error("Couldn’t save that Aiden Live choice."),
    });
    savers.set(queryClient, save);
  }
  return { preferences: aidenLivePreferences(settings.data), loaded: Boolean(settings.data), save };
}
