import { app } from "./platform.js";
import { isDevelopmentRuntime } from "./runtime-mode-core.js";

export { isDevelopmentRuntime } from "./runtime-mode-core.js";

export function isPackagedRuntime(): boolean {
  return app.isPackaged && !isDevelopmentRuntime(process.env, app.isPackaged);
}
