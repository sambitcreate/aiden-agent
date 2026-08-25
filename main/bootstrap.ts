import path from "node:path";

import { crashReporter } from "electron";

import { initDevLog, writeDevLog, writeDevLogSync } from "./services/dev-log.js";
import { installProcessDiagnostics } from "./services/process-diagnostics.js";
import { configureRuntimeProfile } from "./runtime-profile.js";
import {
  initSubagentRuntimeDiagnostics,
  SUBAGENT_RUNTIME_LOG_FILENAME,
} from "./services/subagents/subagent-runtime-diagnostics.js";

const runtimeProfile = configureRuntimeProfile();
const crashReporterDisabledForE2e = process.env.AIDEN_E2E_DISABLE_CRASH_REPORTER === "1";
initSubagentRuntimeDiagnostics(path.join(runtimeProfile.logsPath, SUBAGENT_RUNTIME_LOG_FILENAME));
if (runtimeProfile.id === "development") {
  initDevLog(path.join(runtimeProfile.logsPath, "aiden-dev.log"));
  installProcessDiagnostics();
  if (!crashReporterDisabledForE2e) {
    try {
      crashReporter.start({
        uploadToServer: false,
        compress: false,
        globalExtra: { runtimeProfile: runtimeProfile.id },
      });
      writeDevLog("info", "crash-reporter", [
        "Local crash capture enabled",
        { crashDumpsPath: runtimeProfile.crashDumpsPath, uploadToServer: false },
      ]);
    } catch (error) {
      writeDevLogSync("error", "crash-reporter", ["Could not enable local crash capture", error]);
    }
  }
}

try {
  await import("./index.js");
} catch (error) {
  writeDevLogSync("error", "bootstrap", ["Main application import failed", error]);
  throw error;
}
