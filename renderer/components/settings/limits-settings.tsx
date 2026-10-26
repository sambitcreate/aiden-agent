import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, toast } from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
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

/** Settings → Limits & spending: how long replies wait out provider usage limits. */
export function LimitsSettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [saving, setSaving] = React.useState(false);
  const stored = settings.data?.usageLimitWaitHours;
  const waitHours = isUsageLimitWaitHours(stored) ? stored : DEFAULT_USAGE_LIMIT_WAIT_HOURS;

  const setWaitHours = async (hours: UsageLimitWaitHours) => {
    if (saving || hours === waitHours) return;
    setSaving(true);
    // Instant: the choice shows at once and rolls back if it can't be saved.
    const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, { ...previous, usageLimitWaitHours: hours });
    try {
      const saved = await settingsApi.set({ usageLimitWaitHours: hours });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch {
      if (previous) queryClient.setQueryData<AppSettings>(queryKeys.settings, previous);
      toast.error("Couldn’t change how long Aiden waits.");
    } finally {
      setSaving(false);
    }
  };

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
    </div>
  );
}
