import * as React from "react";
import { FileArchive, FolderOpen, Loader2, ShieldAlert, Trash2 } from "lucide-react";

import { diagnosticsApi } from "../../lib/ipc";
import type { DiagnosticSupportStatusView } from "../../shared/diagnostics";
import { AlertDialog, Button, Field, FieldSet, toast } from "../ui";

type Confirmation = "delete" | "dump-export" | "mode" | null;
type Action = "delete" | "export" | "mode" | "reveal" | null;

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function statusDescription(status: DiagnosticSupportStatusView | null, failed: boolean): string {
  if (failed) return "Aiden could not inspect local diagnostic storage. Existing app data is unaffected.";
  if (!status) return "Checking the bounded, device-local diagnostic journal…";
  const range = status.oldestAt
    ? ` Oldest retained event: ${new Date(status.oldestAt).toLocaleDateString()}.`
    : "";
  return `${formatBytes(status.retainedBytes)} across ${status.fileCount} local file${status.fileCount === 1 ? "" : "s"}.${range} Nothing is uploaded automatically.`;
}

export function DiagnosticsSettings() {
  const [status, setStatus] = React.useState<DiagnosticSupportStatusView | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [action, setAction] = React.useState<Action>(null);
  const [confirmation, setConfirmation] = React.useState<Confirmation>(null);
  const deleteRef = React.useRef<HTMLButtonElement | null>(null);
  const dumpExportRef = React.useRef<HTMLButtonElement | null>(null);
  const modeRef = React.useRef<HTMLButtonElement | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const next = await diagnosticsApi.status();
      setStatus(next);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const reveal = async () => {
    if (action) return;
    setAction("reveal");
    try {
      await diagnosticsApi.reveal();
    } catch {
      toast.error("Aiden could not reveal the diagnostics folder.");
    } finally {
      setAction(null);
    }
  };

  const exportDiagnostics = async (includeCrashDumps: boolean) => {
    if (action) return;
    setAction("export");
    try {
      const result = await diagnosticsApi.export(includeCrashDumps);
      if (result.exported) toast.success("Diagnostics exported. Aiden did not send the file anywhere.");
    } catch {
      toast.error("Aiden could not build a privacy-safe diagnostics export.");
    } finally {
      setAction(null);
      setConfirmation(null);
      await refresh();
    }
  };

  const deleteDiagnostics = async () => {
    if (action) return;
    setAction("delete");
    try {
      await diagnosticsApi.delete();
      toast.success("Local diagnostic data deleted.");
      setConfirmation(null);
      await refresh();
    } catch {
      toast.error("Aiden could not delete all local diagnostic data.");
    } finally {
      setAction(null);
    }
  };

  const enableMode = async () => {
    if (action) return;
    setAction("mode");
    try {
      const result = await diagnosticsApi.enableMode();
      if (result.enabled) toast.success("Diagnostic mode is active until Aiden restarts.");
      setConfirmation(null);
      await refresh();
    } catch {
      toast.error("Aiden could not enable local crash capture.");
    } finally {
      setAction(null);
    }
  };

  const busy = action !== null;
  return (
    <>
      <FieldSet title="Diagnostics">
        <Field
          label="Local evidence"
          description={statusDescription(status, loadFailed)}
        >
          <div className="flex flex-wrap justify-end gap-2 max-[540px]:justify-start">
            <Button size="small" variant="filled" disabled={busy} onClick={() => void reveal()}>
              {action === "reveal" ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              Reveal
            </Button>
            <Button
              size="small"
              variant="filled"
              disabled={busy}
              onClick={() => void exportDiagnostics(false)}
            >
              {action === "export" ? <Loader2 className="animate-spin" /> : <FileArchive />}
              Export…
            </Button>
          </div>
        </Field>
        <Field
          className="border-t border-separator"
          label="Crash capture"
          description={
            status?.diagnosticMode.enabled
              ? `Active until Aiden restarts. ${status.diagnosticMode.crashDumpCount} local crash dump${status.diagnosticMode.crashDumpCount === 1 ? "" : "s"} retained.`
              : "Off by default. When explicitly enabled, local memory dumps may contain sensitive app or workspace data and stop after restart."
          }
        >
          <div className="flex flex-wrap justify-end gap-2 max-[540px]:justify-start">
            {status?.diagnosticMode.crashDumpCount ? (
              <Button
                ref={dumpExportRef}
                size="small"
                variant="filled"
                disabled={busy}
                onClick={() => setConfirmation("dump-export")}
              >
                <FileArchive />
                Export with dumps…
              </Button>
            ) : null}
            <Button
              ref={modeRef}
              size="small"
              variant="filled"
              disabled={busy || status?.diagnosticMode.enabled}
              onClick={() => setConfirmation("mode")}
            >
              {action === "mode" ? <Loader2 className="animate-spin" /> : <ShieldAlert />}
              {status?.diagnosticMode.enabled ? "Active until restart" : "Enable…"}
            </Button>
          </div>
        </Field>
        <Field
          className="border-t border-separator"
          label="Delete diagnostic data"
          description="Removes journals, aggregates, and crash dumps only. Chats, settings, credentials, projects, and models stay untouched."
        >
          <div className="settings-action-align-narrow flex justify-end max-[540px]:justify-start">
            <Button
              ref={deleteRef}
              size="small"
              variant="filled"
              disabled={busy}
              onClick={() => setConfirmation("delete")}
            >
              {action === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Delete…
            </Button>
          </div>
        </Field>
        {status?.sinkFailed || status?.droppedWrites ? (
          <p role="status" className="border-t border-separator px-4 py-3 text-small text-secondary">
            Some diagnostic evidence could not be retained. Product data and normal app behavior are unaffected.
          </p>
        ) : null}
      </FieldSet>

      <AlertDialog
        open={confirmation === "delete"}
        onOpenChange={(open) => setConfirmation(open ? "delete" : null)}
        title="Delete local diagnostic data?"
        description="This permanently removes Aiden’s bounded local journals, health aggregates, and crash dumps. It does not delete chats, settings, credentials, projects, or downloaded models."
        confirmLabel={action === "delete" ? "Deleting…" : "Delete diagnostic data"}
        confirmVariant="destructive"
        busy={action === "delete"}
        keepOpenOnConfirm
        returnFocus={() => deleteRef.current}
        onConfirm={deleteDiagnostics}
      />
      <AlertDialog
        open={confirmation === "dump-export"}
        onOpenChange={(open) => setConfirmation(open ? "dump-export" : null)}
        title="Include sensitive crash dumps?"
        description="Memory dumps can contain prompts, workspace content, credentials, or other in-memory data. The export stays local and Aiden will not upload it."
        confirmLabel={action === "export" ? "Exporting…" : "Include & export"}
        busy={action === "export"}
        keepOpenOnConfirm
        returnFocus={() => dumpExportRef.current}
        onConfirm={() => exportDiagnostics(true)}
      />
      <AlertDialog
        open={confirmation === "mode"}
        onOpenChange={(open) => setConfirmation(open ? "mode" : null)}
        title="Enable local crash capture?"
        description="Crash memory may contain sensitive content. Dumps stay on this device, are never uploaded automatically, retain at most three files for seven days, and capture turns off when Aiden restarts."
        confirmLabel={action === "mode" ? "Enabling…" : "Enable until restart"}
        busy={action === "mode"}
        keepOpenOnConfirm
        returnFocus={() => modeRef.current}
        onConfirm={enableMode}
      />
    </>
  );
}
