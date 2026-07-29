import * as React from "react";

export interface AppCapabilities {
  subagents: boolean;
}

export const DISABLED_APP_CAPABILITIES: AppCapabilities = Object.freeze({
  subagents: false,
});

export function parseAppCapabilities(value: unknown): AppCapabilities {
  if (
    typeof value !== "object" ||
    value === null ||
    !("subagents" in value) ||
    value.subagents !== true
  ) {
    return DISABLED_APP_CAPABILITIES;
  }
  return { subagents: true };
}

const AppCapabilitiesContext = React.createContext<AppCapabilities>(DISABLED_APP_CAPABILITIES);

export function AppCapabilitiesProvider({
  capabilities,
  children,
}: React.PropsWithChildren<{ capabilities: AppCapabilities }>) {
  return (
    <AppCapabilitiesContext.Provider value={capabilities}>
      {children}
    </AppCapabilitiesContext.Provider>
  );
}

export function useAppCapabilities(): AppCapabilities {
  return React.useContext(AppCapabilitiesContext);
}
