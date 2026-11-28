// Entry point for the Bot bubbles overlay window (bot-bubbles.html): a
// transparent, click-through window over one display that draws Bot heads and
// their mini chats over every app.

import "../styles.css";
import "./bot-bubbles.css";
import { Toaster } from "../components/ui";
import { mountSecondaryWindow } from "../lib/secondary-window-root";
import { BotBubbleOverlayApp } from "./overlay-app";

document.documentElement.dataset.botBubbleOverlay = "";

mountSecondaryWindow({
  app: <BotBubbleOverlayApp />,
  toaster: <Toaster position="bottom-center" offset={16} />,
});
