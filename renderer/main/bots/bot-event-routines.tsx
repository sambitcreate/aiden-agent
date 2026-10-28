// Profile → When something happens (spec §6 P1): routines that run on a file
// change in the Bot's folder, when the routine's own link is called on this
// Mac's network, or when a page or script the person chose gives a different
// answer than last time (a watch). A link is shown once, right after it is
// made. A watch's row shows its last check, and why it stopped if it did.

import * as React from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Field,
  FieldSet,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  Textarea,
  toast,
} from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { formatRelativeTime } from "../../lib/relative-time";
import type { BotEventRoutineView, BotWatchStatusView } from "../../shared/bot-event-routines";
import {
  BOT_WATCH_LIMITS,
  formatBotRoutineTriggerLabel,
  parseBotWatchUrl,
  type BotRoutineTrigger,
} from "../../shared/bot-routine-trigger";
import type { BotDefinition } from "../../shared/bots";

type Draft = {
  /** The routine being edited; a new one otherwise. */
  id?: string;
  name: string;
  prompt: string;
  kind: BotRoutineTrigger["kind"];
  folder: string;
  watchType: "url" | "script";
  url: string;
  script: string;
  everyMinutes: number;
};
const EMPTY: Draft = { name: "", prompt: "", kind: "file_change", folder: "", watchType: "url", url: "", script: "", everyMinutes: 60 };
const WATCH_INTERVALS: readonly number[] = [5, 15, 30, 60, 360, 1_440];

export interface BotEventRoutinesApi {
  list(botId: string): Promise<BotEventRoutineView[]>;
  create(input: { botId: string; name: string; prompt: string; trigger: BotRoutineTrigger }): Promise<{ routine: BotEventRoutineView; link?: string | null }>;
  update(input: { botId: string; id: string; enabled?: boolean; name?: string; prompt?: string; trigger?: BotRoutineTrigger }): Promise<BotEventRoutineView>;
  remove(input: { botId: string; id: string }): Promise<{ removed: boolean }>;
  rotateLink(input: { botId: string; id: string }): Promise<{ link: string | null }>;
  /** Subscribes to changes made elsewhere (a watch's check, a Bot's own pause); returns the unsubscribe. */
  onChanged?(listener: (botId: string) => void): () => void;
}

function draftOf(routine: BotEventRoutineView): Draft {
  const draft: Draft = { ...EMPTY, id: routine.id, name: routine.name, prompt: routine.prompt, kind: routine.trigger.kind };
  if (routine.trigger.kind === "file_change") return { ...draft, folder: routine.trigger.folder };
  if (routine.trigger.kind !== "watch") return draft;
  const { source, everyMinutes } = routine.trigger;
  return source.type === "url"
    ? { ...draft, watchType: "url", url: source.url, everyMinutes }
    : { ...draft, watchType: "script", script: source.script, everyMinutes };
}

function triggerOf(draft: Draft): BotRoutineTrigger {
  if (draft.kind === "webhook") return { kind: "webhook" };
  if (draft.kind === "file_change") return { kind: "file_change", folder: draft.folder.trim() };
  return {
    kind: "watch",
    source: draft.watchType === "url" ? { type: "url", url: draft.url.trim() } : { type: "script", script: draft.script.trim() },
    everyMinutes: draft.everyMinutes,
  };
}

/** Why the draft can't be saved yet, or null. An address gets a hint the person can act on. */
function draftProblem(draft: Draft): { hint?: string } | null {
  if (!draft.name.trim() || !draft.prompt.trim()) return {};
  if (draft.kind === "file_change" && !draft.folder.trim()) return {};
  if (draft.kind !== "watch") return null;
  if (draft.watchType === "script") return draft.script.trim() ? null : {};
  if (!draft.url.trim()) return {};
  return parseBotWatchUrl(draft.url.trim()) ? null : { hint: "Use an https address, or http only for this Mac (localhost)." };
}

/** An interval as the picker lists it: "15 minutes", "1 hour", "6 hours", "1 day". */
function intervalOption(minutes: number): string {
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (minutes % 1_440 === 0) return unit(minutes / 1_440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

const sameSinceFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The status under a watch's row: its last check, or why it isn't checking. */
export function botWatchStatusLine(
  watch: BotWatchStatusView | undefined,
  enabled: boolean,
  botName: string,
  now = Date.now(),
): { text: string; tone: "secondary" | "error" } {
  if (!watch?.lastCheckAt) return { text: enabled ? "First check soon." : "Not checked yet.", tone: "secondary" };
  if (!enabled && watch.failures >= BOT_WATCH_LIMITS.failuresBeforePause) {
    const why = watch.lastError ? ` ${watch.lastError}` : "";
    return { text: `Turned off after ${watch.failures} failed checks in a row.${why} Turn it on to try again.`, tone: "error" };
  }
  if (watch.lastResult === "error") {
    const streak = watch.failures > 1 ? ` (${watch.failures} in a row)` : "";
    return { text: `Couldn’t check ${formatRelativeTime(watch.lastCheckAt, now)}${streak}: ${watch.lastError ?? "the check failed."}`, tone: "error" };
  }
  const checked = `Checked ${formatRelativeTime(watch.lastCheckAt, now)}`;
  if (watch.lastResult === "changed") return { text: `${checked} · Changed, so ${botName} took a look`, tone: "secondary" };
  if (watch.lastResult === "baseline") return { text: `${checked} · Watching for changes from here`, tone: "secondary" };
  const since = watch.sameSince ? ` · No change since ${sameSinceFormat.format(new Date(watch.sameSince))}` : " · No change";
  return { text: `${checked}${since}`, tone: "secondary" };
}

export function BotEventRoutines({
  bot,
  api = botsApi.eventRoutines,
  now,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  api?: BotEventRoutinesApi;
  /** The time relative labels are measured from; the current time by default. */
  now?: number;
}) {
  const [routines, setRoutines] = React.useState<BotEventRoutineView[] | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [link, setLink] = React.useState<{ name: string; link: string | null } | null>(null);
  const [saving, setSaving] = React.useState(false);
  const formId = React.useId();

  const reload = React.useCallback(async () => {
    setRoutines(await api.list(bot.id).catch(() => []));
  }, [api, bot.id]);
  React.useEffect(() => {
    void reload();
    // A watch checks in the background, and can turn itself off.
    return api.onChanged?.((botId) => {
      if (botId === bot.id) void reload();
    });
  }, [api, bot.id, reload]);

  const save = async () => {
    if (!draft) return;
    const trigger = triggerOf(draft);
    setSaving(true);
    try {
      if (draft.id) {
        await api.update({ botId: bot.id, id: draft.id, name: draft.name, prompt: draft.prompt, trigger });
      } else {
        const created = await api.create({ botId: bot.id, name: draft.name, prompt: draft.prompt, trigger });
        if (created.link !== undefined) setLink({ name: created.routine.name, link: created.link });
      }
      setDraft(null);
      await reload();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, draft.id ? "Aiden couldn’t save that routine." : "Aiden couldn’t add that routine."));
    } finally {
      setSaving(false);
    }
  };

  const problem = draft ? draftProblem(draft) : null;
  const intervals = draft && !WATCH_INTERVALS.includes(draft.everyMinutes)
    ? [...WATCH_INTERVALS, draft.everyMinutes].sort((a, b) => a - b)
    : WATCH_INTERVALS;

  return (
    <FieldSet title="When something happens">
      {(routines ?? []).map((routine) => {
        const status = routine.trigger.kind === "watch" ? botWatchStatusLine(routine.watch, routine.enabled, bot.name, now) : null;
        return (
          <Field
            key={routine.id}
            label={routine.name}
            description={
              <>
                {formatBotRoutineTriggerLabel(routine.trigger)}
                {status ? (
                  <span className={status.tone === "error" ? "mt-0.5 block text-red" : "mt-0.5 block text-tertiary"}>{status.text}</span>
                ) : null}
              </>
            }
          >
            <span className="flex items-center gap-2 justify-self-end">
              <Switch
                aria-label={`${routine.name} on`}
                checked={routine.enabled}
                onCheckedChange={(enabled) =>
                  void api.update({ botId: bot.id, id: routine.id, enabled }).then(reload, (error: unknown) =>
                    toast.error(userFacingErrorMessage(error, "Aiden couldn’t change that routine.")))}
              />
              {routine.trigger.kind === "webhook" ? (
                <Button
                  size="small"
                  variant="transparent"
                  aria-label={`New link for ${routine.name}`}
                  onClick={() =>
                    void api.rotateLink({ botId: bot.id, id: routine.id }).then(
                      ({ link: next }) => setLink({ name: routine.name, link: next }),
                      (error: unknown) => toast.error(userFacingErrorMessage(error, "Aiden couldn’t make a new link.")),
                    )}
                >
                  New link
                </Button>
              ) : null}
              {routine.trigger.kind === "watch" ? (
                <Button iconOnly size="small" variant="transparent" aria-label={`Edit ${routine.name}`} onClick={() => setDraft(draftOf(routine))}>
                  <Pencil />
                </Button>
              ) : null}
              <Button
                iconOnly
                size="small"
                variant="transparent"
                aria-label={`Remove ${routine.name}`}
                onClick={() =>
                  void api.remove({ botId: bot.id, id: routine.id }).then(reload, (error: unknown) =>
                    toast.error(userFacingErrorMessage(error, "Aiden couldn’t remove that routine.")))}
              >
                <Trash2 />
              </Button>
            </span>
          </Field>
        );
      })}
      {link ? (
        <Field
          label={`${link.name}'s link`}
          description={link.link
            ? "Works on your network or Tailscale while this Mac is awake. It is shown only now; New link makes another and stops this one. The Mac's certificate is self-signed, so callers may need to allow that (curl -k)."
            : "Turn on Aiden On The Go in Settings to use this routine's link."}
        >
          {link.link ? (
            <Button
              size="small"
              variant="filled"
              className="justify-self-end"
              onClick={() => void navigator.clipboard?.writeText(link.link!).then(() => toast.success("Link copied."))}
            >
              <Copy /> Copy link
            </Button>
          ) : null}
        </Field>
      ) : null}
      {draft ? (
        <Field orientation="vertical" label={draft.id ? "Edit routine" : "New routine"}>
          <div className="flex flex-col gap-3">
            <Input aria-label="Routine name" placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <Textarea
              aria-label="What to do"
              placeholder={`What ${bot.name} should do`}
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
            {draft.id ? null : (
              <RadioGroup
                aria-label="Starts when"
                value={draft.kind}
                onValueChange={(kind) => setDraft({ ...draft, kind: kind as Draft["kind"] })}
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`${bot.id}-event-file`} value="file_change" />
                  <Label htmlFor={`${bot.id}-event-file`}>Files change in a folder</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`${bot.id}-event-link`} value="webhook" />
                  <Label htmlFor={`${bot.id}-event-link`}>Its link is called</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`${bot.id}-event-watch`} value="watch" />
                  <Label htmlFor={`${bot.id}-event-watch`}>A page or script gives a new answer</Label>
                </div>
              </RadioGroup>
            )}
            {draft.kind === "file_change" ? (
              <Input
                aria-label="Folder inside the Bot's folder"
                placeholder="Folder, for example Inbox"
                value={draft.folder}
                onChange={(event) => setDraft({ ...draft, folder: event.target.value })}
              />
            ) : null}
            {draft.kind === "watch" ? (
              <div className={draft.id ? "flex flex-col gap-3" : "flex flex-col gap-3 pl-6"}>
                <RadioGroup
                  aria-label="What to check"
                  className="flex flex-wrap gap-x-5 gap-y-2"
                  value={draft.watchType}
                  onValueChange={(watchType) => setDraft({ ...draft, watchType: watchType as Draft["watchType"] })}
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${formId}-watch-url`} value="url" />
                    <Label htmlFor={`${formId}-watch-url`}>A web address</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${formId}-watch-script`} value="script" />
                    <Label htmlFor={`${formId}-watch-script`}>A script in the Bot’s folder</Label>
                  </div>
                </RadioGroup>
                {draft.watchType === "url" ? (
                  <div className="flex flex-col gap-1">
                    <Input
                      aria-label="Address to check"
                      aria-describedby={`${formId}-watch-hint`}
                      inputMode="url"
                      placeholder="https://status.example.com/api"
                      value={draft.url}
                      onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                    />
                    <Text id={`${formId}-watch-hint`} variant="small" color={problem?.hint ? "red" : "tertiary"}>
                      {problem?.hint ?? "Read with no sign-in or cookies, and never redirected: use the address the page ends up at."}
                    </Text>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <Input
                      aria-label="Script inside the Bot's folder"
                      aria-describedby={`${formId}-watch-hint`}
                      placeholder="scripts/check-build.sh"
                      value={draft.script}
                      onChange={(event) => setDraft({ ...draft, script: event.target.value })}
                    />
                    <Text id={`${formId}-watch-hint`} variant="small" color="tertiary">
                      Runs in the Bot’s folder for up to a minute. What it prints is compared with last time.
                    </Text>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <Text id={`${formId}-every`} variant="small-strong">Check every</Text>
                  <Select value={String(draft.everyMinutes)} onValueChange={(value) => setDraft({ ...draft, everyMinutes: Number(value) })}>
                    <SelectTrigger aria-labelledby={`${formId}-every`} size="small" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {intervals.map((minutes) => (
                        <SelectItem key={minutes} value={String(minutes)}>
                          {intervalOption(minutes)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Text variant="small" color="tertiary">
                  A check doesn’t use the model. {bot.name} runs only when the answer differs from the last check.
                </Text>
              </div>
            ) : null}
            <span className="flex justify-end gap-2">
              <Button size="small" variant="transparent" onClick={() => setDraft(null)}>Cancel</Button>
              <Button size="small" variant="accent" disabled={saving || problem !== null} onClick={() => void save()}>
                {draft.id ? (saving ? "Saving…" : "Save") : saving ? "Adding…" : "Add routine"}
              </Button>
            </span>
          </div>
        </Field>
      ) : (
        <Field label={routines?.length ? "Add another" : "Run a routine when a file changes, a link is called or a page changes"}>
          <Button size="small" variant="filled" className="justify-self-end" onClick={() => setDraft({ ...EMPTY })}>
            <Plus /> Add
          </Button>
        </Field>
      )}
    </FieldSet>
  );
}
