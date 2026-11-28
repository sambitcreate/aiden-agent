// Dedicated entry point for the Floating Chat Starter (Quick Chat) window.

import "../styles.css";
import "./quick-chat.css";
import { Toaster } from "../components/ui";
import { mountSecondaryWindow } from "../lib/secondary-window-root";
import { FloatingChatApp } from "./floating-chat-app";

mountSecondaryWindow({
  app: <FloatingChatApp />,
  toaster: (
    <Toaster
      position="bottom-center"
      offset={16}
      mobileOffset={{ bottom: 16, left: 68, right: 68 }}
    />
  ),
});
