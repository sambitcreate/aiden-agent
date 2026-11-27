import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "../components/ui";
import { settingsApi } from "./ipc";
import { queryKeys } from "./queries";
import type { AppSettings } from "./types";

type SettingsPatch = Parameters<typeof settingsApi.set>[0];

export interface UseSettingsSaveOptions {
  guard: "state" | "ref";
}

export interface SaveSettingsOptions {
  /** Show `error.message` when the caught value is an `Error` (default `true`). */
  errorText?: boolean;
  afterSave?: () => Promise<unknown>;
}

/**
 * Shared save / disable / toast state machine for Settings controls backed by
 * `settingsApi.set`. `save` stays unmemoized so `guard: "state"` always reads
 * the current render's `saving` value rather than a stale closure.
 */
export function useSettingsSave({ guard }: UseSettingsSaveOptions) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);

  const save = async (
    patch: SettingsPatch,
    failure: string,
    options?: SaveSettingsOptions,
  ) => {
    if (guard === "ref") {
      if (savingRef.current) return;
      savingRef.current = true;
    } else if (saving) {
      return;
    }
    setSaving(true);
    try {
      const saved = await settingsApi.set(patch);
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
      await options?.afterSave?.();
    } catch (error) {
      const message =
        options?.errorText !== false && error instanceof Error ? error.message : failure;
      toast.error(message);
    } finally {
      if (guard === "ref") savingRef.current = false;
      setSaving(false);
    }
  };

  return { saving, save };
}
