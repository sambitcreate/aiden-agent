/** The slice of Electron's `app.dock` that changing the Dock icon needs. */
export interface DockIconSurface {
  setIcon(icon: unknown): void;
  isVisible(): boolean;
  show(): Promise<void>;
}

/**
 * Sets the Dock icon, and shows the Dock tile only when it is hidden.
 *
 * Never call `dock.show()` on a tile that is already visible. While Aiden is
 * the active app, Electron's `show()` first activates the Dock process, then
 * re-registers Aiden as a foreground app a second later and tries to
 * reactivate it. On current macOS that reactivation is refused, so Aiden's
 * window drops behind other apps and Aiden moves to the end of the Cmd-Tab
 * list. Startup restores the saved icon right after the window opens, so an
 * unconditional `show()` made Aiden hide itself on some launches.
 */
export async function applyDockIcon(dock: DockIconSurface, icon: unknown): Promise<void> {
  dock.setIcon(icon);
  if (!dock.isVisible()) await dock.show();
}
