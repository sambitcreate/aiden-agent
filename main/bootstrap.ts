import path from "node:path";

import { initDiagnosticJournal, writeDiagnosticEventSync } from "./services/diagnostic-journal.js";
import { initDiagnosticHealth } from "./services/diagnostic-health.js";
import { projectDiagnosticError } from "./services/diagnostics-contract.js";
import { pruneExpiredDiagnosticCrashDumps } from "./services/diagnostic-support.js";
import { installProcessDiagnostics } from "./services/process-diagnostics.js";
import { applyLinuxGraphicsFlags } from "./linux-graphics-flags.js";
import { configureRuntimeProfile } from "./runtime-profile.js";
import {
  initSubagentRuntimeDiagnostics,
  SUBAGENT_RUNTIME_LOG_FILENAME,
} from "./services/subagents/subagent-runtime-diagnostics.js";

applyLinuxGraphicsFlags();
const runtimeProfile = configureRuntimeProfile();
const productionDiagnosticsDisabled =
  runtimeProfile.id === "production" && process.env.AIDEN_DISABLE_PRODUCTION_DIAGNOSTICS === "1";
initSubagentRuntimeDiagnostics(path.join(runtimeProfile.logsPath, SUBAGENT_RUNTIME_LOG_FILENAME));
initDiagnosticHealth(path.join(runtimeProfile.logsPath, "diagnostic-health.json"), !productionDiagnosticsDisabled);
initDiagnosticJournal({
  targetPath: path.join(
    runtimeProfile.logsPath,
    runtimeProfile.id === "development" ? "aiden-dev.log" : "aiden.log",
  ),
  profile: runtimeProfile.id,
  writeMode:
    productionDiagnosticsDisabled
      ? "fatal-only"
      : "all",
});
installProcessDiagnostics();
void pruneExpiredDiagnosticCrashDumps(runtimeProfile.crashDumpsPath).catch(() => undefined);

try {
  await import("./index.js");
} catch (error) {
  const projected = projectDiagnosticError(error);
  writeDiagnosticEventSync({
    level: "fatal",
    area: "app",
    event: "bootstrap-import-failed",
    outcome: "failed",
    code: projected.code,
    fields: { errorType: projected.errorType, fingerprint: projected.fingerprint ?? null },
  });
  throw error;
}
