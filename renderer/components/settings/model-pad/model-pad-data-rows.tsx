import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { AlertDialog, Badge, Button, Callout, Field, FieldSet, Input, Text, toast } from "../../ui";
import { modelInsightsApi } from "../../../lib/ipc";
import {
  beginModelInsightsAction,
  commitModelInsightsState,
  clearModelPaceSummaries,
  refreshModelInsightsState,
  useModelInsightsStatus,
} from "../../../lib/queries";
import { BENCHMARK_STALE_DAYS, isOlderThanDays } from "../../../lib/model-details";
import type { BenchmarkCoverage } from "../../../lib/model-picker-data";
import { MODEL_PAD_METRIC_LABELS, type ModelPadMetric } from "../../../lib/model-pad-layout";

type ModelInsightsOperation = "connect" | "refresh" | "disconnect";

const MODEL_INSIGHTS_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function modelInsightsDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? MODEL_INSIGHTS_DATE_FORMATTER.format(date) : null;
}

function ModelPadBenchmarkConnection() {
  const queryClient = useQueryClient();
  const statusQuery = useModelInsightsStatus();
  const [keyDraft, setKeyDraft] = React.useState("");
  const [operation, setOperation] = React.useState<ModelInsightsOperation | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const keyInputRef = React.useRef<HTMLInputElement | null>(null);
  const disconnectButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const status = statusQuery.data;
  const busy = operation !== null;
  const fetchedAt = modelInsightsDate(status?.fetchedAt);

  const reconcileAfterFailure = React.useCallback(async () => {
    await refreshModelInsightsState(queryClient).catch(() => undefined);
  }, [queryClient]);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!key || busy) return;
    setOperation("connect");
    setError(null);
    try {
      await beginModelInsightsAction(queryClient);
      const result = await modelInsightsApi.connect(key);
      if (!result.ok) {
        await reconcileAfterFailure();
        setError(result.message);
        toast.error(result.message);
        return;
      }
      setKeyDraft("");
      await commitModelInsightsState(queryClient, result.status);
      toast.success("Model Pad benchmark insights are ready.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t connect the Model Pad benchmark key.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setOperation("refresh");
    setError(null);
    try {
      await beginModelInsightsAction(queryClient);
      const result = await modelInsightsApi.refresh();
      if (!result.ok) {
        await reconcileAfterFailure();
        setError(result.message);
        toast.error(result.message);
        return;
      }
      await commitModelInsightsState(queryClient, result.status);
      toast.success("Latest Model Pad benchmark insights are cached.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t fetch the latest Model Pad benchmark insights.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setOperation("disconnect");
    setError(null);
    try {
      await beginModelInsightsAction(queryClient);
      const result = await modelInsightsApi.disconnect();
      if (!result.ok) {
        await reconcileAfterFailure();
        setConfirmDisconnect(false);
        setError(result.message);
        toast.error(result.message);
        return;
      }
      setKeyDraft("");
      await commitModelInsightsState(queryClient, result.status);
      setConfirmDisconnect(false);
      toast.success("Model Pad OpenRouter key and benchmark cache removed.");
    } catch {
      await reconcileAfterFailure();
      setConfirmDisconnect(false);
      const message = "Aiden couldn’t remove the Model Pad OpenRouter connection.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  return (
    <>
      <Field
        label="OpenRouter key for Model Pad"
        description="Optional. Connect a dedicated key to fetch source-aware benchmark scores; later updates happen only when you choose Fetch latest."
        orientation="vertical"
      >
        <Callout
          aria-live="polite"
          role={statusQuery.isError || error ? "alert" : undefined}
          color={statusQuery.isError || error ? "red" : undefined}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 basis-72 items-start gap-2.5">
              {busy ? (
                <Loader2
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 animate-spin text-tertiary"
                />
              ) : status?.ready ? (
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green" />
              ) : statusQuery.isError ? (
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red" />
              ) : (
                <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-tertiary" />
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Text variant="small-strong">
                    {status?.ready
                      ? "Benchmark insights ready"
                      : status?.hasKey
                        ? "Key connected"
                        : statusQuery.isLoading
                          ? "Checking"
                          : "Not connected"}
                  </Text>
                  {status?.ready ? <Badge>{`${status.cachedModelCount} model${status.cachedModelCount === 1 ? "" : "s"}`}</Badge> : null}
                  {status?.license ? <Badge>{status.license}</Badge> : null}
                </div>
                <Text as="p" variant="small" color="secondary" className="mt-1">
                  {error ??
                    (statusQuery.isError
                      ? "Aiden couldn’t read the local Model Pad connection."
                      : status?.ready
                        ? `Artificial Analysis scores via OpenRouter${fetchedAt ? ` · Fetched ${fetchedAt}` : ""}.`
                        : status?.hasKey
                          ? "The key is stored securely; fetch when you want a new benchmark snapshot."
                          : "Paste a key below to validate it and fetch the first benchmark snapshot.")}
                </Text>
                {!error && status?.ready && isOlderThanDays(status.fetchedAt, BENCHMARK_STALE_DAYS) ? (
                  <Text as="p" variant="small" color="secondary" className="mt-1">
                    {`Benchmarks are over ${BENCHMARK_STALE_DAYS} days old. Fetch latest to update.`}
                  </Text>
                ) : null}
              </div>
            </div>
            {status?.hasKey ? (
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                <Button size="small" onClick={() => void refresh()} disabled={busy}>
                  {operation === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {operation === "refresh" ? "Fetching…" : "Fetch latest"}
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

        <div className="mt-3 rounded-control bg-background/35 px-3 py-2.5">
          <Text as="p" variant="small-strong">
            Benchmark-only connection
          </Text>
          <Text as="p" variant="small" color="secondary" className="mt-1 text-pretty">
            This key is separate from OpenRouter chat providers. It does not enable inference and
            will not add OpenRouter’s 500+ models to your model list. Aiden sends it only to the
            fixed OpenRouter benchmark endpoint when you choose Connect &amp; fetch or Fetch latest.
          </Text>
        </div>

        <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => void connect(event)}>
          <Input
            ref={keyInputRef}
            className="min-w-0 flex-1 basis-72"
            type="password"
            value={keyDraft}
            onChange={(event) => {
              setKeyDraft(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder={status?.hasKey ? "Paste a replacement OpenRouter key" : "sk-or-v1-…"}
            aria-label={
              status?.hasKey
                ? "Replacement OpenRouter API key for Model Pad"
                : "OpenRouter API key for Model Pad"
            }
            aria-invalid={Boolean(error)}
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

        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <Text as="p" variant="small" color="secondary" className="min-w-0 flex-1 basis-72">
            Stored with operating-system secure encryption; normalized public scores stay in Aiden’s local
            offline cache. Create or manage keys in{" "}
            <a
              href="https://openrouter.ai/settings/keys"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline decoration-separator underline-offset-2 hover:text-secondary"
            >
              OpenRouter API Keys
              <ExternalLink aria-hidden="true" className="ml-1 inline size-3" />
            </a>
            .
          </Text>
          <div className="flex flex-wrap justify-end gap-2">
            <Badge>Separate key</Badge>
            <Badge>Manual fetch</Badge>
            <Badge>Offline cache</Badge>
          </div>
        </div>
      </Field>

      <AlertDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Model Pad from OpenRouter?"
        description="Aiden will remove the dedicated encrypted key and cached benchmark data from this device. Your providers, model list, and saved Model Pad positions will not change."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        busy={operation === "disconnect"}
        keepOpenOnConfirm
        returnFocus={() => {
          const button = disconnectButtonRef.current;
          return button?.isConnected ? button : keyInputRef.current;
        }}
        onConfirm={disconnect}
      />
    </>
  );
}


/** How much of the Pad and the visible models the cached benchmark snapshot covers. */
function ModelPadBenchmarkCoverage({
  coverage,
  matchedWithoutMetric,
  metric,
  skippedAmbiguousCount,
}: {
  coverage: BenchmarkCoverage;
  matchedWithoutMetric: number;
  metric: ModelPadMetric;
  skippedAmbiguousCount: number;
}) {
  return (
    <Field label="Benchmark coverage" orientation="vertical">
      <ul className="grid gap-0.5 text-small text-secondary">
        <li>
          {coverage.pad.total === 0
            ? "No models on the Pad yet"
            : `${coverage.pad.matched} of ${coverage.pad.total} Pad model${coverage.pad.total === 1 ? "" : "s"} matched`}
        </li>
        <li>{`${coverage.visible.matched} of ${coverage.visible.total} visible model${coverage.visible.total === 1 ? "" : "s"}`}</li>
        {matchedWithoutMetric > 0 ? (
          <li>
            {`${matchedWithoutMetric} matched visible model${matchedWithoutMetric === 1 ? "" : "s"} ${matchedWithoutMetric === 1 ? "has" : "have"} no ${MODEL_PAD_METRIC_LABELS[metric]} score`}
          </li>
        ) : null}
        {skippedAmbiguousCount > 0 ? (
          <li>
            {`${skippedAmbiguousCount} ambiguous benchmark row${skippedAmbiguousCount === 1 ? "" : "s"} skipped`}
          </li>
        ) : null}
      </ul>
      {coverage.unmatchedPad.length > 0 ? (
        <details className="model-pad-coverage-details -mx-2">
          <summary className="cursor-default list-none rounded-control px-2 py-1.5 text-small text-secondary outline-none hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">
            {`Unmatched Pad models (${coverage.unmatchedPad.length})`}
          </summary>
          <div className="grid gap-1.5 px-2 pb-1 pt-1">
            <Text as="p" variant="small" color="tertiary">
              Benchmarks cover hosted models; reasoning variants are matched separately.
            </Text>
            <ul className="grid gap-1 text-small">
              {coverage.unmatchedPad.map((model) => (
                <li key={model.value} className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-primary">
                    {`${model.label} · ${model.providerLabel}`}
                  </span>
                  <span className="shrink-0 text-tertiary">
                    {model.reason === "local" ? "Local model" : "No benchmark row"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </Field>
  );
}

/** Forget the speeds measured from the user's chats, after a confirmation. */
function ModelPadMeasuredSpeed({
  measuredCount,
  fallbackFocus,
}: {
  measuredCount: number;
  fallbackFocus: () => HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const clearButtonRef = React.useRef<HTMLButtonElement | null>(null);

  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await clearModelPaceSummaries(queryClient);
      toast.success("Measured speeds cleared.");
    } catch {
      toast.error("Aiden couldn’t clear measured speeds.");
    } finally {
      setConfirmClear(false);
      setClearing(false);
    }
  };

  return (
    <Field
      label="Measured speed"
      description={
        measuredCount > 0
          ? `${measuredCount} model${measuredCount === 1 ? "" : "s"} · from your chats on this Mac`
          : "Nothing measured yet"
      }
    >
      <div className="flex justify-end">
        {measuredCount > 0 ? (
          <Button
            ref={clearButtonRef}
            size="small"
            variant="transparent"
            onClick={() => setConfirmClear(true)}
          >
            Clear measured speeds
          </Button>
        ) : null}
      </div>
      <AlertDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear measured speeds?"
        description="Aiden will forget the response speeds it measured from your chats on this Mac. Models stay where they are on your Pad."
        confirmLabel="Clear speeds"
        confirmVariant="destructive"
        busy={clearing}
        keepOpenOnConfirm
        returnFocus={() => {
          const button = clearButtonRef.current;
          return button?.isConnected ? button : fallbackFocus();
        }}
        onConfirm={clear}
      />
    </Field>
  );
}

/**
 * The Data group under the Pad: the benchmark connection and its coverage,
 * and the speeds measured from the user's chats.
 */
export function ModelPadDataRows({
  coverage,
  matchedWithoutMetric,
  metric,
  measuredCount,
  fallbackFocus,
}: {
  /** Shown once insights are ready and every model has loaded. */
  coverage?: BenchmarkCoverage;
  matchedWithoutMetric: number;
  metric: ModelPadMetric;
  measuredCount: number;
  fallbackFocus: () => HTMLElement | null;
}) {
  const status = useModelInsightsStatus().data;
  return (
    <FieldSet title="Data">
      <ModelPadBenchmarkConnection />
      {coverage ? (
        <ModelPadBenchmarkCoverage
          coverage={coverage}
          matchedWithoutMetric={matchedWithoutMetric}
          metric={metric}
          skippedAmbiguousCount={status?.skippedAmbiguousCount ?? 0}
        />
      ) : null}
      <ModelPadMeasuredSpeed measuredCount={measuredCount} fallbackFocus={fallbackFocus} />
    </FieldSet>
  );
}
