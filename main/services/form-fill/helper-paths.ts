import * as path from "node:path";
import { app } from "../../platform.js";
import { isPackagedRuntime } from "../../runtime-mode.js";
import {
  formFillHelperPaths,
  type FormFillHelperPaths,
} from "./helper-client.js";

/** Packaged: Contents/Helpers/…; development: <repo>/build/native/…. */
export function defaultFormFillHelperPaths(): FormFillHelperPaths {
  const helpersDir = isPackagedRuntime()
    ? path.resolve(process.resourcesPath, "..", "Helpers")
    : path.join(app.getAppPath(), "build", "native");
  return formFillHelperPaths(helpersDir);
}
