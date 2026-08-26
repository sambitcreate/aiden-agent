import type { ChildProcess } from "node:child_process";
import {
  performanceDiagnosticsEnabled,
  recordDiagnosticCounter,
  recordDiagnosticGauge,
} from "./performance-diagnostics.js";

export type DiagnosticChildOwner =
  | "computer-use-broker"
  | "computer-use-driver"
  | "coding-tool"
  | "dictation-paste"
  | "external-editor"
  | "foundation-models"
  | "git"
  | "local-model-extract"
  | "mcp-stdio"
  | "profile"
  | "schedule-script"
  | "subagent-file-mutator"
  | "subagent-run-store"
  | "subagent-shell"
  | "workspace-search"
  | "worktree-remover";

let liveChildren = 0;
const liveByOwner = new Map<DiagnosticChildOwner, number>();

function updateGauges(owner: DiagnosticChildOwner, delta: number): void {
  liveChildren = Math.max(0, liveChildren + delta);
  const ownerCount = Math.max(0, (liveByOwner.get(owner) ?? 0) + delta);
  liveByOwner.set(owner, ownerCount);
  recordDiagnosticGauge("live:child", liveChildren);
  recordDiagnosticGauge(`live:child-${owner}`, ownerCount);
}

/** Observe a main-owned child without consuming or changing any of its streams. */
export function trackDiagnosticChild(owner: DiagnosticChildOwner, child: ChildProcess): void {
  if (!performanceDiagnosticsEnabled) return;
  const started = performance.now();
  let settled = false;
  let emittedError = false;
  recordDiagnosticCounter(`child:${owner}`);
  updateGauges(owner, 1);
  const settle = (reason: "clean" | "error" | "signal") => {
    if (settled) return;
    settled = true;
    updateGauges(owner, -1);
    recordDiagnosticCounter(`child-exit:${owner}:${reason}`, {
      errors: reason === "clean" ? 0 : 1,
      durationMs: performance.now() - started,
    });
  };
  child.once("error", () => {
    emittedError = true;
    recordDiagnosticCounter(`child-error:${owner}`, { errors: 1 });
  });
  child.once("close", (code, signal) =>
    settle(signal ? "signal" : code === 0 && !emittedError ? "clean" : "error"),
  );
}
