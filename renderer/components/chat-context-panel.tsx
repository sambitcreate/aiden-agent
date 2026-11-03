import type * as React from "react";
import type { Chat } from "../lib/types";
import { formatContextTokenCount, type ChatContextPressureV1 } from "../shared/context-pressure";
import { parseAssistantTurnStatsV1 } from "../shared/assistant-turn-stats";
import { ContextBreakdown } from "./context-breakdown";
import { ProviderIcon } from "./provider-icon";
import type { ProviderArtwork } from "../shared/provider-artwork";
import { Text } from "./ui";

export interface ChatContextDetails {
  chat: Chat;
  providerId?: string;
  providerLabel: string;
  providerArtwork?: ProviderArtwork;
  modelId?: string;
  modelLabel: string;
  pressure: ChatContextPressureV1 | null;
  compacting: boolean;
}

/** Only retained, reported turn totals; never mix the last Pi response into a turn total. */
export function recordedChatUsage(chat: Pick<Chat, "messages">) {
  const assistants = chat.messages.filter(
    (message) => message.role === "assistant",
  );
  const seen = new Set<string>();
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    requests: 0,
    turns: 0,
  };
  for (const message of assistants) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const usage = parseAssistantTurnStatsV1(message.turnStats)?.usage;
    if (!usage) continue;
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
      "requests",
    ] as const)
      totals[key] += usage[key];
    totals.turns++;
  }
  return {
    ...totals,
    assistantMessages: seen.size,
    userMessages: chat.messages.filter((message) => message.role === "user")
      .length,
  };
}

/** Like formatContextTokenCount, with billions for long sessions' cumulative totals. */
function formatUsageTokens(value: number): string {
  return value >= 999_950_000
    ? `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/u, "")}B`
    : formatContextTokenCount(value);
}

function Chip({ children, icon }: React.PropsWithChildren<{ icon?: React.ReactNode }>) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-control bg-control px-2.5 py-0.5 text-small text-secondary">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

const USAGE_PARTS = [
  { key: "cacheRead", label: "Cache read", fill: "color-mix(in srgb, var(--chart-1) 40%, transparent)" },
  { key: "input", label: "Input (excluding cache)", fill: "var(--chart-1)" },
  { key: "cacheWrite", label: "Cache write", fill: "var(--chart-6)" },
  { key: "output", label: "Output", fill: "var(--chart-5)" },
] as const;

function UsageSection({ usage }: { usage: ReturnType<typeof recordedChatUsage> }) {
  const reported = usage.turns > 0;
  const token = (value: number) => value.toLocaleString();
  const cacheable = usage.cacheRead + usage.cacheWrite + usage.input;
  const cachePercent = reported && usage.cacheRead > 0 && cacheable > 0 ? Math.round((usage.cacheRead / cacheable) * 100) : null;
  const barTotal = USAGE_PARTS.reduce((sum, part) => sum + usage[part.key], 0);
  return (
    <section className="rounded-card bg-well p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-large-strong">Recorded usage</h2>
        {reported ? (
          <span className="text-small text-tertiary tabular-nums">
            {`${usage.requests.toLocaleString()} ${usage.requests === 1 ? "request" : "requests"}`}
          </span>
        ) : null}
      </div>
      {reported ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-heading1 font-semibold tracking-tight tabular-nums">
            {formatUsageTokens(usage.total)}
          </span>
          <span className="text-regular text-secondary">tokens</span>
          {cachePercent !== null ? (
            <span className="ml-auto rounded-control bg-status-green-surface px-2.5 py-0.5 text-small text-status-green">
              {`${cachePercent}% from cache`}
            </span>
          ) : null}
        </div>
      ) : null}
      {reported && barTotal > 0 ? (
        <div
          role="img"
          aria-label={USAGE_PARTS.map((part) => `${part.label} ${usage[part.key].toLocaleString()}`).join(", ")}
          className="mt-3 flex h-2 gap-0.5"
        >
          {USAGE_PARTS.filter((part) => usage[part.key] > 0).map((part) => (
            <span
              key={part.key}
              className="h-full min-w-1 rounded-full"
              style={{ flexGrow: usage[part.key], background: part.fill }}
            />
          ))}
        </div>
      ) : null}
      {!reported ? (
        <p className="mt-2 text-small text-secondary">
          {usage.assistantMessages > 0
            ? "This provider hasn't reported token usage for this chat."
            : "Usage appears after the first reply."}
        </p>
      ) : (
        <dl className="mt-3 space-y-1.5 text-small">
          {USAGE_PARTS.map((part) => (
            <div className="flex items-center justify-between gap-4" key={part.key}>
              <dt className="flex items-center gap-2 text-secondary">
                <span aria-hidden="true" className="size-2 rounded-full" style={{ background: part.fill }} />
                {part.label}
              </dt>
              <dd className="tabular-nums">{token(usage[part.key])}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4">
            <dt className="pl-4 text-secondary">Total reported tokens</dt>
            <dd className="tabular-nums">{token(usage.total)}</dd>
          </div>
          <div className="flex justify-between gap-4 text-tertiary">
            <dt className="pl-4">Reasoning tokens</dt>
            <dd>Unavailable</dd>
          </div>
          <div className="flex justify-between gap-4 text-tertiary">
            <dt className="pl-4">Total cost</dt>
            <dd>Unavailable</dd>
          </div>
        </dl>
      )}
      {reported ? (
        <p className="mt-3 text-mini text-tertiary">
          {`Reported by ${usage.turns} of ${usage.assistantMessages} saved assistant turns. Repeated requests count each time; live work and subagents are not included.`}
        </p>
      ) : null}
    </section>
  );
}

export function ChatContextPanel({
  details,
}: {
  details: ChatContextDetails | null;
}) {
  if (!details)
    return (
      <div className="p-6 text-small text-secondary">
        Send a message to inspect this chat’s context.
      </div>
    );
  const { chat, pressure, compacting } = details;
  const usage = recordedChatUsage(chat);
  const count = (value: number) => value.toLocaleString();
  const dates: Array<[string, string]> = [
    ["Created", new Date(chat.createdAt).toLocaleString()],
    ["Last activity", new Date(chat.updatedAt).toLocaleString()],
  ];
  return (
    <div
      className="@container h-full overflow-y-auto p-5"
      aria-label="Chat context details"
    >
      <div className="grid items-start gap-4 @min-[760px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section className="rounded-card bg-well p-4">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="text-large-strong">Next request</h2>
            {pressure ? (
              <span className="text-small text-tertiary tabular-nums">
                {`Updated ${new Date(pressure.computedAt).toLocaleTimeString()}`}
              </span>
            ) : null}
          </div>
          {pressure ? (
            <>
              <ContextBreakdown pressure={pressure} compacting={compacting} layout="panel" />
              <p className="mt-3 text-mini text-tertiary">
                {pressure.source === "provider-anchored"
                  ? "Anchored to provider-reported usage; the breakdown is estimated."
                  : "Estimated from the next request, including your draft."}
              </p>
            </>
          ) : (
            <Text color="secondary">Context projection is unavailable.</Text>
          )}
        </section>
        <div className="grid content-start gap-4">
          <section className="rounded-card bg-well p-4">
            <h2 className="text-large-strong">Session</h2>
            <p className="mt-2 text-large-strong break-words text-primary">
              {chat.title || "Untitled chat"}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {/* The provider chip wears the provider's mark; the model chip wears the model's own (Claude, Grok). */}
              <Chip
                icon={details.providerId ? (
                  <ProviderIcon
                    providerId={details.providerId}
                    providerLabel={details.providerLabel}
                    artwork={details.providerArtwork}
                    className="size-3.5"
                  />
                ) : undefined}
              >
                {details.providerLabel || "Unknown provider"}
              </Chip>
              <Chip
                icon={details.providerId && details.modelId ? (
                  <ProviderIcon
                    providerId={details.providerId}
                    providerLabel={details.providerLabel}
                    modelId={details.modelId}
                    artwork={details.providerArtwork}
                    className="size-3.5"
                  />
                ) : undefined}
              >
                {details.modelLabel || "Unknown model"}
              </Chip>
              <Chip>{`${count(usage.userMessages)} user · ${count(usage.assistantMessages)} assistant`}</Chip>
            </div>
            <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3 text-small">
              {dates.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-tertiary">{label}</dt>
                  <dd className="mt-0.5 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <UsageSection usage={usage} />
        </div>
      </div>
    </div>
  );
}
