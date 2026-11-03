import { useEffect, useState } from "react";
import { APPEARANCE_CHANGE_EVENT, readCurrentAppearance } from "./appearance-runtime";
import { createDefaultAppearanceConfig, type AppearanceConfig } from "../shared/appearance";

const defaults = createDefaultAppearanceConfig();

/** Subscribe to one primitive, including live previews when browser storage is unavailable. */
export function useAppearancePreference<Key extends "workDetails" | "workDetailsCollapseTiming" | "busySendBehavior">(
  key: Key,
): AppearanceConfig[Key] {
  const [value, setValue] = useState(() => readCurrentAppearance()?.[key] ?? defaults[key]);
  useEffect(() => {
    const update = (event: Event) => {
      const config = (event as CustomEvent<{ config: AppearanceConfig }>).detail?.config;
      setValue(config?.[key] ?? readCurrentAppearance()?.[key] ?? defaults[key]);
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    update(new Event("refresh"));
    return () => {
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [key]);
  return value;
}
