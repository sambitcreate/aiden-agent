import * as React from "react";
import { shortcutApi } from "./ipc";

export interface AppCapabilities {
  platform: "darwin" | "linux" | "other";
  subagents: boolean;
  bots: boolean;
  appUpdates: boolean;
  computerUse: boolean;
  dockIcon: boolean;
  accessibilityPaste: boolean;
  dictationHoldToTalk: boolean;
  dictationHoldSetup: boolean;
  dictationHoldTrigger: string | null;
  nativeShare: boolean;
  appleFoundationModels: boolean;
}

export const DISABLED_APP_CAPABILITIES: AppCapabilities = Object.freeze({
  platform: "other",
  subagents: false,
  bots: false,
  appUpdates: false,
  computerUse: false,
  dockIcon: false,
  accessibilityPaste: false,
  dictationHoldToTalk: false,
  dictationHoldSetup: false,
  dictationHoldTrigger: null,
  nativeShare: false,
  appleFoundationModels: false,
});

export function parseAppCapabilities(value: unknown): AppCapabilities {
  if (typeof value !== "object" || value === null) return DISABLED_APP_CAPABILITIES;
  const record = value as Record<string, unknown>;
  return {
    platform:
      record.platform === "darwin" || record.platform === "linux"
        ? record.platform
        : "other",
    subagents: record.subagents === true,
    bots: record.bots === true,
    appUpdates: record.appUpdates === true,
    computerUse: record.computerUse === true,
    dockIcon: record.dockIcon === true,
    accessibilityPaste: record.accessibilityPaste === true,
    dictationHoldToTalk: record.dictationHoldToTalk === true,
    dictationHoldSetup: record.dictationHoldSetup === true,
    dictationHoldTrigger: typeof record.dictationHoldTrigger === "string" ? record.dictationHoldTrigger.slice(0, 128) : null,
    nativeShare: record.nativeShare === true,
    appleFoundationModels: record.appleFoundationModels === true,
  };
}

const AppCapabilitiesContext = React.createContext<AppCapabilities>(DISABLED_APP_CAPABILITIES);

export function AppCapabilitiesProvider({
  capabilities,
  refresh,
  children,
}: React.PropsWithChildren<{
  capabilities: AppCapabilities;
  refresh?: () => Promise<AppCapabilities>;
}>) {
  const [current, setCurrent] = React.useState(capabilities);

  React.useEffect(() => setCurrent(capabilities), [capabilities]);

  React.useEffect(() => {
    if (!refresh) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const update = async () => {
      const request = ++revision;
      try {
        const next = await refresh();
        if (!cancelled && request === revision) setCurrent(next);
      } catch {
        if (!cancelled && request === revision) timer = setTimeout(() => void update(), 1_000);
      }
    };
    void update();
    const onFocus = () => void update();
    window.addEventListener("focus", onFocus);
    const unsubscribe = shortcutApi.onChanged(onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      unsubscribe();
    };
  }, [refresh]);

  return (
    <AppCapabilitiesContext.Provider value={current}>{children}</AppCapabilitiesContext.Provider>
  );
}

export function useAppCapabilities(): AppCapabilities {
  return React.useContext(AppCapabilitiesContext);
}
