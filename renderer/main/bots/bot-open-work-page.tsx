import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, ListTodo, Pencil, Plus } from "lucide-react";
import { Button, Dialog, Field, FieldSet, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, Textarea } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { botChatPath } from "../../lib/bot-routes";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { BOT_OPEN_WORK_LIMITS as limits, parseBotOpenWorkMutation, type BotOpenWorkItem, type BotOpenWorkMutation, type BotOpenWorkSnapshot, type BotOpenWorkState } from "../../shared/bot-open-work";
import type { BotDefinition } from "../../shared/bots";
import { BotPageShell, BotPageSkeleton, useDiscardChangesGuard } from "./bot-page-shell";
import { botOpenWorkKey, useBotOpenWork, type BotOpenWorkApi } from "./use-bot-open-work";
import { clearOpenWorkPending, OPEN_WORK_JOURNAL_EVENT, pendingOpenWork, recordOpenWorkAttempt, settleOpenWorkPending, type PendingOpenWork } from "./open-work-journal";
import { useQuery } from "@tanstack/react-query";
import { BotPeerExchangeButton } from "./bot-peers";

type Draft = { id?: string; revision: string; title: string; note: string; state: BotOpenWorkState; waitingReason: string };
type WorkAction<T = BotOpenWorkMutation> = T extends BotOpenWorkMutation ? Omit<T, "mutationId"> : never;
const STATE_LABELS: Record<BotOpenWorkState, string> = { open: "Open", waiting: "Waiting", done: "Done", dismissed: "Dismissed" };
const PENDING_STOP = new Set(["requested", "uncertain"]);

/** Enforce the shared limits without splitting a Unicode scalar while editing. */
function entryText(value: string, scalars: number, bytes: number): string {
  let result = ""; let used = 0; let count = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).byteLength;
    if (++count > scalars || used + size > bytes) break;
    result += character; used += size;
  }
  return result;
}
function draftOf(item: BotOpenWorkItem): Draft {
  return { id: item.id, revision: item.revision, title: item.title, note: item.note, state: item.state, waitingReason: item.waitingReason ?? "" };
}
function restoredDraft(request: PendingOpenWork | undefined): Draft | null {
  const mutation = request?.mutation;
  if (mutation?.action === "add") return { revision: mutation.expectedRevision, title: mutation.title, note: mutation.note ?? "", state: "open", waitingReason: "" };
  if (mutation?.action === "edit") return { id: mutation.id, revision: mutation.expectedRevision, title: mutation.patch.title ?? "", note: mutation.patch.note ?? "", state: mutation.patch.state ?? "open", waitingReason: mutation.patch.waitingReason ?? "" };
  return null;
}
function journal(botId: string): { requests: PendingOpenWork[]; error: string | null } {
  try { return { requests: pendingOpenWork(botId), error: null }; }
  catch (error) { return { requests: [], error: userFacingErrorMessage(error, "Aiden couldn’t restore this device’s saved change.") }; }
}

function WorkEditor({ draft, disabled, saveDisabled, onChange, onSave, onCancel }: {
  draft: Draft; disabled: boolean; saveDisabled: boolean; onChange(draft: Draft): void; onSave(): void; onCancel(): void;
}) {
  const stateId = React.useId();
  const valid = Boolean(draft.title.trim()) && (draft.state !== "waiting" || Boolean(draft.waitingReason.trim()));
  return <FieldSet title={draft.id ? "Edit work" : "Add work"}>
    <Field orientation="vertical" label="Title">
      <Input aria-label="Work title" value={draft.title} disabled={disabled} onChange={(event) => onChange({ ...draft, title: entryText(event.target.value, limits.titleScalars, limits.titleBytes) })} />
    </Field>
    <Field orientation="vertical" label="Notes">
      <Textarea aria-label="Work notes" value={draft.note} disabled={disabled} onChange={(event) => onChange({ ...draft, note: entryText(event.target.value, limits.noteScalars, limits.noteBytes) })} />
    </Field>
    {draft.id && <Field orientation="vertical" label={<Label htmlFor={stateId}>State</Label>}>
      <Select value={draft.state} disabled={disabled} onValueChange={(state) => onChange({ ...draft, state: state as BotOpenWorkState, waitingReason: state === "waiting" ? draft.waitingReason : "" })}>
        <SelectTrigger id={stateId}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(STATE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
      </Select>
      {draft.state === "waiting" && <Input aria-label="Waiting reason" placeholder="What is this waiting for?" value={draft.waitingReason} disabled={disabled} onChange={(event) => onChange({ ...draft, waitingReason: entryText(event.target.value, limits.waitingReasonScalars, limits.waitingReasonBytes) })} />}
    </Field>}
    <Field label={draft.id ? "Save these changes" : "Keep this for the Bot’s next turn"}>
      <div className="flex flex-wrap gap-2"><Button size="small" disabled={disabled || saveDisabled || !valid} onClick={onSave}>{draft.id ? "Save work" : "Add work"}</Button><Button size="small" variant="transparent" disabled={disabled} onClick={onCancel}>Cancel</Button></div>
    </Field>
  </FieldSet>;
}

function WorkRow({ item, botId, botName, disabled, undo, onEdit, onAction, onEvidence }: {
  item: BotOpenWorkItem; botId: string; botName: string; disabled: boolean; undo?: BotOpenWorkSnapshot["undo"][number];
  onEdit(): void; onAction(mutation: WorkAction): void; onEvidence(kind: "source" | "result"): void;
}) {
  const pendingStop = item.execution.state === "stopping" || Boolean(item.lastStop && PENDING_STOP.has(item.lastStop.state));
  const itemDisabled = disabled || pendingStop;
  const active = item.state === "open" || item.state === "waiting";
  const live = item.execution.state !== "idle";
  const status = item.execution.state === "running" ? "Running" : item.execution.state === "queued" ? "Queued"
    : item.execution.state === "stopping" ? "Waiting for Stop acknowledgement" : item.execution.state === "interrupted" ? "Interrupted" : null;
  const identity = { id: item.id, expectedRevision: item.revision };
  return <Field orientation="vertical" label={item.title} description={<>
    <span>{STATE_LABELS[item.state]}{item.waitingReason ? " · " + item.waitingReason : ""}{status ? " · " + status : ""}</span>
    {item.note && <span className="mt-1 block whitespace-pre-wrap break-words">{item.note}</span>}
    <span className="mt-1 block">{item.source.kind === "peer" ? item.source.role === "incoming" ? "From a Bot exchange" : "Waiting on a Bot exchange" : item.source.kind === "routine" ? "From an accepted routine" : item.source.submissionId ? "From your request" : "Added here"}</span>
    {item.completion && <span className="mt-1 block">Marked done by {item.completion.by === "person" ? "you" : botName}{item.completion.result ? " · Supporting reply available" : ""}</span>}
  </>}>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="small" variant="transparent" aria-label={"Edit work " + item.title} disabled={itemDisabled} onClick={onEdit}><Pencil /> Edit</Button>
      <Button size="small" variant="transparent" disabled={itemDisabled} onClick={() => onAction({ action: "edit", ...identity, patch: { state: item.state === "done" || item.state === "dismissed" ? "open" : "done" } })}>{active ? "Mark done" : "Reopen"}</Button>
      {active && <Button size="small" variant="transparent" disabled={itemDisabled} onClick={() => onAction({ action: "dismiss", ...identity })}>{live ? "Dismiss without stopping" : "Dismiss"}</Button>}
      {item.execution.canStop && <><Button size="small" variant="filled" disabled={itemDisabled} onClick={() => onAction({ action: "stop", ...identity })}>Stop linked run</Button><Button size="small" variant="transparent" disabled={itemDisabled} onClick={() => onAction({ action: "stop_and_dismiss", ...identity })}>Stop and dismiss</Button></>}
      {undo && <Button size="small" variant="transparent" disabled={itemDisabled} aria-label={"Undo last change to " + item.title} onClick={() => onAction({ action: "undo", undoOf: undo.mutationId, expectedRevision: undo.expectedRevision })}>Undo last change</Button>}
      {item.links.some((link) => link.kind === "source") && <Button size="small" variant="transparent" onClick={() => onEvidence("source")}>View request</Button>}
      {item.links.some((link) => link.kind === "result") && <Button size="small" variant="transparent" onClick={() => onEvidence("result")}>View reply</Button>}
      {[...new Set([...(item.source.kind === "peer" ? [item.source.exchangeId] : []), ...item.links.flatMap((link) => link.kind === "peer" ? [link.exchangeId] : [])])].map((exchangeId) => <BotPeerExchangeButton key={exchangeId} botId={botId} exchangeId={exchangeId} />)}
    </div>
    {item.execution.blockedReason === "mixed_inputs" && <Text variant="small" color="tertiary">This run includes another input, so its work cannot be stopped separately here.</Text>}
    {item.lastStop && PENDING_STOP.has(item.lastStop.state) && <Text variant="small" color="tertiary">Stop is awaiting acknowledgement. Work stays unfinished until the computer confirms what stopped.</Text>}
  </Field>;
}

function Evidence({ botId, selection, api, onClose }: {
  botId: string; selection: { id: string; kind: "source" | "result" } | null; api: BotOpenWorkApi; onClose(): void;
}) {
  const result = useQuery({
    queryKey: [...botOpenWorkKey(botId), "evidence", selection?.id, selection?.kind],
    queryFn: () => api.evidence(botId, selection!.id, selection!.kind),
    enabled: selection !== null,
  });
  return <Dialog open={selection !== null} confirmHidden title={result.data?.title ?? (selection?.kind === "result" ? "Supporting reply" : "Original request")} onOpenChange={(open) => { if (!open) onClose(); }}>
    {result.isPending ? <Text role="status">Loading…</Text> : result.isError ? <div role="alert"><Text>Aiden couldn’t load this entry.</Text><Button size="small" variant="filled" onClick={() => void result.refetch()}>Try again</Button></div> : result.data
      ? <><Text as="p" className="whitespace-pre-wrap break-words">{result.data.text || "This entry has no text."}</Text>{result.data.truncated && <Text variant="small" color="tertiary">An excerpt of the original entry is shown.</Text>}</>
      : <Text>This entry is no longer available.</Text>}
  </Dialog>;
}

function OpenWorkBody({ bot, api, onDirtyChange }: { bot: Pick<BotDefinition, "id" | "name">; api: BotOpenWorkApi; onDirtyChange?(dirty: boolean): void }) {
  const view = useBotOpenWork(bot.id, api);
  const [saved, setSaved] = React.useState(() => journal(bot.id));
  const [draft, setDraft] = React.useState<Draft | null>(() => restoredDraft(saved.requests[0]));
  const draftRequest = React.useRef(draft ? saved.requests[0]?.mutation.mutationId : undefined);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<BotOpenWorkSnapshot | null>(null);
  const [history, setHistory] = React.useState(false);
  const [evidence, setEvidence] = React.useState<{ id: string; kind: "source" | "result" } | null>(null);
  const reloadJournal = React.useCallback(() => setSaved(journal(bot.id)), [bot.id]);
  React.useEffect(() => {
    window.addEventListener("storage", reloadJournal); window.addEventListener(OPEN_WORK_JOURNAL_EVENT, reloadJournal);
    return () => { window.removeEventListener("storage", reloadJournal); window.removeEventListener(OPEN_WORK_JOURNAL_EVENT, reloadJournal); };
  }, [reloadJournal]);
  React.useEffect(() => {
    if (!view.data) return;
    try {
      const resolved = settleOpenWorkPending(view.data);
      if (resolved.length) {
        setError(null); setMessage("The computer confirmed the saved change.");
        if (draftRequest.current && resolved.includes(draftRequest.current)) {
          draftRequest.current = undefined; setDraft(null); setConflict(null);
        }
      }
    } catch { reloadJournal(); }
  }, [view.data, reloadJournal]);
  const disabled = busy || saved.requests.length > 0 || Boolean(saved.error);
  const original = draft?.id ? view.data?.items.find((item) => item.id === draft.id) : undefined;
  const editingStop = original?.execution.state === "stopping" || Boolean(original?.lastStop && PENDING_STOP.has(original.lastStop.state));
  const dirty = Boolean(draft && (original ? draft.title !== original.title || draft.note !== original.note || draft.state !== original.state || draft.waitingReason !== (original.waitingReason ?? "") : draft.title || draft.note));
  React.useEffect(() => onDirtyChange?.(dirty && !saved.requests.length), [dirty, onDirtyChange, saved.requests.length]);

  const perform = async (candidate: BotOpenWorkMutation, retry = false) => {
    if (busy) return;
    const targetId = "id" in candidate ? candidate.id : candidate.action === "undo" ? view.data?.undo.find((option) => option.mutationId === candidate.undoOf)?.itemId : undefined;
    const target = view.data?.items.find((item) => item.id === targetId);
    if (!retry && target && (target.execution.state === "stopping" || target.lastStop && PENDING_STOP.has(target.lastStop.state))) {
      setError("This item is waiting for Stop acknowledgement. Review its state after the computer confirms it."); return;
    }
    let request: PendingOpenWork;
    try { request = recordOpenWorkAttempt(bot.id, candidate, retry); }
    catch (caught) { setError(userFacingErrorMessage(caught, "This device couldn’t save the change safely.")); reloadJournal(); return; }
    setBusy(true); setError(null); setMessage(null);
    const before = view.data;
    if (draft && (candidate.action === "add" || candidate.action === "edit")) draftRequest.current = candidate.mutationId;
    try {
      const result = await api.mutate(bot.id, request.mutation);
      if (result.ok && (result.mutationId !== request.mutation.mutationId || result.snapshot.botId !== bot.id)) throw new Error("The computer returned a different change identity.");
      if (result.snapshot) view.adopt(result.snapshot, before);
      if (!result.ok) {
        if (result.code !== "unavailable") clearOpenWorkPending(request, false);
        setError(request.attempts > 1 || result.code === "unavailable" ? result.error + " The earlier outcome is still unconfirmed; retry the same saved request." : result.error);
        if (["stale", "undo_conflict"].includes(result.code) && result.snapshot) setConflict(result.snapshot);
        return;
      }
      const isStop = request.mutation.action === "stop" || request.mutation.action === "stop_and_dismiss";
      if (isStop && (!result.stop || result.stop.mutationId !== request.mutation.mutationId)) throw new Error("Stop is awaiting acknowledgement. Check the same request to confirm it.");
      const awaitingStop = isStop && result.stop && PENDING_STOP.has(result.stop.state);
      if (!awaitingStop) clearOpenWorkPending(request, true);
      setMessage(awaitingStop ? "Stop is awaiting acknowledgement. Check the same request to confirm it." : result.stop
        ? result.stop.state === "blocked" ? "The linked run could not be stopped separately." : "The computer confirmed the linked run’s state."
        : "Change saved.");
      if (!awaitingStop) { draftRequest.current = undefined; setDraft(null); setConflict(null); }
      void view.refetch();
    } catch (caught) { setError(userFacingErrorMessage(caught, "The change’s outcome is unconfirmed. Retry the same saved request.")); }
    finally { setBusy(false); reloadJournal(); }
  };
  const action = (input: WorkAction) => {
    try { void perform(parseBotOpenWorkMutation({ ...input, mutationId: crypto.randomUUID() })); }
    catch (caught) { setError(userFacingErrorMessage(caught, "Check the work details.")); }
  };
  const save = () => {
    if (!draft) return;
    action(draft.id ? { action: "edit", id: draft.id, expectedRevision: draft.revision, patch: { title: draft.title, note: draft.note, ...(draft.state !== original?.state ? { state: draft.state } : {}), ...(draft.state === "waiting" ? { waitingReason: draft.waitingReason } : {}) } }
      : { action: "add", expectedRevision: draft.revision, title: draft.title, note: draft.note });
  };
  const review = () => {
    if (!draft || !conflict) return;
    const current = draft.id ? conflict.items.find((item) => item.id === draft.id) : null;
    if (draft.id && !current) { setError("This item was removed. Keep your draft notes before closing it."); return; }
    setDraft({ ...draft, revision: current?.revision ?? conflict.revision }); setConflict(null); setError(null);
  };

  if (view.isPending) return <BotPageSkeleton label="Loading Open work" groups={[2]} />;
  if (view.isError && !view.data) return <FieldSet title="Open work unavailable"><Field label="Aiden couldn’t load this Bot’s work" description="Check the computer that runs this Bot, then try again."><Button size="small" variant="filled" onClick={() => void view.refetch()}>Try again</Button></Field></FieldSet>;
  const snapshot = view.data!;
  const active = snapshot.items.filter((item) => item.state === "open" || item.state === "waiting");
  const closed = snapshot.items.filter((item) => item.state === "done" || item.state === "dismissed");
  return <>
    {(error || saved.error) && <Text as="p" role="alert" color="red">{error ?? saved.error}</Text>}
    {message && <Text as="p" role="status" color="secondary">{message}</Text>}
    {saved.requests.map((request) => <FieldSet key={request.mutation.mutationId} title="Change waiting for confirmation"><Field label={request.mutation.action === "add" ? request.mutation.title : "Saved " + request.mutation.action.split("_").join(" ") + " change"} description="The saved identity is retained on this device. A retry checks that same change."><Button size="small" disabled={busy || Boolean(saved.error)} onClick={() => void perform(request.mutation, true)}>Retry same request</Button></Field></FieldSet>)}
    {conflict && <FieldSet title="Work changed elsewhere"><Field label="Review the current version" description="Your draft is kept. Saving again will use the newer version only after you choose to continue."><Button size="small" variant="filled" disabled={disabled} onClick={review}>Keep my edits against this version</Button></Field></FieldSet>}
    {draft && <WorkEditor draft={draft} disabled={disabled} saveDisabled={!dirty || Boolean(conflict) || editingStop} onChange={setDraft} onSave={save} onCancel={() => { setDraft(null); setConflict(null); }} />}
    <FieldSet title="Open work">
      {!active.length && <Field label="No open work" description={bot.name + " keeps the tasks it accepts here. You can edit, dismiss or undo changes."} />}
      {active.map((item) => <WorkRow key={item.id} item={item} botId={bot.id} botName={bot.name} disabled={disabled || draft !== null} undo={snapshot.undo.find((option) => option.itemId === item.id)} onEdit={() => { setDraft(draftOf(item)); setConflict(null); }} onAction={action} onEvidence={(kind) => setEvidence({ id: item.id, kind })} />)}
      {!draft && <Field label="Add a responsibility"><Button size="small" variant="filled" disabled={disabled || active.length >= limits.active} onClick={() => { setDraft({ revision: snapshot.revision, title: "", note: "", state: "open", waitingReason: "" }); setError(null); }}><Plus /> Add work</Button></Field>}
    </FieldSet>
    {closed.length > 0 && <><Button size="small" variant="transparent" aria-expanded={history} onClick={() => setHistory(!history)}>{history ? "Hide history" : "History (" + closed.length + ")"}</Button>{history && <FieldSet title="History">{closed.map((item) => <WorkRow key={item.id} item={item} botId={bot.id} botName={bot.name} disabled={disabled || draft !== null} undo={snapshot.undo.find((option) => option.itemId === item.id)} onEdit={() => { setDraft(draftOf(item)); setConflict(null); }} onAction={action} onEvidence={(kind) => setEvidence({ id: item.id, kind })} />)}</FieldSet>}</>}
    <Evidence botId={bot.id} selection={evidence} api={api} onClose={() => setEvidence(null)} />
  </>;
}

export function BotOpenWorkContent({ bot, api = botsApi.openWork, onDirtyChange }: { bot: Pick<BotDefinition, "id" | "name">; api?: BotOpenWorkApi; onDirtyChange?(dirty: boolean): void }) {
  return <OpenWorkBody key={bot.id} bot={bot} api={api} onDirtyChange={onDirtyChange} />;
}

export function BotOpenWorkPage({ bot, onClose }: { bot: BotDefinition; onClose(): void }) {
  const [dirty, setDirty] = React.useState(false);
  const guard = useDiscardChangesGuard({ dirty, onLeave: onClose, description: "Your unsaved Open work edits will be discarded." });
  return <BotPageShell scrollId={"bot-open-work:" + bot.id} title="Open work" backLabel={bot.name} onBack={guard.requestLeave}><BotOpenWorkContent key={bot.id} bot={bot} onDirtyChange={setDirty} />{guard.dialog}</BotPageShell>;
}

/** Compact entry for the Advanced tab and the Bot’s Activity tab. */
export function BotOpenWorkRow({ botId, onOpen, compact = false }: { botId: string; onOpen(): void; compact?: boolean }) {
  const view = useBotOpenWork(botId);
  const count = view.data?.items.filter((item) => item.state === "open" || item.state === "waiting").length;
  return <Button variant="transparent" onClick={onOpen} className={compact ? "w-full justify-start" : "settings-field h-auto min-h-16 w-full justify-start gap-3 p-4 text-left"}>
    <ListTodo aria-hidden="true" className="size-4 shrink-0 text-secondary" /><span className="min-w-0 flex-1 text-strong">Open work</span>
    <span className="text-small text-secondary">{view.isError ? "Unavailable" : count === undefined ? "Loading…" : String(count)}</span><ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
  </Button>;
}

export function BotOpenWorkPanelRow({ botId }: { botId: string }) {
  const navigate = useNavigate();
  return <BotOpenWorkRow compact botId={botId} onOpen={() => void navigate({ ...botChatPath(botId), to: "/bots/$botId", search: { page: "open-work" } })} />;
}
