// Main-window entry. Kept deliberately small: it applies the cached theme and
// issues the two startup reads, then loads the app. The reads resolve in the
// main process while the renderer parses and evaluates the app chunk, so first
// render no longer waits for them serially after module evaluation.

import "../styles.css";
import { invoke } from "../lib/ipc-bridge";
import { applyCachedAppearance } from "../lib/appearance-runtime";
import type { AppInfo } from "../lib/ipc";
import type { Provider } from "../lib/types";
import type { StartupReads } from "./app";

applyCachedAppearance();

const startup: StartupReads = {
  info: invoke<AppInfo>("app:getInfo"),
  providers: invoke<Provider[]>("providers:list"),
};
// The app awaits both and handles failures; never report them as unhandled
// if the app chunk itself fails to load.
startup.info.catch(() => undefined);
startup.providers.catch(() => undefined);

void import("./app").then(
  ({ startApp }) => startApp(startup),
  (error: unknown) => {
    console.error("Aiden failed to load the app bundle", error);
  },
);

// Hot Module Replacement (HMR) support
if (import.meta.hot) {
  import.meta.hot.accept();
}
