import type { AcpHarnessStatus } from "../../../renderer/shared/acp-harness.js";
import type { AcpRuntimeState } from "./installer.js";

/** Project installer state onto the renderer-safe status shape. */
export function projectRuntime(state: AcpRuntimeState): AcpHarnessStatus["runtime"] {
  switch (state.status) {
    case "unsupported":
      return { status: "unsupported", message: state.reason };
    case "not_installed":
      return { status: "not_installed", version: state.version, downloadBytes: state.downloadBytes, requiredBytes: state.requiredBytes };
    case "installing":
      return {
        status: "installing",
        version: state.version,
        phase: state.progress.phase,
        ...(state.progress.receivedBytes !== undefined ? { receivedBytes: state.progress.receivedBytes } : {}),
        ...(state.progress.totalBytes !== undefined ? { totalBytes: state.progress.totalBytes } : {}),
      };
    case "installed":
      return { status: "installed", version: state.version };
    case "update_available":
      return {
        status: "update_available",
        version: state.version,
        installedVersion: state.installedVersion,
        downloadBytes: state.downloadBytes,
        requiredBytes: state.requiredBytes,
      };
    case "failed":
      return {
        status: "failed",
        version: state.version,
        message: state.message,
        downloadBytes: state.downloadBytes,
        requiredBytes: state.requiredBytes,
      };
  }
}
