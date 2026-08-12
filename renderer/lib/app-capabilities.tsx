import * as React from "react";

export interface AppCapabilities {
  subagents: boolean;
  geminiLive: boolean;
}

export const DISABLED_APP_CAPABILITIES: AppCapabilities = Object.freeze({
  subagents: false,
  geminiLive: false,
});

export function parseAppCapabilities(value: unknown): AppCapabilities {
  if (typeof value !== "object" || value === null) return DISABLED_APP_CAPABILITIES;
  return {
    subagents: "subagents" in value && value.subagents === true,
    geminiLive: "geminiLive" in value && value.geminiLive === true,
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
