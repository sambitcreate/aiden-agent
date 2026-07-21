import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router, queryClient } from "./router";
import "../styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster } from "../components/ui";
import { initLogging } from "../lib/ui-utils";
import { applyDarkThemeOverrides } from "../lib/dark-theme-overrides";
import { subscribeCodexProviderState } from "../lib/queries";

declare const __APP_DISPLAY_NAME__: string | undefined;

initLogging();
applyDarkThemeOverrides();

const unsubscribeCodexProviderState = subscribeCodexProviderState(queryClient);
if (import.meta.hot) import.meta.hot.dispose(unsubscribeCodexProviderState);

document.title = __APP_DISPLAY_NAME__ || document.title;

// Get the root element
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Create React root and render
const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);

// Hot Module Replacement (HMR) support
if (import.meta.hot) {
  import.meta.hot.accept();
}
