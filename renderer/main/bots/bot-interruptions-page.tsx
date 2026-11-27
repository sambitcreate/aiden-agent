// A Bot's Advanced tab → Notifications → Quiet hours (spec §6 P4, plan §4.4):
// quiet hours and how many proactive notifications a Bot may send a day.
// Choices save as they change.

import { Minus, Plus } from "lucide-react";
import { Button, Field, FieldSet, Switch } from "../../components/ui";
import { BOT_INTERRUPTIONS_MAX_DAILY_LIMIT, type BotInterruptions } from "../../shared/bots";

/** "10:00 PM" for "22:00", in the person's own clock style. */
export function clockLabel(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function QuietTimeField({
  label,
  ariaLabel,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="time"
        aria-label={ariaLabel}
        className="justify-self-end rounded-control bg-input px-2 py-1 text-regular text-primary outline-none"
        value={value}
        onChange={(event) => event.target.value && onChange(event.target.value)}
      />
    </Field>
  );
}

/** The editable part of the page, separate from saving so it can be tested alone. */
export function BotInterruptionsFields({
  value,
  onChange,
}: {
  value: BotInterruptions;
  onChange(next: BotInterruptions): void;
}) {
  const setQuiet = (patch: Partial<BotInterruptions["quietHours"]>) =>
    onChange({ ...value, quietHours: { ...value.quietHours, ...patch } });
  const setLimit = (dailyLimit: number) =>
    onChange({ ...value, dailyLimit: Math.max(0, Math.min(BOT_INTERRUPTIONS_MAX_DAILY_LIMIT, dailyLimit)) });
  return (
    <>
      <FieldSet title="Quiet hours">
        <Field label="Quiet hours" description="Messages wait until quiet hours end, then arrive together.">
          <Switch
            aria-label="Quiet hours"
            className="justify-self-end"
            checked={value.quietHours.enabled}
            onCheckedChange={(enabled) => setQuiet({ enabled })}
          />
        </Field>
        {value.quietHours.enabled ? (
          <>
            <QuietTimeField
              label="From"
              ariaLabel="Quiet from"
              value={value.quietHours.start}
              onChange={(start) => setQuiet({ start })}
            />
            <QuietTimeField
              label="Until"
              ariaLabel="Quiet until"
              value={value.quietHours.end}
              onChange={(end) => setQuiet({ end })}
            />
          </>
        ) : null}
      </FieldSet>
      <FieldSet title="Each day">
        <Field
          label="Notifications a day"
          description="Routine results and suggestions past this stay in the chat. Alerts that need you still arrive after quiet hours."
        >
          <span className="flex items-center gap-2 justify-self-end">
            <Button
              iconOnly
              size="small"
              variant="filled"
              aria-label="Fewer notifications"
              disabled={value.dailyLimit <= 0}
              onClick={() => setLimit(value.dailyLimit - 1)}
            >
              <Minus />
            </Button>
            <output aria-label="Notifications a day" className="min-w-6 text-center text-strong text-primary">
              {value.dailyLimit}
            </output>
            <Button
              iconOnly
              size="small"
              variant="filled"
              aria-label="More notifications"
              disabled={value.dailyLimit >= BOT_INTERRUPTIONS_MAX_DAILY_LIMIT}
              onClick={() => setLimit(value.dailyLimit + 1)}
            >
              <Plus />
            </Button>
          </span>
        </Field>
      </FieldSet>
    </>
  );
}
