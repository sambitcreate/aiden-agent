import * as React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../components/ui";
import { applyCachedAppearance } from "./appearance-runtime";
import { startSecondaryWindowAppearanceSync } from "./pill-appearance";
import { installInputModality } from "./input-modality";
import {
  AppCapabilitiesProvider,
  DISABLED_APP_CAPABILITIES,
  parseAppCapabilities,
} from "./app-capabilities";
import { appApi } from "./ipc";

export interface SecondaryWindowRootOptions {
  app: React.ReactNode;
  toaster: React.ReactNode;
}

function SecondaryWindowRoot({
  queryClient,
  app,
  toaster,
}: SecondaryWindowRootOptions & { queryClient: QueryClient }) {
  const [capabilities, setCapabilities] = React.useState(DISABLED_APP_CAPABILITIES);
  React.useEffect(() => {
    void appApi
      .getInfo()
      .then((info) => setCapabilities(parseAppCapabilities(info.capabilities)))
      .catch(() => undefined);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AppCapabilitiesProvider capabilities={capabilities}>
        <TooltipProvider delayDuration={350}>
          {app}
          {toaster}
        </TooltipProvider>
      </AppCapabilitiesProvider>
    </QueryClientProvider>
  );
}

export function mountSecondaryWindow({ app, toaster }: SecondaryWindowRootOptions): void {
  applyCachedAppearance();
  installInputModality();
  startSecondaryWindowAppearanceSync();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });

  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(
      <SecondaryWindowRoot queryClient={queryClient} app={app} toaster={toaster} />,
    );
  }
}
