import * as React from "react";
import { Trash2 } from "lucide-react";
import {
  Button,
  Callout,
  Dialog,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  Textarea,
} from "../../components/ui";
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
  const formId = React.useId();
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
      description={`${bot.name} sends you a message on this schedule.`}
      confirmLabel="Save"
      confirmDisabled={busy}
      busy={busy}
      onConfirm={save}
      submitOnEnter={false}
    >
      <div className="space-y-4">
        {error ? (
          <Callout color="red" role="alert">
            <Text variant="small-strong" color="red">
              {error}
            </Text>
          </Callout>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${formId}-name`} className="text-small-strong">
            Name
          </FieldLabel>
          <Input
            id={`${formId}-name`}
            value={name}
            maxLength={ROUTINE_NAME_MAX}
            placeholder="Weekly meal prep"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Text id={`${formId}-often`} variant="small-strong">
            How often
          </Text>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={`${formId}-often`}>
            {FREQUENCIES.map((option) => {
              const selected = kind === option.kind;
              return (
                <Button
                  key={option.kind}
                  role="radio"
                  aria-checked={selected}
                  size="small"
                  variant="transparent"
                  disabled={busy}
                  className={selected ? "bg-list-selection text-primary" : "text-secondary"}
                  onClick={() => setKind(option.kind)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
        {kind === "weekly" ? (
          <div className="flex flex-col gap-1.5">
            <Text id={`${formId}-days`} variant="small-strong">
              On
            </Text>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${formId}-days`}>
              {WEEKDAYS.map((entry) => {
                const pressed = days.includes(entry.day);
                return (
                  <Button
                    key={entry.day}
                    iconOnly
                    size="small"
                    variant="transparent"
                    aria-label={entry.name}
                    aria-pressed={pressed}
                    disabled={busy}
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
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
          {kind === "once" ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <FieldLabel htmlFor={`${formId}-date`} className="text-small-strong">
                Date
              </FieldLabel>
              <Input
                id={`${formId}-date`}
                type="date"
                value={date}
                disabled={busy}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
          ) : null}
          {kind === "monthly" ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <Text id={`${formId}-day`} variant="small-strong">
                Day of the month
              </Text>
              <Select value={String(day)} disabled={busy} onValueChange={(value) => setDay(Number(value))}>
                <SelectTrigger aria-labelledby={`${formId}-day`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: BOT_ROUTINE_MAX_MONTH_DAY }, (_, index) => index + 1).map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1.5">
            <FieldLabel htmlFor={`${formId}-time`} className="text-small-strong">
              Time
            </FieldLabel>
            <Input
              id={`${formId}-time`}
              type="time"
              value={time}
              disabled={busy}
              onChange={(event) => setTime(event.target.value)}
            />
          </div>
        </div>
        {preview ? (
          <Text as="p" variant="small" color="secondary">
            {preview}
          </Text>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={`${formId}-prompt`} className="text-small-strong">
            What should it do?
          </FieldLabel>
          <Textarea
            id={`${formId}-prompt`}
            className="min-h-20"
            value={prompt}
            maxLength={ROUTINE_PROMPT_MAX}
            placeholder="Give me a short brief of today's meetings and deadlines."
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        {routine ? (
          <div className="pt-1">
            <Button variant="transparent" size="small" className="text-status-red" disabled={busy} onClick={() => void remove()}>
              <Trash2 /> Delete routine
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
