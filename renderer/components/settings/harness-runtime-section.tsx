import * as React from "react";

import { Download, Loader2, Trash2 } from "lucide-react";

import { Button, Text, toast } from "../ui";
import { harnessApi } from "../../lib/ipc";
import {
  formatHarnessBytes,
  harnessRuntimeSummary,
  type AcpHarnessStatus,
} from "../../shared/acp-harness";

/** Live runtime status for one agent-backed provider. */
export function useHarnessStatus(providerId: string | undefined): AcpHarnessStatus | null {
  const [status, setStatus] = React.useState<AcpHarnessStatus | null>(null);
  React.useEffect(() => {
    if (!providerId) return undefined;
    let active = true;
    const unsubscribe = harnessApi.onChanged((next) => {
      if (active && next.providerId === providerId) setStatus(next);
    });
    void harnessApi
      .status(providerId)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [providerId]);
  return status;
}

function percent(status: AcpHarnessStatus["runtime"]): number | null {
  if (status.status !== "installing" || status.phase !== "downloading" || !status.totalBytes) return null;
  return Math.min(100, Math.floor(((status.receivedBytes ?? 0) / status.totalBytes) * 100));
}

export interface HarnessRuntimeSectionProps {
  providerId: string;
  label: string;
  status: AcpHarnessStatus | null;
}

/**
 * Install, update and remove a provider's managed runtime. Nothing is
 * downloaded until the user chooses Install; the size and source are stated
 * before that choice.
 */
export function HarnessRuntimeSection({ providerId, label, status }: HarnessRuntimeSectionProps) {
  const [acting, setActing] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const keepRef = React.useRef<HTMLButtonElement>(null);
  const busyReasonId = React.useId();
  React.useEffect(() => {
    // The Remove button unmounts when confirming; keep focus in the dialog.
    if (confirmRemove) keepRef.current?.focus();
  }, [confirmRemove]);
  if (!status) {
    return (
      <Text variant="small" color="tertiary" aria-live="polite">
        Checking the {label} runtime…
      </Text>
    );
  }
  const runtime = status.runtime;
  const progress = percent(runtime);

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setActing(true);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failure);
    } finally {
      setActing(false);
    }
  };

  const install = () =>
    run(async () => {
      const next = await harnessApi.install(providerId);
      if (next.runtime.status === "installed") toast.success(`${label} is installed.`);
    }, `Couldn't install ${label}.`);

  const canInstall =
    runtime.status === "not_installed" || runtime.status === "failed" || runtime.status === "update_available";

  return (
    <div className="grid gap-2" role="group" aria-label={`${label} runtime`}>
      <Text variant="small-strong">Runtime</Text>
      <Text variant="small" color="secondary">
        {harnessRuntimeSummary(runtime)}
      </Text>
      {/* Announce state and phase changes only; the progress bar carries the value. */}
      <span className="sr-only" aria-live="polite">
        {runtime.status === "installing" ? `${label}: ${runtime.phase ?? "installing"}` : harnessRuntimeSummary(runtime)}
      </span>
      {canInstall ? (
        <Text variant="small" color="tertiary">
          {label} runs on Google's own agent runtime.{" "}
          {runtime.downloadBytes ? `Installing downloads ${formatHarnessBytes(runtime.downloadBytes)} from dl.google.com` : "Installing downloads it from dl.google.com"}
          {runtime.requiredBytes ? ` and needs about ${formatHarnessBytes(runtime.requiredBytes)} free.` : "."} Nothing is
          downloaded until you choose Install.
        </Text>
      ) : null}
      {runtime.status === "installing" ? (
        <div className="grid gap-2">
          <div
            className="h-1 w-full max-w-64 overflow-hidden rounded-full bg-control"
            role="progressbar"
            aria-label={`${label} installation progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progress !== null ? { "aria-valuenow": progress } : {})}
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
              style={{ width: `${progress ?? 100}%`, opacity: progress === null ? 0.5 : 1 }}
            />
          </div>
          <Button
            size="small"
            variant="muted"
            className="justify-self-start"
            onClick={() => void harnessApi.cancelInstall(providerId)}
          >
            Cancel installation
          </Button>
        </div>
      ) : null}
      {canInstall ? (
        <Button
          size="small"
          variant="filled"
          className="justify-self-start"
          disabled={acting}
          onClick={() => void install()}
        >
          {acting ? <Loader2 className="animate-spin" /> : <Download />}
          {runtime.status === "update_available"
            ? `Update ${label}`
            : runtime.status === "failed"
              ? "Retry installation"
              : `Install ${label}`}
        </Button>
      ) : null}
      {runtime.status === "installed" ? (
        confirmRemove ? (
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="small" color="secondary">
              Remove the downloaded runtime? Your sign-in and chats are kept.
            </Text>
            <Button
              size="small"
              variant="destructive"
              disabled={acting}
              onClick={() =>
                void run(async () => {
                  await harnessApi.remove(providerId);
                  setConfirmRemove(false);
                }, `Couldn't remove the ${label} runtime.`)
              }
            >
              Remove
            </Button>
            <Button ref={keepRef} size="small" variant="muted" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="small"
              variant="muted"
              disabled={status.busy || acting}
              aria-describedby={status.busy ? busyReasonId : undefined}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 /> Remove runtime
            </Button>
            {/* A disabled button shows no tooltip, so the reason stays visible. */}
            {status.busy ? (
              <Text id={busyReasonId} variant="small" color="tertiary">
                {`Stop running ${label} chats first.`}
              </Text>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
