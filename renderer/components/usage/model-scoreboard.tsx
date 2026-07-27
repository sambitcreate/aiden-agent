import * as React from "react";
import {
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
} from "../ui";
import {
  formatTrackedUsd,
  rankUsageModels,
  usageModelScore,
  type UsageScoreMetric,
} from "../../lib/usage-profile-data";
import type { UsageModelSummary } from "../../lib/types";
import { ProviderIcon } from "../provider-icon";

function compactNumber(value: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function modelScoreLabel(model: UsageModelSummary, metric: UsageScoreMetric): string {
  if (metric === "requests") return `${model.requests.toLocaleString()} requests`;
  if (metric === "tokens") {
    if (model.tokens.total > 0) return `${compactNumber(model.tokens.total)} tokens`;
    return model.unmeteredRequests > 0 ? "Unmetered" : "0 tokens";
  }
  return formatTrackedUsd(model.hostedCostUsd);
}

export function ModelScoreboard({ models }: { models: UsageModelSummary[] }) {
  const [metric, setMetric] = React.useState<UsageScoreMetric>("requests");
  const ranked = React.useMemo(() => rankUsageModels(models, metric), [metric, models]);
  const visible = ranked.slice(0, 10);
  const maximum = Math.max(0, ...visible.map((model) => usageModelScore(model, metric)));

  return (
    <section
      aria-labelledby="model-scoreboard-heading"
      className="min-w-0 py-6 usage-profile-scoreboard"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <Text id="model-scoreboard-heading" as="h2" className="text-large-strong font-medium">
            Top models
          </Text>
          <Text as="p" variant="small" color="secondary" className="mt-0.5">
            Private rankings from this Mac.
          </Text>
        </div>
        <Select value={metric} onValueChange={(value) => setMetric(value as UsageScoreMetric)}>
          <SelectTrigger size="small" aria-label="Rank models by" className="w-[108px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="requests">Requests</SelectItem>
            <SelectItem value="tokens">Tokens</SelectItem>
            <SelectItem value="cost">Cost</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          placement="inline"
          title={metric === "cost" ? "No tracked model costs" : "No model calls yet"}
          description={
            metric === "cost"
              ? "Local and unpriced calls are not ranked by cost."
              : "Your private rankings will begin with the next request."
          }
          className="items-start px-0 text-left"
        />
      ) : (
        <ol className="space-y-4">
          {visible.map((model, index) => {
            const score = usageModelScore(model, metric);
            const width = maximum > 0 ? (score / maximum) * 100 : 0;
            return (
              <li
                key={`${model.providerId}\u0000${model.modelId}`}
                className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5"
              >
                <Text
                  aria-hidden="true"
                  color="tertiary"
                  className="pt-0.5 text-right tabular-nums"
                >
                  {index + 1}
                </Text>
                <div className="flex min-w-0 items-start gap-2">
                  <ProviderIcon
                    providerId={model.providerId}
                    providerLabel={model.providerLabel}
                    modelId={model.modelId}
                    className="mt-0.5 size-4 text-tertiary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Text as="div" truncate className="font-medium">
                          {model.modelLabel}
                        </Text>
                        <Text as="div" variant="small" color="tertiary" truncate>
                          {model.providerLabel}
                          {model.local ? " · Local" : " · Hosted"}
                        </Text>
                      </div>
                      <Text
                        variant="small"
                        color="secondary"
                        className="shrink-0 pt-0.5 tabular-nums"
                      >
                        {modelScoreLabel(model, metric)}
                      </Text>
                    </div>
                    <div
                      aria-hidden="true"
                      className="mt-2 h-1 overflow-hidden rounded-pill bg-control/55"
                    >
                      <div
                        className="h-full rounded-pill bg-accent/70"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {ranked.length > visible.length ? (
        <Text as="p" variant="small" color="tertiary" className="mt-4 pl-[30px]">
          Showing 10 of {ranked.length.toLocaleString()} models
        </Text>
      ) : null}
    </section>
  );
}
