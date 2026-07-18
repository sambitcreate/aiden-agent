import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster } from "@glaze/core/components";
import { initLogging } from "@glaze/core/utils";
import { SettingsView } from "./settings-view";
import "../styles.css";
import { applyDarkThemeOverrides } from "../lib/dark-theme-overrides";

initLogging();
applyDarkThemeOverrides();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SettingsView />
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
