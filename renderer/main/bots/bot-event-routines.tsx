// Profile → When something happens (spec §6 P1): routines that run on a file
// change in the Bot's folder, or when the routine's own link is called on this
// Mac's network. A link is shown once, right after it is made.

import * as React from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { Button, Field, FieldSet, Input, Label, RadioGroup, RadioGroupItem, Switch, Textarea, toast } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotEventRoutineView } from "../../shared/bot-event-routines";
import { formatBotRoutineTriggerLabel, type BotRoutineTrigger } from "../../shared/bot-routine-trigger";
import type { BotDefinition } from "../../shared/bots";

type Draft = { name: string; prompt: string; kind: BotRoutineTrigger["kind"]; folder: string };
const EMPTY: Draft = { name: "", prompt: "", kind: "file_change", folder: "" };

export interface BotEventRoutinesApi {
  list(botId: string): Promise<BotEventRoutineView[]>;
  create(input: { botId: string; name: string; prompt: string; trigger: BotRoutineTrigger }): Promise<{ routine: BotEventRoutineView; link?: string | null }>;
  update(input: { botId: string; id: string; enabled: boolean }): Promise<BotEventRoutineView>;
  remove(input: { botId: string; id: string }): Promise<{ removed: boolean }>;
  rotateLink(input: { botId: string; id: string }): Promise<{ link: string | null }>;
}

export function BotEventRoutines({
  bot,
  api = botsApi.eventRoutines,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  api?: BotEventRoutinesApi;
}) {
  const [routines, setRoutines] = React.useState<BotEventRoutineView[] | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [link, setLink] = React.useState<{ name: string; link: string | null } | null>(null);
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(async () => {
    setRoutines(await api.list(bot.id).catch(() => []));
  }, [api, bot.id]);
  React.useEffect(() => {
    void reload();
  }, [reload]);

  const save = async () => {
    if (!draft) return;
    const trigger: BotRoutineTrigger = draft.kind === "webhook" ? { kind: "webhook" } : { kind: "file_change", folder: draft.folder };
    setSaving(true);
    try {
      const created = await api.create({ botId: bot.id, name: draft.name, prompt: draft.prompt, trigger });
      if (created.link !== undefined) setLink({ name: created.routine.name, link: created.link });
      setDraft(null);
      await reload();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t add that routine."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldSet title="When something happens">
      {(routines ?? []).map((routine) => (
        <Field key={routine.id} label={routine.name} description={formatBotRoutineTriggerLabel(routine.trigger)}>
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
      ))}
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
        <Field orientation="vertical" label="New routine">
          <div className="flex flex-col gap-3">
            <Input aria-label="Routine name" placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <Textarea
              aria-label="What to do"
              placeholder={`What ${bot.name} should do`}
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
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
            </RadioGroup>
            {draft.kind === "file_change" ? (
              <Input
                aria-label="Folder inside the Bot's folder"
                placeholder="Folder, for example Inbox"
                value={draft.folder}
                onChange={(event) => setDraft({ ...draft, folder: event.target.value })}
              />
            ) : null}
            <span className="flex justify-end gap-2">
              <Button size="small" variant="transparent" onClick={() => setDraft(null)}>Cancel</Button>
              <Button
                size="small"
                variant="accent"
                disabled={saving || !draft.name.trim() || !draft.prompt.trim() || (draft.kind === "file_change" && !draft.folder.trim())}
                onClick={() => void save()}
              >
                {saving ? "Adding…" : "Add routine"}
              </Button>
            </span>
          </div>
        </Field>
      ) : (
        <Field label={routines?.length ? "Add another" : "Run a routine when a file changes or a link is called"}>
          <Button size="small" variant="filled" className="justify-self-end" onClick={() => setDraft({ ...EMPTY })}>
            <Plus /> Add
          </Button>
        </Field>
      )}
    </FieldSet>
  );
}
