// Auto Router settings — candidate model alignment, benchmark connection, and routing preset.
// Conforms strictly to docs/settings-design-system.md.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Field,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  Switch,
  Text,
  toast,
} from "../ui";
import { ProviderIcon } from "../provider-icon";
import { modelInsightsApi, settingsApi } from "../../lib/ipc";
import {
  beginModelInsightsAction,
  commitModelInsightsState,
  queryKeys,
  refreshModelInsightsState,
  useModelInsightsStatus,
  useProviders,
  useProvidersModelInfo,
  useSettings,
} from "../../lib/queries";
import {
  createModelEntries,
  encodeSelection,
  positionSavedModels,
  visibleModelEntries,
} from "../../lib/model-picker-data";
import { useModelPadLayout } from "../../lib/model-pad-layout";
import type { AutoRouterPreset, AutoRouterSettings as AutoRouterConfig, ModelCost, ModelInfo } from "../../lib/types";
import { cn } from "../../lib/ui-utils";

const BENCHMARK_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatBenchmarkDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? BENCHMARK_DATE_FORMATTER.format(date) : null;
}

function formatCostRate(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  return `$${value >= 1 ? value.toFixed(2) : value.toFixed(3)}`;
}

function formatCostSummary(isLocal: boolean, cost: ModelCost | undefined): string {
  if (isLocal) return "Free (Local)";
  if (!cost) return "Standard hosted";
  return `${formatCostRate(cost.input)} in · ${formatCostRate(cost.output)} out / 1M`;
}

const PRESET_OPTIONS: ReadonlyArray<{
  value: AutoRouterPreset;
  title: string;
  description: string;
}> = [
  {
    value: "balanced",
    title: "Balanced",
    description:
      "Dynamically balances coding benchmark scores against cost and pace depending on task importance.",
  },
  {
    value: "cost",
    title: "Cost Saver",
    description:
      "Prioritizes free on-device local models and low-cost hosted models for everyday engineering.",
  },
  {
    value: "capability",
    title: "Max Coding Capability",
    description:
      "Strictly selects top-tier coding models according to Artificial Analysis benchmark scores for all code work.",
  },
];

export function AutoRouterSettings() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const settingsQuery = useSettings();
  const statusQuery = useModelInsightsStatus();
  const providersQuery = useProviders();
  const modelPadLayout = useModelPadLayout();

  const providers = providersQuery.data ?? [];
  const catalog = useProvidersModelInfo(providers);

  const [keyDraft, setKeyDraft] = React.useState("");
  const [operation, setOperation] = React.useState<"connect" | "refresh" | "disconnect" | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [savingPreset, setSavingPreset] = React.useState(false);

  const status = statusQuery.data;
  const busy = operation !== null;
  const fetchedAt = formatBenchmarkDate(status?.fetchedAt);

  const autoRouterSettings: AutoRouterConfig = settingsQuery.data?.autoRouter ?? {
    preset: "balanced",
  };
  const activePreset = autoRouterSettings.preset ?? "balanced";
  const excludedModels = React.useMemo(
    () => new Set(autoRouterSettings.excludedModels ?? []),
    [autoRouterSettings.excludedModels],
  );

  const infoByValue = React.useMemo(() => {
    const result: Record<string, ModelInfo | undefined> = {};
    for (const provider of providers) {
      const data = catalog.data[provider.id];
      for (const modelId of provider.models) {
        result[encodeSelection(provider.id, modelId)] = data?.[modelId];
      }
    }
    return result;
  }, [catalog.data, providers]);

  const allEntries = React.useMemo(
    () => createModelEntries(providers, infoByValue),
    [providers, infoByValue],
  );
  const visibleEntries = React.useMemo(
    () => visibleModelEntries(allEntries, settingsQuery.data?.hiddenModelsByProvider),
    [allEntries, settingsQuery.data?.hiddenModelsByProvider],
  );
  const padModels = React.useMemo(
    () => positionSavedModels(visibleEntries, modelPadLayout.placements),
    [visibleEntries, modelPadLayout.placements],
  );

  const handlePresetChange = async (nextPreset: AutoRouterPreset) => {
    if (savingPreset || nextPreset === activePreset) return;
    setSavingPreset(true);
    try {
      const patch: AutoRouterConfig = {
        ...autoRouterSettings,
        preset: nextPreset,
      };
      await settingsApi.set({ autoRouter: patch });
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toast.success(`Routing strategy updated to ${nextPreset === "cost" ? "Cost Saver" : nextPreset === "capability" ? "Max Coding Capability" : "Balanced"}.`);
    } catch {
      toast.error("Failed to save routing strategy.");
    } finally {
      setSavingPreset(false);
    }
  };

  const handleToggleExclusion = async (modelKey: string, currentlyExcluded: boolean) => {
    try {
      const nextExcluded = new Set(excludedModels);
      if (currentlyExcluded) {
        nextExcluded.delete(modelKey);
      } else {
        nextExcluded.add(modelKey);
      }
      const patch: AutoRouterConfig = {
        ...autoRouterSettings,
        excludedModels: Array.from(nextExcluded),
      };
      await settingsApi.set({ autoRouter: patch });
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    } catch {
      toast.error("Failed to update model exclusion.");
    }
  };

  const reconcileAfterFailure = React.useCallback(async () => {
    await refreshModelInsightsState(queryClient).catch(() => undefined);
  }, [queryClient]);

  const handleConnect = async (event: React.FormEvent) => {
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
      toast.success("OpenRouter benchmark insights connected and cached.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t connect the OpenRouter benchmark key.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const handleRefresh = async () => {
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
      toast.success("Latest benchmark insights are cached.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t fetch the latest benchmark insights.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  const handleDisconnect = async () => {
    if (busy) return;
    setOperation("disconnect");
    setError(null);
    try {
      await beginModelInsightsAction(queryClient);
      const result = await modelInsightsApi.disconnect();
      if (!result.ok) {
        await reconcileAfterFailure();
        setError(result.message);
        toast.error(result.message);
        return;
      }
      setKeyDraft("");
      await commitModelInsightsState(queryClient, result.status);
      toast.success("Benchmark key and cache removed.");
    } catch {
      await reconcileAfterFailure();
      const message = "Aiden couldn’t remove the benchmark key connection.";
      setError(message);
      toast.error(message);
    } finally {
      setOperation(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Strategy Preset Section */}
      <FieldSet title="Optimization strategy">
        <RadioGroup
          orientation="vertical"
          aria-label="Auto Router strategy preset"
          value={activePreset}
          onValueChange={(val) => void handlePresetChange(val as AutoRouterPreset)}
          disabled={savingPreset || settingsQuery.isLoading}
          className="gap-1 p-2"
        >
          {PRESET_OPTIONS.map((option) => {
            const isSelected = activePreset === option.value;
            return (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg p-3 transition-colors hover:bg-control-hover",
                  isSelected && "bg-control",
                )}
              >
                <RadioGroupItem
                  value={option.value}
                  aria-label={option.title}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
                />
                <span className="flex flex-col gap-1">
                  <Text variant="small-strong">{option.title}</Text>
                  <Text as="span" variant="small" color="secondary">
                    {option.description}
                  </Text>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </FieldSet>

      {/* Benchmark Connection Section */}
      <FieldSet title="Artificial Analysis benchmarks via OpenRouter">
        <Field
          label="OpenRouter benchmark data"
          description="Provides normalized Coding, Intelligence, and Agentic indices for candidate models. Inference traffic is never sent to benchmark endpoints."
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
                  <Loader2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin text-tertiary" />
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
                        ? "Benchmark insights connected"
                        : status?.hasKey
                          ? "Key connected"
                          : statusQuery.isLoading
                            ? "Checking connection"
                            : "Benchmark data unconfigured"}
                    </Text>
                    {status?.ready ? <Badge>{status.cachedModelCount} models</Badge> : null}
                    {status?.license ? <Badge>{status.license}</Badge> : null}
                  </div>
                  <Text as="p" variant="small" color="secondary" className="mt-1">
                    {error ??
                      (statusQuery.isError
                        ? "Aiden couldn’t read local benchmark connection state."
                        : status?.ready
                          ? `Artificial Analysis scores via OpenRouter${fetchedAt ? ` · Fetched ${fetchedAt}` : ""}.`
                          : status?.hasKey
                            ? "Key stored securely; fetch latest when you want updated benchmark scores."
                            : "Connect a free OpenRouter key to fetch and cache Artificial Analysis scores for routing.")}
                  </Text>
                </div>
              </div>
              {status?.hasKey ? (
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Button size="small" onClick={() => void handleRefresh()} disabled={busy}>
                    {operation === "refresh" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    {operation === "refresh" ? "Fetching…" : "Fetch latest"}
                  </Button>
                  <Button size="small" variant="transparent" onClick={() => void handleDisconnect()} disabled={busy}>
                    Disconnect
                  </Button>
                </div>
              ) : null}
            </div>
          </Callout>

          {!status?.ready ? (
            <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => void handleConnect(e)}>
              <Input
                className="min-w-0 flex-1 basis-72"
                type="password"
                value={keyDraft}
                onChange={(e) => {
                  setKeyDraft(e.target.value);
                  setError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                placeholder={status?.hasKey ? "Paste a replacement OpenRouter key" : "sk-or-v1-…"}
                aria-label="OpenRouter API key for Model Pad benchmarks"
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
          ) : null}

          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <Text as="p" variant="small" color="secondary" className="min-w-0 flex-1 basis-72">
              Keys are stored with secure macOS encryption. Scores stay strictly on this device. Manage keys in{" "}
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
              <Badge>Isolated key</Badge>
              <Badge>Manual fetch</Badge>
              <Badge>Offline cache</Badge>
            </div>
          </div>
        </Field>
      </FieldSet>

      {/* Model Pad Inventory Section */}
      <FieldSet title="Personal Model Pad inventory">
        {padModels.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <span className="mb-3 flex size-10 items-center justify-center rounded-full bg-control text-secondary shadow-control">
              <SlidersHorizontal className="size-5" />
            </span>
            <Text variant="small-strong" as="h3">
              Your Model Pad is empty
            </Text>
            <Text variant="small" color="secondary" as="p" className="mt-1 max-w-sm text-pretty">
              Auto Router selects candidate models from your Personal Model Pad. Add and position your favorite models to enable dynamic routing.
            </Text>
            <Button
              size="small"
              className="mt-4"
              onClick={() => void navigate({ to: "/settings", search: { section: "modelData" } })}
            >
              Configure Model Pad
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-separator">
            {padModels.map((candidate) => {
              const isExcluded = excludedModels.has(candidate.value);
              const benchmark = candidate.info?.benchmark;
              const hasCodingScore = typeof benchmark?.coding === "number";
              const hasIntellScore = typeof benchmark?.intelligence === "number";
              const hasAgenticScore = typeof benchmark?.agentic === "number";

              return (
                <div
                  key={candidate.value}
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors",
                    isExcluded && "opacity-50",
                  )}
                >
                  <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
                    <ProviderIcon
                      providerId={candidate.providerId}
                      providerLabel={candidate.providerLabel}
                      modelId={candidate.model}
                      artwork={candidate.providerArtwork}
                      className="size-5 shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Text variant="small-strong" truncate>
                          {candidate.label}
                        </Text>
                        <Badge>{candidate.isLocal ? "Local" : "Hosted"}</Badge>
                        <Badge>{candidate.paceLabel}</Badge>
                      </div>
                      <Text as="p" variant="small" color="secondary" className="mt-0.5 truncate">
                        {candidate.providerLabel} · {formatCostSummary(candidate.isLocal, candidate.info?.cost)}
                      </Text>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {hasCodingScore ? (
                      <Badge color="blue">
                        Coding {benchmark.coding!.toFixed(1)}
                      </Badge>
                    ) : (
                      <Badge>Coding: unranked</Badge>
                    )}

                    {hasIntellScore ? (
                      <Badge>
                        Intel {benchmark.intelligence!.toFixed(1)}
                      </Badge>
                    ) : null}

                    {hasAgenticScore ? (
                      <Badge>
                        Agentic {benchmark.agentic!.toFixed(1)}
                      </Badge>
                    ) : null}

                    <div className="ml-2 flex items-center gap-2">
                      <Text variant="small" color="secondary">
                        {isExcluded ? "Excluded" : "Eligible"}
                      </Text>
                      <Switch
                        checked={!isExcluded}
                        onCheckedChange={(checked) =>
                          void handleToggleExclusion(candidate.value, !checked)
                        }
                        aria-label={`Include ${candidate.label} in Auto Router`}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </FieldSet>
    </div>
  );
}
