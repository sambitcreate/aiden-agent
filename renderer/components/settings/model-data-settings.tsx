import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { AlertDialog, Badge, Button, Callout, Field, FieldSet, Input, Text, toast } from "../ui";
import { artificialAnalysisApi } from "../../lib/ipc";
import {
  ARTIFICIAL_ANALYSIS_ATTRIBUTION_URL,
  ARTIFICIAL_ANALYSIS_KEY_MANAGEMENT_URL,
  isArtificialAnalysisKeyError,
  resolveModelPadGate,
} from "../../lib/model-data-control";
import {
  beginArtificialAnalysisAction,
  commitArtificialAnalysisState,
  refreshArtificialAnalysisState,
  useArtificialAnalysisStatus,
} from "../../lib/queries";
import type { ArtificialAnalysisStatus } from "../../lib/types";

type Operation = "connect" | "refresh" | "disconnect";

function formattedDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function ModelDataSettings() {
  const queryClient = useQueryClient();
  const statusQuery = useArtificialAnalysisStatus();
  const [keyDraft, setKeyDraft] = React.useState("");
  const [operation, setOperation] = React.useState<Operation | null>(null);
  const [keyError, setKeyError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const keyInputRef = React.useRef<HTMLInputElement | null>(null);
  const disconnectButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const status = statusQuery.data;
  const gate = resolveModelPadGate(status, {
    loading: statusQuery.isLoading,
    failed: statusQuery.isError,
  });
  const fetchedAt = formattedDate(status?.fetchedAt);
  const busy = operation !== null;
  const error = keyError ?? actionError;

  const reconcileAfterFailure = React.useCallback(async () => {
    try {
      await refreshArtificialAnalysisState(queryClient);
    } catch {
      // The helper purges model info and leaves the local status query failed/locked.
    }
  }, [queryClient]);

  const commitStatus = React.useCallback(
    (next: ArtificialAnalysisStatus) => commitArtificialAnalysisState(queryClient, next),
    [queryClient],
  );

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!key || busy) return;
    setOperation("connect");
    setKeyError(null);
    setActionError(null);
    try {
      await beginArtificialAnalysisAction(queryClient);
      const result = await artificialAnalysisApi.connect(key);
      if (!result.ok) {
        await reconcileAfterFailure();
        if (isArtificialAnalysisKeyError(result.code)) setKeyError(result.message);
        else setActionError(result.message);
        toast.error(result.message);
        return;
      }
      setKeyDraft("");
      await commitStatus(result.status);
      toast.success("Artificial Analysis is connected. Model data is cached on this Mac.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t connect to Artificial Analysis. Try again.";
      setActionError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setOperation("refresh");
    setKeyError(null);
    setActionError(null);
    try {
      await beginArtificialAnalysisAction(queryClient);
      const result = await artificialAnalysisApi.refresh();
      if (!result.ok) {
        await reconcileAfterFailure();
        setActionError(result.message);
        toast.error(result.message);
        return;
      }
      await commitStatus(result.status);
      toast.success("Latest Artificial Analysis model data is cached.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t fetch the latest model data. Try again.";
      setActionError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setOperation("disconnect");
    setKeyError(null);
    setActionError(null);
    try {
      await beginArtificialAnalysisAction(queryClient);
      const result = await artificialAnalysisApi.disconnect();
      if (!result.ok) {
        await reconcileAfterFailure();
        setActionError(result.message);
        setConfirmDisconnect(false);
        toast.error(result.message);
        return;
      }
      setKeyDraft("");
      await commitStatus(result.status);
      setConfirmDisconnect(false);
      toast.success("Artificial Analysis disconnected. Model Pad is locked.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t remove the Artificial Analysis connection.";
      setActionError(message);
      setConfirmDisconnect(false);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const statusIcon = statusQuery.isError || status?.cleanupNeeded
    ? TriangleAlert
    : gate.unlocked
      ? CheckCircle2
      : statusQuery.isLoading
        ? Loader2
        : KeyRound;
  const StatusIcon = statusIcon;
  const statusLabel = statusQuery.isError
    ? "Check failed"
    : gate.unlocked
      ? "Ready"
      : status?.cleanupNeeded
        ? "Cleanup needed"
        : status?.hasKey
          ? "Connected"
          : statusQuery.isLoading
            ? "Checking"
            : "Not connected";

  return (
    <>
      <FieldSet title="Model data">
        <Field
          label="Model Pad"
          description="Artificial Analysis rankings place supported cloud models by capability and response time."
          orientation="vertical"
        >
          <Callout
            aria-live="polite"
            role={statusQuery.isError || error ? "alert" : undefined}
            color={statusQuery.isError || error ? "red" : undefined}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 basis-72 items-start gap-2.5">
                <StatusIcon
                  aria-hidden="true"
                  className={`mt-0.5 size-4 shrink-0 ${statusQuery.isLoading ? "animate-spin" : gate.unlocked ? "text-green" : statusQuery.isError || status?.cleanupNeeded ? "text-red" : "text-tertiary"}`}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Text variant="small-strong">{statusLabel}</Text>
                    {status?.tier ? <Badge>{status.tier} tier</Badge> : null}
                    {gate.unlocked ? (
                      <Badge className="gap-1 text-primary">
                        <CheckCircle2 aria-hidden="true" className="size-3 text-green" />
                        Offline cache ready
                      </Badge>
                    ) : null}
                  </div>
                  <Text as="p" variant="small" color="secondary" className="mt-1">
                    {error ??
                      (statusQuery.isError
                        ? "Aiden couldn’t read the local Artificial Analysis connection."
                        : gate.detail)}
                  </Text>
                  {gate.unlocked && status ? (
                    <Text as="p" variant="small" color="secondary" className="mt-1">
                      {status.cachedModelCount} models cached · {status.rankedModelCount} ranked
                      {fetchedAt ? ` · Fetched ${fetchedAt}` : ""}
                    </Text>
                  ) : null}
                </div>
              </div>

              {statusQuery.isError ? (
                <Button
                  size="small"
                  variant="transparent"
                  onClick={() => void statusQuery.refetch()}
                  disabled={statusQuery.isFetching || busy}
                >
                  <RefreshCw className={statusQuery.isFetching ? "animate-spin" : undefined} />
                  Try again
                </Button>
              ) : status?.cleanupNeeded ? (
                <Button
                  ref={disconnectButtonRef}
                  size="small"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy}
                >
                  Finish disconnect
                </Button>
              ) : status?.hasKey ? (
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Button size="small" onClick={() => void refresh()} disabled={busy}>
                    {operation === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    {operation === "refresh"
                      ? "Fetching…"
                      : status.ready
                        ? "Fetch latest"
                        : "Fetch model data"}
                  </Button>
                  <Button
                    ref={disconnectButtonRef}
                    size="small"
                    variant="transparent"
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={busy}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : null}
            </div>
          </Callout>
        </Field>

        <Field
          label={status?.hasKey ? "Replace API key" : "Connect Artificial Analysis"}
          description="Bring your own key. Connecting validates it and fetches the first local snapshot; later updates happen only when you press Fetch latest."
          orientation="vertical"
        >
          <ol className="mb-3 grid gap-2 text-small text-secondary">
            <li className="flex items-start gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-control text-[11px] font-medium text-primary">
                1
              </span>
              <span>
                Open{" "}
                <a
                  href={ARTIFICIAL_ANALYSIS_KEY_MANAGEMENT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline decoration-separator underline-offset-2 hover:text-secondary"
                >
                  Artificial Analysis API key management
                  <ExternalLink className="ml-1 inline size-3" />
                </a>
                .
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-control text-[11px] font-medium text-primary">
                2
              </span>
              <span>
                Create or copy an API key. A Free key works with Aiden’s model-list endpoint.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-control text-[11px] font-medium text-primary">
                3
              </span>
              <span>Paste the key below, then connect and fetch the snapshot.</span>
            </li>
          </ol>

          <form className="flex flex-wrap gap-2" onSubmit={(event) => void connect(event)}>
            <Input
              ref={keyInputRef}
              className="min-w-0 flex-1 basis-72"
              type="password"
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value);
                setKeyError(null);
                setActionError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder={status?.hasKey ? "Paste a new API key" : "Paste your API key"}
              aria-label={
                status?.hasKey
                  ? "Replacement Artificial Analysis API key"
                  : "Artificial Analysis API key"
              }
              aria-invalid={Boolean(keyError)}
              disabled={busy}
            />
            <Button type="submit" size="medium" disabled={!keyDraft.trim() || busy}>
              {operation === "connect" ? <Loader2 className="animate-spin" /> : <KeyRound />}
              {operation === "connect"
                ? "Connecting…"
                : status?.hasKey
                  ? "Replace & fetch"
                  : "Connect & fetch"}
            </Button>
          </form>
        </Field>
      </FieldSet>

      <FieldSet title="Privacy and updates">
        <div className="flex flex-wrap items-start gap-4 p-4">
          <Text
            as="p"
            variant="small"
            color="secondary"
            className="min-w-0 flex-1 basis-80 text-pretty"
          >
            Aiden stores the key encrypted on this Mac and sends it only to Artificial Analysis when
            you choose Connect & fetch or Fetch latest. Normalized model data stays in Aiden’s local
            cache for offline use; model reads never trigger a network request. Data by{" "}
            <a
              href={ARTIFICIAL_ANALYSIS_ATTRIBUTION_URL}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline decoration-separator underline-offset-2 hover:text-secondary"
            >
              Artificial Analysis
            </a>
            .
          </Text>
          <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-2">
            <Badge className="whitespace-nowrap">Encrypted key</Badge>
            <Badge className="whitespace-nowrap">Manual updates</Badge>
            <Badge className="whitespace-nowrap">Offline cache</Badge>
          </div>
        </div>
      </FieldSet>

      <AlertDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={status?.cleanupNeeded ? "Finish disconnecting Artificial Analysis?" : "Disconnect Artificial Analysis?"}
        description={
          status?.cleanupNeeded
            ? "Aiden will retry removing the remaining cached model data from this Mac."
            : "Aiden will remove the encrypted API key and cached model data from this Mac. Model Pad will lock until you connect again."
        }
        confirmLabel={status?.cleanupNeeded ? "Finish disconnect" : "Disconnect"}
        confirmVariant="destructive"
        busy={operation === "disconnect"}
        keepOpenOnConfirm
        returnFocus={() => {
          const disconnectButton = disconnectButtonRef.current;
          return disconnectButton?.isConnected ? disconnectButton : keyInputRef.current;
        }}
        onConfirm={disconnect}
      />
    </>
  );
}
