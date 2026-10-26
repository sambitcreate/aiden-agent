import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, toast } from "../ui";
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

/** Settings → Limits & spending: how long replies wait out provider usage limits, and what they may spend. */
export function LimitsSettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [saving, setSaving] = React.useState(false);
  const stored = settings.data?.usageLimitWaitHours;
  const waitHours = isUsageLimitWaitHours(stored) ? stored : DEFAULT_USAGE_LIMIT_WAIT_HOURS;
  const limits: SpendingLimitsSettings = parseSpendingLimitsSettings(settings.data?.spendingLimits) ?? {};
  const monthStartDay = limits.monthStartDay ?? DEFAULT_SPENDING_MONTH_START_DAY;

  // Instant: a choice shows at once and rolls back if it can't be saved.
  const save = async (patch: Partial<AppSettings>, failure: string) => {
    if (saving) return;
    setSaving(true);
    const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, { ...previous, ...patch });
    try {
      const saved = await settingsApi.set(patch);
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch {
      if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, previous);
      toast.error(failure);
    } finally {
      setSaving(false);
    }
  };

  const setWaitHours = (hours: UsageLimitWaitHours) => {
    if (hours !== waitHours) void save({ usageLimitWaitHours: hours }, "Couldn’t change how long Aiden waits.");
  };

  const setLimit = (key: "chatUsd" | "botMonthUsd" | "routineRunUsd", value: string) => {
    const next: SpendingLimitsSettings = { ...limits };
    const amount = Number(value);
    if (value === "none" || !Number.isFinite(amount) || amount <= 0) delete next[key];
    else next[key] = amount;
    void save({ spendingLimits: next }, "Couldn’t change the spending limit.");
  };

  const setMonthStartDay = (day: number) => {
    const next: SpendingLimitsSettings = { ...limits, monthStartDay: day };
    if (day === DEFAULT_SPENDING_MONTH_START_DAY) delete next.monthStartDay;
    void save({ spendingLimits: next }, "Couldn’t change when a Bot’s month starts.");
  };
  const amountValue = (amount: number | undefined) => (amount === undefined ? "none" : String(amount));

  return (
    <div className="flex flex-col gap-6">
      <FieldSet title="Usage limits">
        <Field
          label="Wait for a limit to clear"
          description="When a provider’s rate limit or plan limit turns a reply away before it starts, Aiden waits and sends it again with the same model. Chats, Bots and routines all wait."
        >
          <Select
            value={String(waitHours)}
            disabled={settings.isLoading}
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
      <Text as="p" variant="small" color="secondary" className="-mt-4 px-4 text-pretty">
        Aiden tries once when the provider says the limit resets, then lets waiting replies go one at a time.
        Limits that last days, like a weekly cap, and billing problems fail right away with the reset time.
        Retry now on a waiting reply tries again at once.
      </Text>
      <FieldSet title="Spending limits">
        <Field label="Each chat" description="The whole chat, with the helpers it starts.">
          <SpendingAmountSelect
            label="Spending limit for each chat"
            value={amountValue(limits.chatUsd)}
            disabled={settings.isLoading}
            onChange={(value) => setLimit("chatUsd", value)}
          />
        </Field>
        <Field label="Each Bot, per month" description="A Bot can set its own limit on its Profile.">
          <SpendingAmountSelect
            label="Spending limit for each Bot per month"
            value={amountValue(limits.botMonthUsd)}
            disabled={settings.isLoading}
            onChange={(value) => setLimit("botMonthUsd", value)}
          />
        </Field>
        <Field label="Each routine run" description="Also counts toward its Bot’s month.">
          <SpendingAmountSelect
            label="Spending limit for each routine run"
            value={amountValue(limits.routineRunUsd)}
            disabled={settings.isLoading}
            onChange={(value) => setLimit("routineRunUsd", value)}
          />
        </Field>
        <Field label="A Bot’s month starts on">
          <Select
            value={String(monthStartDay)}
            disabled={settings.isLoading}
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
      <Text as="p" variant="small" color="secondary" className="-mt-4 px-4 text-pretty">
        Only requests paid for with an API key count. Claude and ChatGPT sign-ins, and models on this Mac, count as
        $0. When a limit is reached, the reply finishes the step it’s on, then stops. Allow more from the chat, the
        Bot, or your phone.
      </Text>
    </div>
  );
}
