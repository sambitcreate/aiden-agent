import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router, queryClient } from "./router";
import "@xyflow/react/dist/base.css";
import "../styles.css";
import "katex/dist/katex.min.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster, toast } from "../components/ui";
import { initLogging } from "../lib/ui-utils";
import { installRendererDiagnostics, reportRendererDiagnostic } from "../lib/dev-log";
import { applyCachedAppearance } from "../lib/appearance-runtime";
import { subscribeCodexProviderState } from "../lib/queries";
import { migrateGoogleProviderPreferences } from "../lib/google-provider-migration";
import { appApi, providersApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import {
  AppCapabilitiesProvider,
  DISABLED_APP_CAPABILITIES,
  parseAppCapabilities,
} from "../lib/app-capabilities";

declare const __APP_DISPLAY_NAME__: string | undefined;

initLogging();
void installRendererDiagnostics();
applyCachedAppearance();
migrateGoogleProviderPreferences(localStorage);

const unsubscribeCodexProviderState = subscribeCodexProviderState(queryClient);
if (import.meta.hot) import.meta.hot.dispose(unsubscribeCodexProviderState);

document.title = __APP_DISPLAY_NAME__ || document.title;

// Get the root element
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

async function bootstrap(): Promise<void> {
  let appCapabilities = DISABLED_APP_CAPABILITIES;
  try {
    const appInfo = await appApi.getInfo();
    appCapabilities = parseAppCapabilities(appInfo.capabilities);
  } catch {
    // Feature capabilities fail closed until main explicitly enables them.
  }

  // Resolve persisted custom aliases before any component reads provider/model
  // preferences. A failed IPC read is non-fatal; the narrow Pi-ID migration
  // above still protects older Gemini/Moonshot selections.
  try {
    const providers = await providersApi.list();
    const aliases = Object.fromEntries(
      providers.flatMap((provider) =>
        (provider.legacyIds ?? []).map((legacyId) => [legacyId, provider.id]),
      ),
    );
    migrateGoogleProviderPreferences(localStorage, aliases);
    queryClient.setQueryData(queryKeys.providers, providers);
    // First paint uses the durable cache. Then explicitly revalidate stale
    // provider catalogs once per renderer launch; this never contacts models.dev.
    void providersApi
      .refreshIfStale()
      .then((result) => {
        queryClient.setQueryData(queryKeys.providers, result.providers);
        if (result.errors.length > 0) {
          toast.warning(
            `${result.errors.length} provider catalog${result.errors.length === 1 ? "" : "s"} could not refresh; cached models were kept. Retry in Provider Settings.`,
          );
        }
      })
      .catch(() => undefined);
  } catch {
    // Provider Settings will surface an actionable main-process error after render.
  }

  const root = ReactDOM.createRoot(rootElement!, {
    onUncaughtError: (error) => reportRendererDiagnostic("react-uncaught", error, "root"),
    onCaughtError: (error) => reportRendererDiagnostic("react-caught", error, "root"),
    onRecoverableError: (error) => reportRendererDiagnostic("react-recoverable", error, "root"),
  });
  const refreshAppCapabilities = async () => {
    const appInfo = await appApi.getInfo();
    return parseAppCapabilities(appInfo.capabilities);
  };
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppCapabilitiesProvider capabilities={appCapabilities} refresh={refreshAppCapabilities}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </AppCapabilitiesProvider>
        <Toaster />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void bootstrap();

// Hot Module Replacement (HMR) support
if (import.meta.hot) {
  import.meta.hot.accept();
}
