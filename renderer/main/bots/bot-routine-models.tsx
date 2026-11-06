import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotRoutineModelCatalog, BotRoutineModelChoice, BotRoutineModelSelection, BotRoutineModelSettings, BotRoutineThinkingLevel } from "../../shared/bot-routine-models";
import { BotModelPicker } from "./bot-model-picker";
import { useDiscardChangesGuard } from "./bot-page-shell";
import { clearRoutineModelAttempt, pendingRoutineModelChanges, recordRoutineModelAttempt, ROUTINE_MODEL_JOURNAL_EVENT, type PendingRoutineModelChange } from "./routine-model-journal";

export type BotRoutineModelApi = typeof botsApi.routineModels;
type Draft = { mode: "inherit" | "selected"; primary?: BotRoutineModelChoice; fallbackEnabled: boolean; fallback?: BotRoutineModelChoice };
const thinkingLabel: Record<BotRoutineThinkingLevel, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };
const settingsKey = (botId: string, routineId: string) => ["bot-routine-models", botId, routineId] as const;
const toDraft = (selection: BotRoutineModelSelection): Draft => selection.mode === "inherit" ? { mode: "inherit", fallbackEnabled: false } : { mode: "selected", primary: selection.primary, fallbackEnabled: Boolean(selection.fallback), fallback: selection.fallback };
function selected(draft: Draft): BotRoutineModelSelection | undefined {
  return draft.mode === "inherit" ? { mode: "inherit" } : draft.primary && (!draft.fallbackEnabled || draft.fallback) ? { mode: "selected", primary: draft.primary, ...(draft.fallbackEnabled ? { fallback: draft.fallback! } : {}) } : undefined;
}
function journal(botId: string, routineId: string) {
  try { return { rows: pendingRoutineModelChanges(botId, routineId), error: null as string | null }; }
  catch (error) { return { rows: [] as PendingRoutineModelChange[], error: userFacingErrorMessage(error, "This device couldn’t restore its saved model change.") }; }
}
function runTime(value: number, timezone?: string): string {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", ...(timezone ? { timeZone: timezone } : {}) }).format(value); }
  catch { return "Time unavailable"; }
}
function choiceOption(catalog: BotRoutineModelCatalog, choice?: BotRoutineModelChoice) {
  const provider = catalog.providers.find((entry) => entry.id === choice?.providerId);
  const model = provider?.models.find((entry) => entry.id === choice?.modelId);
  return provider && model ? { provider, model } : undefined;
}
function Choice({ label, choice, catalog, disabled, onChange }: { label: string; choice?: BotRoutineModelChoice; catalog: BotRoutineModelCatalog; disabled: boolean; onChange(choice: BotRoutineModelChoice): void }) {
  const option = choiceOption(catalog, choice), labelId = React.useId();
  return <>
    <Field orientation="vertical" label={label}>
      <BotModelPicker catalog={catalog} label={label} providerId={choice?.providerId} modelId={choice?.modelId} disabled={disabled} onSelect={(providerId, modelId) => {
        const option = choiceOption(catalog, { providerId, modelId, thinkingLevel: "off" });
        if (option) onChange({ providerId, modelId, thinkingLevel: option.model.thinkingLevels[0] ?? "off" });
      }} />
      {choice && (!option?.provider.available || !option.model.available) && <Text variant="small" color="tertiary">The saved {label.toLowerCase()} is unavailable. Choose an available model or inherit the Bot model.</Text>}
    </Field>
    {choice && <Field orientation="vertical" label={<label htmlFor={labelId}>{label} thinking</label>}>
      <Select value={choice.thinkingLevel} disabled={disabled || !option?.model.thinkingLevels.length} onValueChange={(thinkingLevel) => onChange({ ...choice, thinkingLevel: thinkingLevel as BotRoutineThinkingLevel })}>
        <SelectTrigger id={labelId}><SelectValue /></SelectTrigger><SelectContent>{Array.from(new Set([...(option?.model.thinkingLevels ?? []), choice.thinkingLevel])).map((level) => <SelectItem key={level} value={level} disabled={!option?.model.thinkingLevels.includes(level)}>{thinkingLabel[level]}</SelectItem>)}</SelectContent>
      </Select>
    </Field>}
  </>;
}
export function BotRoutineModelDialog({ botId, routineId, routineName, onClose, api = botsApi.routineModels }: {
  botId: string; routineId: string; routineName: string; onClose(): void; api?: BotRoutineModelApi;
}) {
  const qc = useQueryClient(), key = settingsKey(botId, routineId);
  const view = useQuery({ queryKey: key, queryFn: () => api.read(botId, routineId), refetchInterval: 15_000 });
  const catalog = useQuery({ queryKey: [...key, "catalog"], queryFn: () => api.catalog(botId, routineId) });
  const runs = useQuery({ queryKey: [...key, "runs"], queryFn: () => api.readRuns(botId, routineId), refetchInterval: 15_000 });
  const [pending, setPending] = React.useState(() => journal(botId, routineId));
  const [draft, setDraft] = React.useState<Draft | null>(() => pending.rows[0] ? toDraft(pending.rows[0].request.selection) : null);
  const [baseline, setBaseline] = React.useState<BotRoutineModelSettings | null>(null);
  const [conflict, setConflict] = React.useState<BotRoutineModelSettings | null>(null);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null), [message, setMessage] = React.useState<string | null>(null);
  const refreshPending = React.useCallback(() => setPending(journal(botId, routineId)), [botId, routineId]);
  React.useEffect(() => { window.addEventListener("storage", refreshPending); window.addEventListener(ROUTINE_MODEL_JOURNAL_EVENT, refreshPending); return () => { window.removeEventListener("storage", refreshPending); window.removeEventListener(ROUTINE_MODEL_JOURNAL_EVENT, refreshPending); }; }, [refreshPending]);
  React.useEffect(() => {
    if (!view.data) return;
    if (!baseline) { setBaseline(view.data); setDraft((current) => current ?? toDraft(view.data.selection)); }
    try {
      for (const row of pendingRoutineModelChanges(botId, routineId)) if (view.data.lastMutationId === row.request.mutationId) {
        clearRoutineModelAttempt(row, true); setDraft(toDraft(view.data.selection)); setBaseline(view.data); setConflict(null); setError(null); setMessage("The host confirmed the saved model change.");
      }
    } catch { refreshPending(); }
  }, [view.data, baseline, botId, routineId, refreshPending]);
  const selection = draft ? selected(draft) : undefined;
  const dirty = Boolean(selection && baseline && JSON.stringify(selection) !== JSON.stringify(baseline.selection));
  const guard = useDiscardChangesGuard({ dirty: dirty && pending.rows.length === 0, onLeave: onClose, description: "Your unsaved routine model choices will be discarded." });
  const disabled = busy || pending.rows.length > 0 || Boolean(pending.error);
  const usable = (choice?: BotRoutineModelChoice) => { const option = catalog.data && choiceOption(catalog.data, choice); return Boolean(option?.provider.available && option.model.available && choice && option.model.thinkingLevels.includes(choice.thinkingLevel)); };
  const valid = Boolean(selection && (selection.mode === "inherit" || usable(selection.primary) && (!selection.fallback || usable(selection.fallback))));
  const perform = async (request: PendingRoutineModelChange["request"], retry = false) => {
    if (busy) return;
    let attempt: PendingRoutineModelChange;
    try { attempt = recordRoutineModelAttempt(request, retry); }
    catch (error) { setError(userFacingErrorMessage(error, "This device couldn’t save the model change safely.")); refreshPending(); return; }
    const before = view.data; setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api.save(attempt.request);
      if (!result.ok) {
        if (result.code === "conflict" || result.code === "invalid") void catalog.refetch();
        if (result.code !== "unavailable") clearRoutineModelAttempt(attempt, false);
        if (result.code === "conflict" && result.settings) setConflict(result.settings);
        setError(result.error + (attempt.attempts > 1 || result.code === "unavailable" ? " The earlier outcome is unconfirmed. Retry the same saved request." : "")); return;
      }
      if (result.mutationId !== attempt.request.mutationId || result.settings.botId !== botId || result.settings.routineId !== routineId) throw new Error("The host returned a different model change identity.");
      clearRoutineModelAttempt(attempt, true);
      const current = qc.getQueryData<BotRoutineModelSettings>(key), latest = current && current !== before ? current : result.settings;
      if (current === before) { await qc.cancelQueries({ queryKey: key, exact: true }); qc.setQueryData(key, result.settings); }
      setBaseline(latest); setDraft(toDraft(latest.selection)); setConflict(null); setMessage("Routine model saved. Future runs use this choice.");
      void view.refetch();
    } catch (error) { setError(userFacingErrorMessage(error, "The model change’s outcome is unconfirmed. Retry the same saved request.")); }
    finally { setBusy(false); refreshPending(); }
  };
  return <><Dialog open confirmHidden title={`Model for ${routineName}`} onOpenChange={(open) => { if (!open) guard.requestLeave(); }}>
    {message && <Text variant="small" role="status">{message}</Text>}
    {(error || pending.error) && <Text variant="small" color="red" role="alert">{error ?? pending.error}</Text>}
    {pending.rows.map((row) => <Field key={row.request.mutationId} orientation="vertical" label="Saved change awaiting confirmation" description="The exact request is retained on this device. A matching host receipt is needed to confirm it."><Button size="small" variant="filled" disabled={busy} onClick={() => void perform(row.request, true)}>Retry saved request</Button></Field>)}
    {view.isError && !view.data ? <Field label="Routine model unavailable"><Button size="small" onClick={() => void view.refetch()}>Try again</Button></Field> : view.isPending || !draft ? <Text role="status">Loading routine model…</Text> : <FieldSet title="Routine model">
      <Field orientation="vertical" label="Model choice"><Select value={draft.mode} disabled={disabled} onValueChange={(mode) => setDraft({ ...draft, mode: mode as Draft["mode"] })}><SelectTrigger aria-label="Model choice"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">Inherit Bot model</SelectItem><SelectItem value="selected">Choose a routine model</SelectItem></SelectContent></Select></Field>
      {draft.mode === "inherit" ? <Field orientation="vertical"><Text variant="small" color="tertiary">Each new run keeps the Bot model and thinking chosen when that run is accepted.</Text></Field> : catalog.isPending ? <Field orientation="vertical"><Text role="status">Loading available models…</Text></Field> : catalog.isError || !catalog.data ? <Field label="Models unavailable"><Button size="small" onClick={() => void catalog.refetch()}>Try again</Button></Field> : <>
        <Choice label="Primary model" choice={draft.primary} catalog={catalog.data} disabled={disabled} onChange={(primary) => setDraft({ ...draft, primary })} />
        <Field label="Allow a fallback I choose" description="If the primary model is unavailable before work starts, the routine may use this exact fallback. Access changes and spending limits still stop the run."><Switch aria-label="Allow a fallback I choose" checked={draft.fallbackEnabled} disabled={disabled} onCheckedChange={(fallbackEnabled) => setDraft({ ...draft, fallbackEnabled })} /></Field>
        {draft.fallbackEnabled && <Choice label="Fallback model" choice={draft.fallback} catalog={catalog.data} disabled={disabled} onChange={(fallback) => setDraft({ ...draft, fallback })} />}
      </>}
      {conflict && <Field orientation="vertical" label="Changed on another device" description={`The saved choice is ${conflict.selection.mode === "inherit" ? "Inherit Bot model" : "a selected routine model"}. Review it before replacing it.`}><Button size="small" variant="filled" disabled={disabled} onClick={() => { setBaseline(conflict); setConflict(null); setError(null); }}>Use latest revision for my choices</Button></Field>}
      <Field orientation="vertical" description={draft.mode === "selected" ? "Saving grants this routine access to the chosen models under the Bot’s rules and spending limits." : undefined}>
        <Button disabled={disabled || !dirty || !valid || !catalog.data || Boolean(conflict)} onClick={() => { if (baseline && selection && catalog.data) void perform({ botId, routineId, mutationId: crypto.randomUUID(), expectedRevision: baseline.revision, catalogRevision: catalog.data.revision, selection }); }}>Save model</Button>
      </Field>
    </FieldSet>}
    <FieldSet title="Recent runs">{runs.isPending ? <Text role="status">Loading runs…</Text> : runs.isError ? <Field label="Run details unavailable"><Button size="small" onClick={() => void runs.refetch()}>Try again</Button></Field> : runs.data?.length ? runs.data.map((run) => <Field key={run.runId} orientation="vertical" label={`${run.startedAt === undefined ? "Selected" : "Used"} ${run.model.modelLabel}`} description={<><span>{run.model.providerLabel} · {thinkingLabel[run.model.actual.thinkingLevel]} thinking</span><span className="mt-1 block">Chosen {run.model.chosenModelLabel} · {run.model.chosenProviderLabel} · {thinkingLabel[run.model.chosen.thinkingLevel]} thinking</span><span className="mt-1 block">Accepted {runTime(run.admittedAt, run.timezone)}{run.startedAt === undefined ? " · Not started" : " · Started " + runTime(run.startedAt, run.timezone)}</span>{run.scheduledFor !== undefined && <span className="mt-1 block">Scheduled {runTime(run.scheduledFor, run.timezone)}{run.timezone ? " · " + run.timezone : ""}{run.startedAt !== undefined && run.startedAt - run.scheduledFor >= 60_000 ? ` · ${Math.floor((run.startedAt - run.scheduledFor) / 60_000)} min late` : ""}</span>}{run.model.fallbackReason && <span className="mt-1 block">Configured fallback used because the primary {run.model.fallbackReason === "model_unavailable" ? "model was" : "credentials were"} unavailable.</span>}</>} />) : <Field orientation="vertical"><Text variant="small" color="tertiary">No runs with model details yet.</Text></Field>}</FieldSet>
  </Dialog>{guard.dialog}</>;
}
export function BotRoutineModelButton({ botId, routineId, routineName, disabled = false }: { botId: string; routineId: string; routineName: string; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  return <><Button size="small" variant="transparent" aria-label={`Model for ${routineName}`} disabled={disabled} onClick={() => setOpen(true)}>Model</Button>{open && <BotRoutineModelDialog botId={botId} routineId={routineId} routineName={routineName} onClose={() => setOpen(false)} />}</>;
}
