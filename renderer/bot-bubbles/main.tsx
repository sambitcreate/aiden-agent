// Entry point for the Bot bubbles overlay window (bot-bubbles.html): a
// transparent, click-through window over one display that draws Bot heads and
// their mini chats over every app.

import "../styles.css";
import "./bot-bubbles.css";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster } from "../components/ui";
import { applyCachedAppearance } from "../lib/appearance-runtime";
import { startSecondaryWindowAppearanceSync } from "../lib/pill-appearance";
import { installInputModality } from "../lib/input-modality";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES, parseAppCapabilities } from "../lib/app-capabilities";
import { appApi } from "../lib/ipc";
import { BotBubbleOverlayApp } from "./overlay-app";

applyCachedAppearance();
installInputModality();
startSecondaryWindowAppearanceSync();
document.documentElement.dataset.botBubbleOverlay = "";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function BotBubblesRoot() {
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
          <BotBubbleOverlayApp />
          <Toaster position="bottom-center" offset={16} />
        </TooltipProvider>
      </AppCapabilitiesProvider>
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<BotBubblesRoot />);
}
