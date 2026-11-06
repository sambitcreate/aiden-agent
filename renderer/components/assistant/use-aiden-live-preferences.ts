import * as React from "react";
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

/**
 * Live's voice, speed and ribbon colours, shared by the ribbon's menu and
 * Settings. A change shows at once and rolls back if saving fails.
 */
export function useAidenLivePreferences(): {
  preferences: AidenLivePreferences;
  loaded: boolean;
  save(patch: AidenLivePreferencesPatch): Promise<void>;
} {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const save = React.useCallback(
    async (patch: AidenLivePreferencesPatch) => {
      const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
      if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, { ...previous, ...patch });
      try {
        const saved = await settingsApi.set(patch);
        queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
      } catch {
        if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, previous);
        toast.error("Couldn’t save that Aiden Live choice.");
      }
    },
    [queryClient],
  );
  return { preferences: aidenLivePreferences(settings.data), loaded: Boolean(settings.data), save };
}
