import * as React from "react";
import { Button, Dialog, Input, Text, Textarea } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotRoutine } from "../../../main/services/scheduled-bot-routines";
import { formatBotRoutineLabel } from "../../shared/bot-routine-label";
import {
  BOT_ROUTINE_MAX_MONTH_DAY,
  type BotRoutineSchedule,
  type BotRoutineScheduleKind,
} from "../../shared/bot-routine-schedule";
import type { BotDefinition } from "../../shared/bots";
import { cn } from "../../lib/ui-utils";

export const ROUTINE_NAME_MAX = 120;
export const ROUTINE_PROMPT_MAX = 4_000;

const FREQUENCIES: ReadonlyArray<{ kind: BotRoutineScheduleKind; label: string }> = [
  { kind: "once", label: "Once" },
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
  { kind: "monthly", label: "Monthly" },
];

const WEEKDAYS: ReadonlyArray<{ day: number; label: string; name: string }> = [
  { day: 0, label: "S", name: "Sunday" },
  { day: 1, label: "M", name: "Monday" },
  { day: 2, label: "T", name: "Tuesday" },
  { day: 3, label: "W", name: "Wednesday" },
  { day: 4, label: "T", name: "Thursday" },
  { day: 5, label: "F", name: "Friday" },
  { day: 6, label: "S", name: "Saturday" },
];

function localDateString(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The schedule a new routine starts with: every day at 9:00. */
function defaultSchedule(): { kind: BotRoutineScheduleKind; time: string; date: string; days: number[]; day: number } {
  return { kind: "daily", time: "09:00", date: localDateString(new Date()), days: [1], day: 1 };
}

/** The schedule the form describes, or a message when it is incomplete. */
export function routineScheduleFromForm(form: {
  kind: BotRoutineScheduleKind;
  time: string;
  date: string;
  days: readonly number[];
  day: number;
}): { schedule: BotRoutineSchedule } | { error: string } {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(form.time)) return { error: "Choose a time." };
  switch (form.kind) {
    case "once":
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(form.date)) return { error: "Choose a date." };
      return { schedule: { kind: "once", date: form.date, time: form.time } };
    case "daily":
    case "weekdays":
      return { schedule: { kind: form.kind, time: form.time } };
    case "weekly":
      if (form.days.length === 0) return { error: "Choose at least one day." };
      return { schedule: { kind: "weekly", days: [...form.days].sort((a, b) => a - b), time: form.time } };
    case "monthly":
      return { schedule: { kind: "monthly", day: form.day, time: form.time } };
  }
}

function formFromRoutine(routine: BotRoutine) {
  const base = defaultSchedule();
  const schedule = routine.schedule;
  if (!schedule) return { ...base, name: routine.name, prompt: routine.prompt };
  return {
    ...base,
    kind: schedule.kind,
    time: schedule.time,
    ...(schedule.kind === "once" ? { date: schedule.date } : {}),
    ...(schedule.kind === "weekly" ? { days: schedule.days } : {}),
    ...(schedule.kind === "monthly" ? { day: schedule.day } : {}),
    name: routine.name,
    prompt: routine.prompt,
  };
}

/** Add or edit one routine: a name, a frequency-first schedule, and what it should do. */
export function BotRoutineEditor({
  bot,
  routine,
  open,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  /** Undefined adds a routine. */
  routine?: BotRoutine;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(routine: BotRoutine): void;
  onDeleted?(): void;
}) {
  const initial = routine ? formFromRoutine(routine) : { ...defaultSchedule(), name: "", prompt: "" };
  const [name, setName] = React.useState(initial.name);
  const [prompt, setPrompt] = React.useState(initial.prompt);
  const [kind, setKind] = React.useState<BotRoutineScheduleKind>(initial.kind);
  const [time, setTime] = React.useState(initial.time);
  const [date, setDate] = React.useState(initial.date);
  const [days, setDays] = React.useState<number[]>(initial.days);
  const [day, setDay] = React.useState(initial.day);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scheduled = routineScheduleFromForm({ kind, time, date, days, day });
  const preview = "schedule" in scheduled ? formatBotRoutineLabel(scheduled.schedule) : null;

  const remove = async () => {
    if (!routine || busy) return;
    setBusy(true);
    try {
      await botsApi.routines.delete({ botId: bot.id, id: routine.id, expectedUpdatedAt: routine.updatedAt });
      onDeleted?.();
      onOpenChange(false);
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "Aiden couldn’t delete this routine."));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return setError("Give the routine a name.");
    if (!prompt.trim()) return setError("Tell the Bot what to do.");
    if (!("schedule" in scheduled)) return setError(scheduled.error);
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const saved = routine
        ? await botsApi.routines.update({
            botId: bot.id,
            id: routine.id,
            expectedUpdatedAt: routine.updatedAt,
            name: name.trim(),
            schedule: scheduled.schedule,
            prompt: prompt.trim(),
            timezone,
          })
        : await botsApi.routines.create({
            botId: bot.id,
            name: name.trim(),
            schedule: scheduled.schedule,
            prompt: prompt.trim(),
            timezone,
          });
      onSaved(saved);
      onOpenChange(false);
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "Aiden couldn’t save this routine."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={routine ? "Edit routine" : "Add routine"}
      confirmLabel="Save"
      confirmDisabled={busy}
      busy={busy}
      onConfirm={save}
      submitOnEnter={false}
    >
      <div className="space-y-4">
        {error ? (
          <Text as="p" variant="small" color="secondary" role="alert">
            {error}
          </Text>
        ) : null}
        <label className="block">
          <Text variant="small-strong">Name</Text>
          <Input
            className="mt-1.5"
            value={name}
            maxLength={ROUTINE_NAME_MAX}
            placeholder="Weekly meal prep"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="space-y-2">
          <legend>
            <Text variant="small-strong">How often</Text>
          </legend>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How often">
            {FREQUENCIES.map((option) => {
              const selected = kind === option.kind;
              return (
                <Button
                  key={option.kind}
                  role="radio"
                  aria-checked={selected}
                  size="small"
                  variant={selected ? "muted" : "transparent"}
                  className={cn(selected ? "bg-list-selection text-primary" : "text-secondary")}
                  onClick={() => setKind(option.kind)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </fieldset>
        {kind === "once" ? (
          <label className="block">
            <Text variant="small-strong">Date</Text>
            <input
              type="date"
              className="mt-1.5 block h-9 rounded-control bg-control px-2 text-regular text-primary"
              value={date}
              disabled={busy}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        ) : null}
        {kind === "weekly" ? (
          <div className="flex gap-1.5" role="group" aria-label="Days">
            {WEEKDAYS.map((entry) => {
              const pressed = days.includes(entry.day);
              return (
                <Button
                  key={entry.day}
                  iconOnly
                  size="small"
                  variant={pressed ? "muted" : "transparent"}
                  aria-label={entry.name}
                  aria-pressed={pressed}
                  className={pressed ? "bg-list-selection text-primary" : "text-secondary"}
                  onClick={() =>
                    setDays((current) =>
                      current.includes(entry.day)
                        ? current.filter((value) => value !== entry.day)
                        : [...current, entry.day],
                    )
                  }
                >
                  {entry.label}
                </Button>
              );
            })}
          </div>
        ) : null}
        {kind === "monthly" ? (
          <label className="block">
            <Text variant="small-strong">Day of the month</Text>
            <select
              className="mt-1.5 block h-9 rounded-control bg-control px-2 text-regular text-primary"
              value={day}
              disabled={busy}
              onChange={(event) => setDay(Number(event.target.value))}
            >
              {Array.from({ length: BOT_ROUTINE_MAX_MONTH_DAY }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block">
          <Text variant="small-strong">Time</Text>
          <input
            type="time"
            className="mt-1.5 block h-9 rounded-control bg-control px-2 text-regular text-primary"
            value={time}
            disabled={busy}
            onChange={(event) => setTime(event.target.value)}
          />
        </label>
        {preview ? (
          <Text as="p" variant="small" color="secondary">
            {preview}
          </Text>
        ) : null}
        <label className="block">
          <Text variant="small-strong">What should it do?</Text>
          <Textarea
            className="mt-1.5 min-h-20 resize-none"
            value={prompt}
            maxLength={ROUTINE_PROMPT_MAX}
            placeholder="Give me a short brief of today's meetings and deadlines."
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        {routine ? (
          <Button variant="destructive" size="medium" disabled={busy} onClick={() => void remove()}>
            Delete routine
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
