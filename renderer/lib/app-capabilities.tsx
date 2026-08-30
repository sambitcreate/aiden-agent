import * as React from "react";

export interface AppCapabilities {
  platform: "darwin" | "linux" | "other";
  subagents: boolean;
  bots: boolean;
  computerUse: boolean;
  dockIcon: boolean;
  accessibilityPaste: boolean;
  nativeShare: boolean;
  appleFoundationModels: boolean;
}

export const DISABLED_APP_CAPABILITIES: AppCapabilities = Object.freeze({
  platform: "other",
  subagents: false,
  bots: false,
  computerUse: false,
  dockIcon: false,
  accessibilityPaste: false,
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
    computerUse: record.computerUse === true,
    dockIcon: record.dockIcon === true,
    accessibilityPaste: record.accessibilityPaste === true,
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
    const update = async () => {
      try {
        const next = await refresh();
        if (!cancelled) setCurrent(next);
      } catch {
        if (!cancelled) timer = setTimeout(() => void update(), 1_000);
      }
    };
    void update();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  return (
    <AppCapabilitiesContext.Provider value={current}>{children}</AppCapabilitiesContext.Provider>
  );
}

export function useAppCapabilities(): AppCapabilities {
  return React.useContext(AppCapabilitiesContext);
}
