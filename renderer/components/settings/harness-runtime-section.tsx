import * as React from "react";

import { Download, Loader2, RefreshCw, Trash2 } from "lucide-react";

import { Button, Text, toast } from "../ui";
import { harnessApi } from "../../lib/ipc";
import {
  formatHarnessBytes,
  harnessRuntimeSummary,
  type AcpHarnessStatus,
} from "../../shared/acp-harness";

export interface HarnessStatusState {
  status: AcpHarnessStatus | null;
  /** Why the last status read failed, while there is no status to show. */
  error: string | null;
  retry: () => void;
}

/** Live runtime status for one agent-backed provider. */
export function useHarnessStatus(providerId: string | undefined): HarnessStatusState {
  const [status, setStatus] = React.useState<AcpHarnessStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!providerId) return undefined;
    let active = true;
    const unsubscribe = harnessApi.onChanged((next) => {
      if (active && next.providerId === providerId) {
        setStatus(next);
        setError(null);
      }
    });
    void harnessApi
      .status(providerId)
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error && reason.message ? reason.message : "Aiden couldn't read the runtime status.");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [providerId, attempt]);
  const retry = React.useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);
  return { status, error, retry };
}

function percent(status: AcpHarnessStatus["runtime"]): number | null {
  if (status.status !== "installing" || status.phase !== "downloading" || !status.totalBytes) return null;
  return Math.min(100, Math.floor(((status.receivedBytes ?? 0) / status.totalBytes) * 100));
}

export type RuntimeFocusTarget = "keep" | "cancel" | "install" | "remove" | "section";

/**
 * Where focus belongs once the control the user was on unmounts: each install,
 * cancel or remove swaps the visible actions, which would otherwise drop focus
 * to the page body in the middle of the dialog.
 */
export function runtimeFocusTarget(
  runtime: AcpHarnessStatus["runtime"],
  confirmRemove: boolean,
): RuntimeFocusTarget {
  switch (runtime.status) {
    case "installing":
      return "cancel";
    case "not_installed":
    case "failed":
    case "update_available":
      return "install";
    case "installed":
      return confirmRemove ? "keep" : "remove";
    case "unsupported":
      return "section";
  }
}

export interface HarnessRuntimeSectionProps {
  providerId: string;
  label: string;
  status: AcpHarnessStatus | null;
  /** The status read failed; shown with a retry instead of an endless "Checking…". */
  loadError?: string | null;
  onRetry?: () => void;
}

/**
 * Install, update and remove a provider's managed runtime. Nothing is
 * downloaded until the user chooses Install; the size and source are stated
 * before that choice.
 */
export function HarnessRuntimeSection({ providerId, label, status, loadError, onRetry }: HarnessRuntimeSectionProps) {
  const [acting, setActing] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const sectionRef = React.useRef<HTMLDivElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const installRef = React.useRef<HTMLButtonElement>(null);
  const removeRef = React.useRef<HTMLButtonElement>(null);
  const keepRef = React.useRef<HTMLButtonElement>(null);
  // True while the user's focus is somewhere in this section.
  const focusedInsideRef = React.useRef(false);
  const wasConfirmingRef = React.useRef(false);
  const busyReasonId = React.useId();
  const runtimeStatus = status?.runtime.status;

  React.useEffect(() => {
    const section = sectionRef.current;
    if (!status || !section) return;
    const active = section.ownerDocument.activeElement;
    const openedConfirm = confirmRemove && !wasConfirmingRef.current;
    wasConfirmingRef.current = confirmRemove;
    // Opening the confirmation moves to Keep. Otherwise recover only focus that
    // was in this section and fell to the page (or was parked on the section)
    // when its control unmounted or was disabled.
    const lost =
      focusedInsideRef.current && (!active || active === section.ownerDocument.body || active === section);
    if (!openedConfirm && !lost) return;
    const target = runtimeFocusTarget(status.runtime, confirmRemove);
    const element = {
      keep: keepRef.current,
      cancel: cancelRef.current,
      install: installRef.current,
      remove: removeRef.current,
      section,
    }[target];
    (element && !(element instanceof HTMLButtonElement && element.disabled) ? element : section).focus();
    // Re-run only when the visible actions change, not on download progress.
  }, [runtimeStatus, confirmRemove, acting]);

  React.useEffect(() => {
    if (!confirmRemove) return undefined;
    const section = sectionRef.current;
    // Escape backs out of the inline confirmation before it can close the dialog.
    // The dialog listens on the document in the capture phase, so this listens on the window first.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node) || !section?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setConfirmRemove(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirmRemove]);

  if (!status && loadError) {
    return (
      <div className="grid gap-2" role="group" aria-label={`${label} runtime`}>
        <Text variant="small-strong">Runtime</Text>
        <Text variant="small" color="secondary" role="alert">
          {`Couldn't check the ${label} runtime. ${loadError}`}
        </Text>
        {onRetry ? (
          <Button size="small" variant="filled" className="justify-self-start" onClick={onRetry}>
            <RefreshCw /> Try again
          </Button>
        ) : null}
      </div>
    );
  }
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
    <div
      ref={sectionRef}
      className="grid gap-2 outline-none"
      role="group"
      aria-label={`${label} runtime`}
      tabIndex={-1}
      onFocus={() => {
        focusedInsideRef.current = true;
      }}
      onBlur={(event) => {
        // Unmounting the focused control blurs with no next target; that focus is still ours to place.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          focusedInsideRef.current = false;
        }
      }}
    >
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
            ref={cancelRef}
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
          ref={installRef}
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
              ref={removeRef}
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
