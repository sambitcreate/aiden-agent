// Dedicated entry point for the Floating Chat Starter (Quick Chat) window.
// Phase 3 mounts the bootstrap shell; Phase 4 replaces it with FloatingChatApp.

import "../styles.css";
import { createRoot } from "react-dom/client";
import { applyCachedAppearance } from "../lib/appearance-runtime";
import { startPillAppearanceSync } from "../lib/pill-appearance";
import { installInputModality } from "../lib/input-modality";

applyCachedAppearance();
installInputModality();
startPillAppearanceSync();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<div data-testid="quick-chat-root" />);
}
