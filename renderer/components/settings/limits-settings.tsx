import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Callout, Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "../ui";
import { InfoHint } from "../ui-info-hint";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import {
  DEFAULT_SPENDING_MONTH_START_DAY,
  ordinalDay,
  parseSpendingLimitsSettings,
  SPENDING_MONTH_START_DAY_MAX,
  type SpendingLimitsSettings,
} from "../../shared/spending";
import { SpendingAmountSelect } from "../spending/spending-amount-select";
import { AutomaticCompactionGroup, CompactionBudgetGroup, PromptCacheGroup } from "./context-settings";
import {
  DEFAULT_USAGE_LIMIT_WAIT_HOURS,
  isUsageLimitWaitHours,
  USAGE_LIMIT_WAIT_HOURS,
  type UsageLimitWaitHours,
} from "../../shared/usage-limits";

const WAIT_LABELS: Record<UsageLimitWaitHours, string> = {
  0: "Don’t wait",
  1: "Up to 1 hour",
  6: "Up to 6 hours",
  12: "Up to 12 hours",
  24: "Up to 24 hours",
};

const MONTH_DAYS = Array.from({ length: SPENDING_MONTH_START_DAY_MAX }, (_, index) => index + 1);

/** Settings → Context & Limits: how long chats stay in context, how replies wait out usage limits, and what they may spend. */
export function LimitsSettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const saves = React.useRef({
    queue: Promise.resolve(),
    pending: 0,
    confirmed: undefined as AppSettings | undefined,
    changed: new Set<keyof AppSettings>(),
  });
  const stored = settings.data?.usageLimitWaitHours;
  const waitHours = isUsageLimitWaitHours(stored) ? stored : DEFAULT_USAGE_LIMIT_WAIT_HOURS;
  const limits: SpendingLimitsSettings = parseSpendingLimitsSettings(settings.data?.spendingLimits) ?? {};
  const monthStartDay = limits.monthStartDay ?? DEFAULT_SPENDING_MONTH_START_DAY;

  // Instant: a choice shows at once. Saves run one at a time, so a quick second change is kept and the controls
  // never have to disable, which would drop keyboard focus. When the last save ends the page settles on what was stored.
  const save = (patch: Partial<AppSettings>, failure: string) => {
    const run = saves.current;
    const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    if (run.pending === 0) {
      run.confirmed = previous;
      run.changed.clear();
    }
    run.pending += 1;
    for (const key of Object.keys(patch)) run.changed.add(key as keyof AppSettings);
    if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, { ...previous, ...patch });
    run.queue = run.queue.then(async () => {
      try {
        const saved = await settingsApi.set(patch);
        run.confirmed = saved;
        if (run.pending === 1) queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
      } catch {
        const confirmed = run.confirmed;
        // Put back only what these saves changed: another group on the page may have saved meanwhile.
        if (run.pending === 1 && confirmed) {
          const restored = Object.fromEntries([...run.changed].map((key) => [key, confirmed[key]]));
          queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => ({ ...(current ?? confirmed), ...restored }));
        }
        toast.error(failure);
      } finally {
        run.pending -= 1;
      }
    });
  };

  const setWaitHours = (hours: UsageLimitWaitHours) => {
    if (hours !== waitHours) save({ usageLimitWaitHours: hours }, "Couldn’t change how long Aiden waits.");
  };

  const setLimit = (key: "chatUsd" | "botMonthUsd" | "routineRunUsd", value: string) => {
    const next: SpendingLimitsSettings = { ...limits };
    const amount = Number(value);
    if (value === "none" || !Number.isFinite(amount) || amount <= 0) delete next[key];
    else next[key] = amount;
    save({ spendingLimits: next }, "Couldn’t change the spending limit.");
  };

  const setMonthStartDay = (day: number) => {
    const next: SpendingLimitsSettings = { ...limits, monthStartDay: day };
    if (day === DEFAULT_SPENDING_MONTH_START_DAY) delete next.monthStartDay;
    save({ spendingLimits: next }, "Couldn’t change when a Bot’s month starts.");
  };
  // Spending limits save as a whole, so nothing can change until they've loaded.
  const locked = !settings.data;
  const amountValue = (amount: number | undefined) => (amount === undefined ? "none" : String(amount));

  return (
    <div className="flex flex-col gap-6">
      <AutomaticCompactionGroup />
      <PromptCacheGroup />
      <CompactionBudgetGroup />
      {settings.isError ? (
        <Callout color="red" role="alert">
          Couldn’t load your limits, so they can’t be changed right now.
        </Callout>
      ) : null}
      <FieldSet
        title="Usage limits"
        hint={
          <InfoHint topic="usage limits">
            Aiden tries once when the limit resets, then lets waiting replies go one at a time. Weekly caps and billing problems fail right away.
          </InfoHint>
        }
      >
        <Field
          label="Wait for a limit to clear"
          description="When a provider’s rate limit or plan limit turns a reply away before it starts, Aiden waits and sends it again with the same model. Chats, Bots and routines all wait."
        >
          <Select
            value={String(waitHours)}
            disabled={locked}
            onValueChange={(value) => {
              const hours = Number(value);
              if (isUsageLimitWaitHours(hours)) void setWaitHours(hours);
            }}
          >
            <SelectTrigger aria-label="Longest wait for a usage limit" className="justify-self-end sm:max-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USAGE_LIMIT_WAIT_HOURS.map((hours) => (
                <SelectItem key={hours} value={String(hours)}>
                  {WAIT_LABELS[hours]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldSet>
      <FieldSet
        title="Spending limits"
        hint={
          <InfoHint topic="spending limits">
            Only API key requests count; sign-ins and local models are $0. At a limit, the reply finishes its step and stops until you allow more.
          </InfoHint>
        }
      >
        <Field label="Each chat" description="The whole chat, with the helpers it starts.">
          <SpendingAmountSelect
            label="Spending limit for each chat"
            value={amountValue(limits.chatUsd)}
            disabled={locked}
            onChange={(value) => setLimit("chatUsd", value)}
          />
        </Field>
        <Field label="Each Bot, per month" description="A Bot can set its own limit on its Profile.">
          <SpendingAmountSelect
            label="Spending limit for each Bot per month"
            value={amountValue(limits.botMonthUsd)}
            disabled={locked}
            onChange={(value) => setLimit("botMonthUsd", value)}
          />
        </Field>
        <Field label="Each routine run" description="Also counts toward its Bot’s month.">
          <SpendingAmountSelect
            label="Spending limit for each routine run"
            value={amountValue(limits.routineRunUsd)}
            disabled={locked}
            onChange={(value) => setLimit("routineRunUsd", value)}
          />
        </Field>
        <Field label="A Bot’s month starts on">
          <Select
            value={String(monthStartDay)}
            disabled={locked}
            onValueChange={(value) => {
              const day = Number(value);
              if (Number.isInteger(day)) setMonthStartDay(day);
            }}
          >
            <SelectTrigger aria-label="The day a Bot’s month starts" className="justify-self-end sm:max-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_DAYS.map((day) => (
                <SelectItem key={day} value={String(day)}>
                  {`The ${ordinalDay(day)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldSet>
    </div>
  );
}
