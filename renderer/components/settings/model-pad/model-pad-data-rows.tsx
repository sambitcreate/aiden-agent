import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FieldSet,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Text,
  toast,
} from "../../ui";
import { InfoHint } from "../../ui-info-hint";
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
import { cn } from "../../../lib/ui-utils";

type ModelInsightsOperation = "connect" | "refresh" | "disconnect";
/** Which key row is showing under the benchmark row, if any. */
type KeyRowMode = "connect" | "replace";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";

const FETCHED_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function fetchedDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? FETCHED_DATE_FORMATTER.format(date) : null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/**
 * One row of the Data card: a label with its ⓘ, a secondary line, trailing
 * actions, and an optional panel under it (the key row). The group is named by
 * the label alone so the ⓘ button's name stays out of it.
 */
function ModelPadDataRow({
  label,
  hint,
  secondary,
  trailing,
  children,
}: {
  label: string;
  hint: React.ReactNode;
  secondary: React.ReactNode;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const labelId = React.useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="settings-field relative grid gap-3 p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-52">
          <div className="flex items-center gap-1.5">
            <span id={labelId} className="text-strong text-primary">
              {label}
            </span>
            <InfoHint topic={label.toLowerCase()}>{hint}</InfoHint>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small text-secondary">
            {secondary}
          </div>
        </div>
        {trailing ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{trailing}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** What the "<n> of <m> models" button opens: how far the scores reach. */
function ModelPadCoveragePopover({
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
  const { visible, pad, unmatchedPad } = coverage;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="small"
          variant="transparent"
          aria-label={`Benchmark coverage: ${visible.matched} of ${visible.total} ${plural(visible.total, "model")}`}
          className="tabular-nums text-secondary hover:text-primary"
        >
          {`${visible.matched} of ${visible.total} ${plural(visible.total, "model")}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Benchmark coverage"
        className="grid w-[min(20rem,calc(100vw-2rem))] gap-2 px-3 py-2.5 text-small"
      >
        <ul className="grid gap-0.5 text-secondary">
          <li className="text-primary">
            {pad.total === 0
              ? "No models on the Pad yet"
              : `${pad.matched} of ${pad.total} Pad ${plural(pad.total, "model")} matched`}
          </li>
          {matchedWithoutMetric > 0 ? (
            <li>
              {`${matchedWithoutMetric} matched visible ${plural(matchedWithoutMetric, "model")} ${plural(matchedWithoutMetric, "has", "have")} no ${MODEL_PAD_METRIC_LABELS[metric]} score`}
            </li>
          ) : null}
          {skippedAmbiguousCount > 0 ? (
            <li>
              {`${skippedAmbiguousCount} ambiguous benchmark ${plural(skippedAmbiguousCount, "row")} skipped`}
            </li>
          ) : null}
        </ul>
        {unmatchedPad.length > 0 ? (
          <section aria-label="Pad models without a score" className="grid gap-1">
            <Text as="p" variant="small" color="tertiary">
              {`${unmatchedPad.length} on the Pad ${plural(unmatchedPad.length, "has", "have")} no score. Scores cover hosted models; reasoning variants match separately.`}
            </Text>
            <ul className="-mr-1 grid max-h-56 gap-0.5 overflow-y-auto pr-1">
              {unmatchedPad.map((model) => (
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
          </section>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The benchmark scores row: status, coverage, Fetch latest and the ⋯ menu when
 * a key is stored; Connect and an inline key row otherwise. The stored key is
 * never read back into the page.
 */
function ModelPadBenchmarkRow({
  coverage,
  matchedWithoutMetric,
  metric,
  fallbackFocus,
}: {
  coverage?: BenchmarkCoverage;
  matchedWithoutMetric: number;
  metric: ModelPadMetric;
  fallbackFocus: () => HTMLElement | null;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useModelInsightsStatus();
  const status = statusQuery.data;
  const [keyDraft, setKeyDraft] = React.useState("");
  const [keyRow, setKeyRow] = React.useState<KeyRowMode | null>(null);
  const [operation, setOperation] = React.useState<ModelInsightsOperation | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const keyInputRef = React.useRef<HTMLInputElement | null>(null);
  const connectButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const fetchButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = React.useRef<HTMLButtonElement | null>(null);
  // Replace key… closes its menu; the key field takes focus instead of the trigger.
  const focusKeyOnMenuCloseRef = React.useRef(false);
  // What takes focus back once a failed operation re-enables its controls.
  const refocusAfterFailureRef = React.useRef<"key" | "fetch" | null>(null);
  const keyRowId = React.useId();
  const busy = operation !== null;
  const hasKey = Boolean(status?.hasKey);
  const ready = Boolean(status?.ready);
  const stale = ready && isOlderThanDays(status?.fetchedAt, BENCHMARK_STALE_DAYS);
  const fetchedOn = fetchedDate(status?.fetchedAt);

  React.useEffect(() => {
    if (keyRow) keyInputRef.current?.focus();
  }, [keyRow]);

  // The busy controls were disabled, which drops focus; return it once they
  // are enabled again: to the key field to correct the key, or to Fetch latest
  // to try again.
  React.useEffect(() => {
    if (operation !== null) return;
    const target = refocusAfterFailureRef.current;
    refocusAfterFailureRef.current = null;
    if (target === "key") {
      keyInputRef.current?.focus();
    } else if (target === "fetch") {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected || active === fetchButtonRef.current) {
        fetchButtonRef.current?.focus();
      }
    }
  }, [operation]);

  /** Focus the row's main action once it renders, after the focused control left. */
  const focusRowAction = () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const target = [fetchButtonRef.current, connectButtonRef.current].find(
        (element) => element?.isConnected,
      );
      (target ?? fallbackFocus())?.focus();
    }, 0);
  };

  const closeKeyRow = () => {
    setKeyRow(null);
    setKeyDraft("");
    setTimeout(() => {
      const target = [connectButtonRef.current, moreButtonRef.current].find(
        (element) => element?.isConnected,
      );
      (target ?? fallbackFocus())?.focus();
    }, 0);
  };

  const reconcileAfterFailure = React.useCallback(async () => {
    await refreshModelInsightsState(queryClient).catch(() => undefined);
  }, [queryClient]);

  const fail = (message: string) => {
    setError(message);
    toast.error(message);
  };

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
        refocusAfterFailureRef.current = "key";
        fail(result.message);
        return;
      }
      setKeyDraft("");
      setKeyRow(null);
      await commitModelInsightsState(queryClient, result.status);
      toast.success("Benchmark scores are ready.");
      focusRowAction();
    } catch {
      await reconcileAfterFailure();
      refocusAfterFailureRef.current = "key";
      fail("Aiden couldn’t connect the benchmark key.");
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
        refocusAfterFailureRef.current = "fetch";
        fail(result.message);
        return;
      }
      await commitModelInsightsState(queryClient, result.status);
      toast.success("Latest benchmark scores are cached.");
    } catch {
      await reconcileAfterFailure();
      refocusAfterFailureRef.current = "fetch";
      fail("Aiden couldn’t fetch the latest benchmark scores.");
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
        fail(result.message);
        return;
      }
      setKeyDraft("");
      setKeyRow(null);
      await commitModelInsightsState(queryClient, result.status);
      setConfirmDisconnect(false);
      toast.success("Benchmark key and cached scores removed.");
    } catch {
      await reconcileAfterFailure();
      setConfirmDisconnect(false);
      fail("Aiden couldn’t remove the benchmark connection.");
    } finally {
      setOperation(null);
    }
  };

  const secondary: React.ReactNode = error ? (
    <span className="text-status-red">{error}</span>
  ) : statusQuery.isError ? (
    <span className="text-status-red">Aiden couldn’t read the benchmark connection.</span>
  ) : statusQuery.isLoading ? (
    "Checking…"
  ) : ready ? (
    <>
      <span>{`Artificial Analysis via OpenRouter${fetchedOn ? ` · ${fetchedOn}` : ""}`}</span>
      {stale ? (
        <Badge
          color="warning"
          className="h-5 px-1.5 text-mini"
          title={`Fetched over ${BENCHMARK_STALE_DAYS} days ago`}
        >
          Out of date
        </Badge>
      ) : null}
    </>
  ) : hasKey ? (
    "Key saved · no scores fetched yet"
  ) : (
    "Not connected"
  );

  const trailing = hasKey ? (
    <>
      {coverage ? (
        <ModelPadCoveragePopover
          coverage={coverage}
          matchedWithoutMetric={matchedWithoutMetric}
          metric={metric}
          skippedAmbiguousCount={status?.skippedAmbiguousCount ?? 0}
        />
      ) : null}
      <Button
        ref={fetchButtonRef}
        size="small"
        onClick={() => void refresh()}
        disabled={busy}
        aria-busy={operation === "refresh"}
      >
        {operation === "refresh" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        {operation === "refresh" ? "Fetching…" : "Fetch latest"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={moreButtonRef}
            size="small"
            variant="transparent"
            iconOnly
            disabled={busy}
            aria-label="Benchmark connection options"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          onCloseAutoFocus={(event) => {
            if (!focusKeyOnMenuCloseRef.current) return;
            focusKeyOnMenuCloseRef.current = false;
            event.preventDefault();
            keyInputRef.current?.focus();
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              focusKeyOnMenuCloseRef.current = true;
              setError(null);
              setKeyRow("replace");
            }}
          >
            Replace key…
          </DropdownMenuItem>
          <DropdownMenuItem color="status-red" onSelect={() => setConfirmDisconnect(true)}>
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  ) : statusQuery.isLoading ? null : (
    <Button
      ref={connectButtonRef}
      size="small"
      disabled={busy}
      aria-expanded={keyRow === "connect"}
      aria-controls={keyRow === "connect" ? keyRowId : undefined}
      onClick={() => {
        if (keyRow) closeKeyRow();
        else {
          setError(null);
          setKeyRow("connect");
        }
      }}
    >
      Connect
    </Button>
  );

  const replacing = keyRow === "replace";

  return (
    <>
      <ModelPadDataRow
        label="Benchmark scores"
        hint={
          <>
            <p>
              Optional. A separate OpenRouter key fetches public scores only when you choose
              Connect & fetch or Fetch latest. It never sends chats and doesn’t add OpenRouter
              models.
            </p>
            <p>{`Scores: Artificial Analysis, ${status?.license ?? "CC BY 4.0"}.`}</p>
          </>
        }
        secondary={<span aria-live="polite" className="contents">{secondary}</span>}
        trailing={trailing}
      >
        {keyRow ? (
          <form
            id={keyRowId}
            className="flex min-w-0 flex-wrap items-center gap-2"
            onSubmit={(event) => void connect(event)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || busy) return;
              event.preventDefault();
              closeKeyRow();
            }}
          >
            <Input
              ref={keyInputRef}
              className="min-w-0 flex-1 basis-60"
              type="password"
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value);
                setError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="OpenRouter key (sk-or-…)"
              aria-label={
                replacing
                  ? "Replacement OpenRouter key for benchmark scores"
                  : "OpenRouter key for benchmark scores"
              }
              aria-invalid={Boolean(error)}
              disabled={busy}
            />
            <Button
              type="submit"
              size="small"
              variant="accent"
              disabled={!keyDraft.trim() || busy}
            >
              {operation === "connect" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {operation === "connect" ? "Connecting…" : replacing ? "Replace & fetch" : "Connect & fetch"}
            </Button>
            {replacing ? (
              <Button size="small" variant="transparent" disabled={busy} onClick={closeKeyRow}>
                Cancel
              </Button>
            ) : null}
            <a
              href={OPENROUTER_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "inline-flex items-center gap-1 rounded-control px-1 text-small text-secondary underline decoration-separator underline-offset-2 outline-none hover:text-primary",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
              )}
            >
              Get a key
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          </form>
        ) : null}
      </ModelPadDataRow>
      <AlertDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect benchmark scores?"
        description="Aiden removes the benchmark key and cached scores from this Mac. Your providers, model list and Pad stay as they are."
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        busy={operation === "disconnect"}
        keepOpenOnConfirm
        returnFocus={() =>
          [moreButtonRef.current, connectButtonRef.current].find((element) => element?.isConnected) ??
          fallbackFocus()
        }
        onConfirm={disconnect}
      />
    </>
  );
}

/** The measured speed row: how many models have speeds, and Clear… */
function ModelPadMeasuredSpeedRow({
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
    <>
      <ModelPadDataRow
        label="Measured speed"
        hint={
          <>
            <p>Time to first token and tokens per second, taken from real replies. Stays on this Mac.</p>
            <p>A model needs 3 chats before Arrange can use it.</p>
          </>
        }
        secondary={
          measuredCount > 0
            ? `${measuredCount} ${plural(measuredCount, "model")} · from your chats on this Mac`
            : "Nothing measured yet"
        }
        trailing={
          measuredCount > 0 ? (
            <Button
              ref={clearButtonRef}
              size="small"
              variant="transparent"
              aria-label="Clear measured speeds"
              onClick={() => setConfirmClear(true)}
            >
              Clear…
            </Button>
          ) : null
        }
      />
      <AlertDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear measured speeds?"
        description="Aiden forgets the response speeds it measured from your chats on this Mac. Models stay where they are on your Pad."
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
    </>
  );
}

/**
 * The Data group under the Pad: benchmark scores (connection, coverage) and
 * the speeds measured from the user's chats, as two quiet settings rows.
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
  return (
    <FieldSet title="Data">
      <ModelPadBenchmarkRow
        coverage={coverage}
        matchedWithoutMetric={matchedWithoutMetric}
        metric={metric}
        fallbackFocus={fallbackFocus}
      />
      <ModelPadMeasuredSpeedRow measuredCount={measuredCount} fallbackFocus={fallbackFocus} />
    </FieldSet>
  );
}
