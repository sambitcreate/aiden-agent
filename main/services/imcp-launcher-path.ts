import path from "node:path";
import { app } from "../platform.js";
import { isPackagedRuntime } from "../runtime-mode.js";

export function imcpLauncherPath(): string {
  return isPackagedRuntime()
    ? path.resolve(process.resourcesPath, "..", "Helpers", "aiden-imcp-launcher")
    : path.join(app.getAppPath(), "build", "native", "aiden-imcp-launcher");
}
