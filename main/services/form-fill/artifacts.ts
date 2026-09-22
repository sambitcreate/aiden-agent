import * as path from "node:path";
import { app, ipcMain } from "../../platform.js";
import { FormFillArtifactStore } from "./artifacts-core.js";
import { FormFillHelperClient } from "./helper-client.js";
import { defaultFormFillHelperPaths } from "./helper-paths.js";
import { FormFillRuntime } from "./runtime.js";

export * from "./artifacts-core.js";

export function formFillModelRootDir(): string {
  return path.join(app.getPath("userData"), "form-fill-model");
}

export const formFillArtifacts = new FormFillArtifactStore({
  rootDir: formFillModelRootDir(),
  onStatusChanged: (status) => {
    ipcMain.broadcast("formFill:progress", status);
  },
});

export const formFillRuntime = new FormFillRuntime(formFillArtifacts, {
  clientFactory: () =>
    new FormFillHelperClient({ pathsResolver: defaultFormFillHelperPaths }),
});
