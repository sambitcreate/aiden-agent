import { EmptyState, Text } from "../ui";
import { buildTokenMix } from "../../lib/usage-profile-data";
import type { UsageTokenBreakdown } from "../../lib/types";

const MIX_COLORS = ["bg-accent", "bg-accent/70", "bg-accent/45", "bg-accent/25"] as const;

function compactNumber(value: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function TokenMix({ tokens }: { tokens: UsageTokenBreakdown }) {
  const items = buildTokenMix(tokens);
  const representedTotal = items.reduce((total, item) => total + item.value, 0);

  return (
    <section aria-labelledby="token-mix-heading" className="min-w-0 py-6 usage-profile-token-mix">
      <div className="mb-4">
        <Text id="token-mix-heading" as="h2" className="text-large-strong font-medium">
          Token mix
        </Text>
        <Text as="p" variant="small" color="secondary" className="mt-0.5">
          Provider-reported tokens only.
        </Text>
      </div>

      {representedTotal === 0 ? (
        <EmptyState
          placement="inline"
          title="No reported tokens yet"
          description="Local and unsupported models still appear in requests and activity."
          className="items-start px-0 text-left"
        />
      ) : (
        <>
          <div
            className="mb-5 flex h-2 overflow-hidden rounded-pill bg-control/50"
            aria-hidden="true"
          >
            {items.map((item, index) => (
              <span
                key={item.key}
                className={MIX_COLORS[index]}
                style={{ width: `${(item.value / representedTotal) * 100}%` }}
              />
            ))}
          </div>
          <div className="space-y-4">
            {items.map((item, index) => {
              const percentage = (item.value / representedTotal) * 100;
              return (
                <div key={item.key}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-4">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`size-2 shrink-0 rounded-full ${MIX_COLORS[index]}`}
                      />
                      <Text truncate>{item.label}</Text>
                    </span>
                    <Text variant="small" color="secondary" className="shrink-0 tabular-nums">
                      {compactNumber(item.value)} · {percentage.toFixed(1)}%
                    </Text>
                  </div>
                  <div
                    aria-hidden="true"
                    className="h-1 overflow-hidden rounded-pill bg-control/55"
                  >
                    <div
                      className={`h-full rounded-pill ${MIX_COLORS[index]}`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {tokens.reasoning > 0 ? (
            <Text as="p" variant="small" color="tertiary" className="mt-5">
              {compactNumber(tokens.reasoning)} reasoning tokens are included in Output.
            </Text>
          ) : null}
        </>
      )}
    </section>
  );
}
