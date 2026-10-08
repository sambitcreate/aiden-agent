import type { Chat } from "../lib/types";
import type { ChatContextPressureV1 } from "../shared/context-pressure";
import { contextPressurePercent } from "../shared/context-pressure";
import { parseAssistantTurnStatsV1 } from "../shared/assistant-turn-stats";
import { ContextMeterDetails } from "./context-meter";
import { Text } from "./ui";

export interface ChatContextDetails {
  chat: Chat;
  providerLabel: string;
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
  const token = (value: number) => (usage.turns ? count(value) : "Unavailable");
  const facts = [
    ["Session", chat.title],
    ["Provider", details.providerLabel],
    ["Model", details.modelLabel],
    ["User messages", count(usage.userMessages)],
    ["Assistant messages", count(usage.assistantMessages)],
    ["Created", new Date(chat.createdAt).toLocaleString()],
    ["Last activity", new Date(chat.updatedAt).toLocaleString()],
  ];
  return (
    <div
      className="h-full overflow-y-auto p-5 space-y-6"
      aria-label="Chat context details"
    >
      <section className="rounded-card bg-well p-4">
        {pressure ? (
          <>
            <ContextMeterDetails
              pressure={pressure}
              percent={contextPressurePercent(pressure)}
              emphasized={compacting || pressure.shouldCompact}
              stateText={
                compacting
                  ? "Compacting context…"
                  : pressure.shouldCompact
                    ? "Aiden will compact before the next request."
                    : "Context healthy — no compaction needed before the next request."
              }
            />
            <p className="mt-3 text-mini text-tertiary">
              Usable input: {count(pressure.inputBudgetTokens)} tokens · Updated{" "}
              {new Date(pressure.computedAt).toLocaleTimeString()}
            </p>
            <p className="mt-1 text-mini text-tertiary">
              {pressure.source === "provider-anchored"
                ? "Projection anchored to provider-reported usage; the breakdown is estimated."
                : "Estimated from the next request, including your draft."}
            </p>
          </>
        ) : (
          <Text color="secondary">Context projection is unavailable.</Text>
        )}
      </section>
      <section>
        <h2 className="text-large-strong mb-3">Session</h2>
        <dl className="grid grid-cols-1 gap-4 @min-[540px]:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-small text-tertiary">{label}</dt>
              <dd className="mt-1 text-small break-words">
                {value || "Unavailable"}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h2 className="text-large-strong">Recorded usage</h2>
        <p className="mt-1 mb-3 text-small text-secondary">
          Reported usage from {usage.turns} of {usage.assistantMessages} saved
          assistant turns. Excludes live work and separately run subagents.
          Missing reports are not counted.
        </p>
        <dl className="space-y-2 text-small">
          {[
            ["Input (excluding cache)", token(usage.input)],
            ["Output", token(usage.output)],
            ["Cache read", token(usage.cacheRead)],
            ["Cache write", token(usage.cacheWrite)],
            ["Total reported tokens", token(usage.total)],
            ["Reported requests", token(usage.requests)],
            ["Reasoning tokens", "Unavailable"],
            ["Total cost", "Unavailable"],
          ].map(([label, value]) => (
            <div className="flex justify-between gap-4" key={label}>
              <dt className="text-secondary">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-mini text-tertiary">
          Cumulative usage counts repeated requests. It is separate from the
          next request’s context. Session reasoning and cost totals are not
          retained.
        </p>
      </section>
    </div>
  );
}
