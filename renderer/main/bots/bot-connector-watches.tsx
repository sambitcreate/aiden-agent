import { assertBotCanSavePendingChanges } from "../../lib/bot-local-pending";
import { BotRoutineModelButton } from "./bot-routine-models";
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Field, FieldSet, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Text, Textarea } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { formatRelativeTime } from "../../lib/relative-time";
import { BOT_CONNECTOR_WATCH_LIMITS as limits, type BotConnectorWatchConfig, type BotConnectorWatchCreateInput, type BotConnectorWatchEnableInput, type BotConnectorWatchIdentityInput, type BotConnectorWatchInterval, type BotConnectorWatchList, type BotConnectorWatchReply, type BotConnectorWatchSourceList, type BotConnectorWatchTestResult, type BotConnectorWatchUpdateInput, type BotConnectorWatchView } from "../../shared/bot-connector-watches";

import { useAppCapabilities } from "../../lib/app-capabilities";
import { localComputerNoun } from "../../shared/computer-noun";
export type BotConnectorWatchesApi = typeof botsApi.connectorWatches;
type Draft = BotConnectorWatchConfig & { id?: string; expectedRevision?: string; sourceChoiceId?: string };
type Pending =
  | { action: "create"; input: BotConnectorWatchCreateInput }
  | { action: "update"; input: BotConnectorWatchUpdateInput }
  | { action: "setEnabled"; input: BotConnectorWatchEnableInput }
  | { action: "remove" | "runNow"; input: BotConnectorWatchIdentityInput };
const emptyDraft = (): Draft => ({ name: "", prompt: "", condition: { kind: "email", unreadOnly: false }, everyMinutes: 30 });
const storageKey = (botId: string) => `aiden:pending-connector-watch:${botId}`;

function readPending(botId: string): Pending | null {
  try {
    const raw = localStorage.getItem(storageKey(botId));
    // JSON escapes can use six characters per UTF-16 unit of an otherwise valid prompt.
    if (!raw || raw.length > 256 * 1024) return null;
    const value = JSON.parse(raw) as Pending;
    if (!["create", "update", "setEnabled", "remove", "runNow"].includes(value.action)
      || value.input?.botId !== botId || typeof value.input.mutationId !== "string"
      || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value.input.mutationId)) return null;
    if (value.action !== "create" && (typeof value.input.id !== "string" || typeof value.input.expectedRevision !== "string")) return null;
    if (value.action === "setEnabled" && typeof value.input.enabled !== "boolean") return null;
    if (value.action === "create" || value.action === "update") {
      const input = value.input;
      if (typeof input.name !== "string" || input.name.length > limits.nameChars
        || typeof input.prompt !== "string" || input.prompt.length > limits.promptChars
        || ![15, 30, 60].includes(input.everyMinutes) || !input.condition) return null;
      const condition = input.condition;
      if (condition.kind === "email") {
        if (typeof condition.unreadOnly !== "boolean" || [condition.sender, condition.subject].some((filter) => filter !== undefined && (typeof filter !== "string" || filter.length > limits.filterChars))) return null;
      } else if (condition.kind === "calendar") {
        if (!Number.isInteger(condition.lookAheadMinutes) || condition.lookAheadMinutes < limits.lookAheadMinMinutes || condition.lookAheadMinutes > limits.lookAheadMaxMinutes
          || typeof condition.timezone !== "string" || condition.timezone.length > limits.timezoneChars) return null;
      } else return null;
      if (value.action === "create" && typeof value.input.sourceChoiceId !== "string") return null;
    }
    return value;
  } catch { return null; }
}

function draftFromPending(value: Pending | null): Draft | null {
  return value?.action === "create" || value?.action === "update" ? { ...value.input } : null;
}

function rejected<T>(reply: BotConnectorWatchReply<T>): reply is Extract<BotConnectorWatchReply<T>, { ok: false }> {
  return typeof reply === "object" && reply !== null && "ok" in reply && reply.ok === false;
}

function watchStatus(watch: BotConnectorWatchView): string {
  if (watch.lastError) return watch.lastError;
  const checked = watch.lastCheckAt ? `Checked ${formatRelativeTime(watch.lastCheckAt)}` : "First check pending";
  if (!watch.enabled) return `Paused · ${checked}`;
  const result = { waiting: "Watching for changes", empty: "No matching items", unchanged: "No change", changed: "Change delivered", error: "Check failed", paused: "Paused" }[watch.state];
  return `${checked} · ${result}`;
}

/** The keyed manager prevents responses for a previous Bot from replacing this Bot's draft. */
export function BotConnectorWatches({ bot, api = botsApi.connectorWatches }: {
  bot: { id: string; name: string }; api?: BotConnectorWatchesApi;
}) {
  return <WatchManager key={bot.id} bot={bot} api={api} />;
}

function WatchManager({ bot, api }: { bot: { id: string; name: string }; api: BotConnectorWatchesApi }) {
  const { platform } = useAppCapabilities();
  const [pending, setPending] = React.useState<Pending | null>(() => readPending(bot.id));
  const [draft, setDraft] = React.useState<Draft | null>(() => draftFromPending(readPending(bot.id)));
  const [list, setList] = React.useState<BotConnectorWatchList | null>(null);
  const [sources, setSources] = React.useState<BotConnectorWatchSourceList | null>(null);
  const [preview, setPreview] = React.useState<BotConnectorWatchTestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<BotConnectorWatchView | null>(null);
  const locked = React.useRef(false);
  const mounted = React.useRef(true);
  const readGeneration = React.useRef(0);
  const fieldId = React.useId();

  const reload = React.useCallback(async () => {
    const generation = ++readGeneration.current;
    try {
      const next = await api.list(bot.id);
      if (mounted.current && generation === readGeneration.current) {
        if (rejected(next)) { setList(null); setError(next.message); }
        else setList(next);
      }
    } catch (cause) {
      if (mounted.current && generation === readGeneration.current) setError(userFacingErrorMessage(cause, "Couldn’t load watches. Try again."));
    }
  }, [api, bot.id]);
  React.useEffect(() => {
    mounted.current = true;
    void reload();
    const unsubscribe = api.onChanged((id) => { if (id === bot.id) void reload(); });
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== storageKey(bot.id)) return;
      const retained = readPending(bot.id);
      if (retained) { setPending(retained); setDraft(draftFromPending(retained)); }
    };
    window.addEventListener("storage", storageChanged);
    return () => { mounted.current = false; readGeneration.current++; unsubscribe(); window.removeEventListener("storage", storageChanged); };
  }, [api, bot.id, reload]);

  const perform = async (operation: Pending) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const retained = readPending(bot.id);
      const wasUncertain = retained !== null;
      if (retained && JSON.stringify(retained) !== JSON.stringify(operation)) {
        setPending(retained); setDraft(draftFromPending(retained));
        setError("Another saved watch change needs confirmation. Retry that request first.");
        return;
      }
      // Save the identity before crossing IPC. A lost response can only be retried with this same input.
      assertBotCanSavePendingChanges(bot.id);
      localStorage.setItem(storageKey(bot.id), JSON.stringify(operation));
      setPending(operation);
      const reply = await (operation.action === "create" ? api.create(operation.input)
        : operation.action === "update" ? api.update(operation.input)
          : operation.action === "setEnabled" ? api.setEnabled(operation.input)
            : operation.action === "remove" ? api.remove(operation.input) : api.runNow(operation.input));
      if (rejected(reply)) {
        // A refusal before receipt lookup says nothing about an earlier lost response.
        if (wasUncertain) {
          if (mounted.current) setError(`${reply.message} The earlier outcome is still unconfirmed.`);
        } else {
          if (readPending(bot.id)?.input.mutationId === operation.input.mutationId) localStorage.removeItem(storageKey(bot.id));
          if (mounted.current) {
            setPending(null); setError(reply.message);
            if (reply.code === "revision_conflict" && reply.current) setConflict(reply.current);
          }
        }
      } else {
        const expectedId = operation.action === "create" ? operation.input.mutationId : operation.input.id;
        if (!reply || reply.id !== expectedId || typeof reply.revision !== "string") throw new Error("The response couldn’t be confirmed. Retry the same request to check its outcome.");
        if (readPending(bot.id)?.input.mutationId === operation.input.mutationId) localStorage.removeItem(storageKey(bot.id));
        if (mounted.current) {
          setPending(null); setRemoving(null);
          if (operation.action === "create" || operation.action === "update") setDraft(null);
          setNotice(operation.action === "runNow"
            ? "admitted" in reply && reply.admitted ? "Run request confirmed. The Bot’s current limits and pause state still apply." : "Run was not admitted. Check the watch and Bot status before trying again."
            : "Watch change saved.");
        }
      }
      if (mounted.current) await reload();
    } catch (cause) {
      if (mounted.current) setError(userFacingErrorMessage(cause, "The change couldn’t be confirmed. Retry the same request."));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const readAction = async (action: () => Promise<BotConnectorWatchReply<BotConnectorWatchSourceList | BotConnectorWatchTestResult>>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      const reply = await action();
      if (!mounted.current) return;
      if (rejected(reply)) setError(reply.message);
      else if ("choices" in reply) setSources(reply);
      else setPreview(reply);
    } catch (cause) {
      if (mounted.current) setError(userFacingErrorMessage(cause, "Couldn’t check the connector. Try again."));
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const identity = (watch: BotConnectorWatchView): BotConnectorWatchIdentityInput => ({ botId: bot.id, id: watch.id, expectedRevision: watch.revision, mutationId: crypto.randomUUID() });
  const edit = (watch: BotConnectorWatchView) => {
    setDraft({ id: watch.id, expectedRevision: watch.revision, name: watch.name, prompt: watch.prompt, condition: watch.condition, everyMinutes: watch.everyMinutes });
    setPreview(null); setSources(null); setError(null); setConflict(null);
  };
  const disabled = busy || pending !== null;
  const valid = !conflict && draft && draft.name.trim() && draft.prompt.trim() && (draft.id || draft.sourceChoiceId);
  const save = () => {
    if (!draft || !valid || disabled) return;
    const config: BotConnectorWatchConfig = { name: draft.name.trim(), prompt: draft.prompt.trim(), condition: draft.condition, everyMinutes: draft.everyMinutes };
    const mutationId = crypto.randomUUID();
    void perform(draft.id
      ? { action: "update", input: { ...config, botId: bot.id, id: draft.id, expectedRevision: draft.expectedRevision!, mutationId, ...(draft.sourceChoiceId ? { sourceChoiceId: draft.sourceChoiceId } : {}) } }
      : { action: "create", input: { ...config, botId: bot.id, sourceChoiceId: draft.sourceChoiceId!, mutationId } });
  };
  const template = list?.templates.find((item) => item.kind === draft?.condition.kind);

  return <FieldSet title="Connected-app watches">
    <Field label="Watch while Aiden is running" description={`Checks continue away from the Bots screen while this ${localComputerNoun(platform)} is awake. Connect and grant the app in this Bot’s Access settings first.`} />
    {error && <Field orientation="vertical" label="Watch needs attention"><Text color="red" role="alert">{error}</Text><Button size="small" variant="transparent" onClick={() => void reload()}>Refresh watches</Button></Field>}
    {notice && <Field orientation="vertical" label={<span role="status">{notice}</span>} />}
    {pending && <Field orientation="vertical" label="Change waiting for confirmation" description="The original request is saved on this device. Retry it to confirm the outcome before making another change.">
      <Button size="small" disabled={busy} onClick={() => void perform(pending)}>Retry same request</Button>
    </Field>}
    {conflict && draft?.id === conflict.id && <Field orientation="vertical" label="Watch changed elsewhere" description={`Latest saved version: ${conflict.name} · ${conflict.source.accountLabel} · ${conflict.source.resourceLabel}`}>
      <Text variant="small">{conflict.prompt}</Text>
      <Button size="small" disabled={disabled} onClick={() => { setDraft({ ...draft, expectedRevision: conflict.revision }); setConflict(null); setError(null); }}>Keep my edits against this version</Button>
      <Button size="small" variant="transparent" disabled={disabled} onClick={() => edit(conflict)}>Load saved version</Button>
    </Field>}
    {!list && !error && <Field label="Loading watches…" />}
    {list && !list.supported && <Field label="Watches unavailable" description={list.unavailableReason} />}
    {list?.watches.map((watch) => <Field key={watch.id} orientation="vertical" label={watch.name} description={<>{watch.source.providerLabel} · {watch.source.accountLabel} · {watch.source.resourceLabel}<span className="mt-0.5 block">Every {watch.everyMinutes} minutes · {watchStatus(watch)}</span></>}>
      <div className="flex flex-wrap items-center gap-2">
        <Switch aria-label={`${watch.name} on`} checked={watch.enabled} disabled={disabled} onCheckedChange={(enabled) => void perform({ action: "setEnabled", input: { ...identity(watch), enabled } })} />
        <Button size="small" variant="transparent" disabled={disabled} onClick={() => void readAction(() => api.testCheck({ botId: bot.id, id: watch.id, expectedRevision: watch.revision }))}>Test {watch.name}</Button>
        <Button size="small" variant="transparent" disabled={disabled} onClick={() => void perform({ action: "runNow", input: identity(watch) })}>Run {watch.name} now</Button>
        <BotRoutineModelButton botId={bot.id} routineId={watch.id} routineName={watch.name} disabled={disabled} />
        <Button iconOnly size="small" variant="transparent" aria-label={`Edit watch ${watch.name}`} disabled={disabled} onClick={() => edit(watch)}><Pencil /></Button>
        <Button iconOnly size="small" variant="transparent" aria-label={`Remove watch ${watch.name}`} disabled={disabled} onClick={() => setRemoving(watch.id)}><Trash2 /></Button>
        {removing === watch.id && <><Text variant="small">Remove this watch?</Text><Button size="small" disabled={disabled} onClick={() => void perform({ action: "remove", input: identity(watch) })}>Remove watch</Button><Button size="small" variant="transparent" disabled={disabled} onClick={() => setRemoving(null)}>Keep watch</Button></>}
      </div>
    </Field>)}
    {list?.supported && !list.watches.length && !draft && <Field label="No connected-app watches" description="Choose a mailbox or calendar and tell your Bot what to do when something meaningful changes." />}
    {draft && <Field orientation="vertical" label={draft.id ? "Edit connected-app watch" : "New connected-app watch"}>
      <div className="flex flex-col gap-3">
        <Input aria-label="Watch name" maxLength={limits.nameChars} value={draft.name} disabled={disabled} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Watch name" />
        <Textarea aria-label="What the Bot should do" maxLength={limits.promptChars} value={draft.prompt} disabled={disabled} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder={`What ${bot.name} should do when something changes`} />
        {!draft.id && <><Label htmlFor={`${fieldId}-template`}>What to watch</Label><Select value={template?.id} disabled={disabled} onValueChange={(id) => {
          const selected = list?.templates.find((item) => item.id === id);
          if (!selected?.available) return;
          setDraft({ ...draft, sourceChoiceId: undefined, condition: selected.kind === "email" ? { kind: "email", unreadOnly: false } : { kind: "calendar", lookAheadMinutes: 60, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
        }}><SelectTrigger id={`${fieldId}-template`}><SelectValue /></SelectTrigger><SelectContent>{list?.templates.map((item) => <SelectItem key={item.id} value={item.id} disabled={!item.available}>{item.title}{item.available ? "" : " — unavailable"}</SelectItem>)}</SelectContent></Select>
          {list?.templates.filter((item) => !item.available).map((item) => <Text key={item.id} variant="small" color="tertiary">{item.unavailableReason}</Text>)}
        </>}
        <Button size="small" variant="filled" disabled={disabled} onClick={() => void readAction(() => api.discoverSources(bot.id))}>{draft.id ? "Find a different source" : "Find sources"}</Button>
        {sources && <>
          <Label htmlFor={`${fieldId}-source`}>Connected source</Label><Select value={draft.sourceChoiceId ?? ""} disabled={disabled} onValueChange={(sourceChoiceId) => setDraft({ ...draft, sourceChoiceId })}><SelectTrigger id={`${fieldId}-source`}><SelectValue placeholder="Choose a source" /></SelectTrigger><SelectContent>{sources.choices.filter((item) => item.templateId === template?.id).map((item) => <SelectItem key={item.id} value={item.id} disabled={!item.available}>{item.providerLabel} · {item.accountLabel} · {item.resourceLabel}</SelectItem>)}</SelectContent></Select>
          {sources.unavailableReasons.map((reason, index) => <Text key={index} variant="small" color="tertiary">{reason}</Text>)}
          {!sources.choices.length && <Text variant="small" color="tertiary">No eligible sources. Open the connector on this {localComputerNoun(platform)} and check this Bot’s Access settings, then try again.</Text>}
        </>}
        {draft.condition.kind === "email" ? <>
          <Input aria-label="Sender filter" placeholder="Sender contains (optional)" maxLength={limits.filterChars} value={draft.condition.sender ?? ""} disabled={disabled} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition as Extract<Draft["condition"], { kind: "email" }>, sender: e.target.value || undefined } })} />
          <Input aria-label="Subject filter" placeholder="Subject contains (optional)" maxLength={limits.filterChars} value={draft.condition.subject ?? ""} disabled={disabled} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition as Extract<Draft["condition"], { kind: "email" }>, subject: e.target.value || undefined } })} />
          <div className="flex items-center justify-between gap-3"><Label htmlFor={`${fieldId}-unread`}>Unread messages only</Label><Switch id={`${fieldId}-unread`} checked={draft.condition.unreadOnly} disabled={disabled} onCheckedChange={(unreadOnly) => setDraft({ ...draft, condition: { ...draft.condition as Extract<Draft["condition"], { kind: "email" }>, unreadOnly } })} /></div>
        </> : <>
          <Label htmlFor={`${fieldId}-look-ahead`}>Look ahead (minutes)</Label>
          <Input id={`${fieldId}-look-ahead`} type="number" min={limits.lookAheadMinMinutes} max={limits.lookAheadMaxMinutes} value={draft.condition.lookAheadMinutes} disabled={disabled} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition as Extract<Draft["condition"], { kind: "calendar" }>, lookAheadMinutes: Number(e.target.value) } })} />
          <Label htmlFor={`${fieldId}-timezone`}>Time zone</Label>
          <Input id={`${fieldId}-timezone`} maxLength={limits.timezoneChars} value={draft.condition.timezone} disabled={disabled} onChange={(e) => setDraft({ ...draft, condition: { ...draft.condition as Extract<Draft["condition"], { kind: "calendar" }>, timezone: e.target.value } })} />
        </>}
        <Label htmlFor={`${fieldId}-interval`}>Check every</Label><Select value={String(draft.everyMinutes)} disabled={disabled} onValueChange={(value) => setDraft({ ...draft, everyMinutes: Number(value) as BotConnectorWatchInterval })}><SelectTrigger id={`${fieldId}-interval`}><SelectValue /></SelectTrigger><SelectContent>{(template?.intervals ?? [15, 30, 60]).map((minutes) => <SelectItem key={minutes} value={String(minutes)}>{minutes} minutes</SelectItem>)}</SelectContent></Select>
        <Text variant="small" color="tertiary">{draft.condition.kind === "calendar"
          ? "The first Calendar check can report events already in the upcoming window."
          : "The first successful Mail check records a baseline without waking the Bot."} Test check previews matching metadata without saving that baseline or running the Bot.</Text>
        <div className="flex flex-wrap gap-2"><Button size="small" disabled={disabled || !valid} onClick={save}>{draft.id ? "Save watch" : "Add watch"}</Button><Button size="small" variant="filled" disabled={disabled || (!draft.sourceChoiceId && !draft.id)} onClick={() => void readAction(() => api.testCheck(draft.sourceChoiceId ? { botId: bot.id, sourceChoiceId: draft.sourceChoiceId, condition: draft.condition } : { botId: bot.id, id: draft.id!, expectedRevision: draft.expectedRevision! }))}>{draft.id && !draft.sourceChoiceId ? "Test saved watch" : "Test check"}</Button><Button size="small" variant="transparent" disabled={disabled} onClick={() => { setDraft(null); setPreview(null); setConflict(null); }}>Cancel</Button></div>
      </div>
    </Field>}
    {preview && <Field orientation="vertical" label="Test check result" description={`${preview.itemCount} matching items · ${preview.changeCount} changes · ${preview.result}. No baseline saved and no Bot run started.`}><ul className="space-y-1 text-sm text-secondary">{preview.preview.map((label, index) => <li key={index}>{label}</li>)}</ul></Field>}
    {list?.supported && !draft && <Field label="Add a connected-app watch"><Button size="small" variant="filled" disabled={disabled || list.watches.length >= limits.watches} onClick={() => { setDraft(emptyDraft()); setSources(null); setPreview(null); setError(null); }}><Plus /> Add watch</Button></Field>}
  </FieldSet>;
}
