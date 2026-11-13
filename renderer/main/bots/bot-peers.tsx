import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text, Textarea } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import type { createBotPeerApi } from "../../lib/bot-peers-api";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { BotPeerEvidence, BotPeerExchangeState, BotPeerMutation, BotPeerSettings, BotPeerStopMutation, BotPeerStopReceipt } from "../../shared/bot-peers";
import { BOT_PEER_JOURNAL_EVENT, clearBotPeerAttempt, pendingBotPeerChanges, recordBotPeerAttempt, settleBotPeerSettings, settleBotPeerStop, type BotPeerAttempt } from "./bot-peer-journal";
import { useDiscardChangesGuard } from "./bot-page-shell";

export type BotPeerApi = ReturnType<typeof createBotPeerApi> & { onChanged?(listener: (botId: string) => void): () => void };
const settingsKey = (botId: string) => ["bot-peers", botId, "settings"] as const;
const detailKey = (botId: string, exchangeId: string) => ["bot-peers", botId, "exchange", exchangeId] as const;
const errorText = (error: unknown) => userFacingErrorMessage(error, "The request’s outcome is unconfirmed. Keep and retry the saved request.");
const stateLabel: Record<BotPeerExchangeState, string> = { waiting: "Waiting", queued: "Queued", running: "Working", interrupted: "Interrupted", stopping: "Stop awaiting acknowledgement", completed: "Completed", failed: "Failed", cancelled: "Cancelled", expired: "Expired", uncertain: "Outcome unconfirmed" };
const returnLabel = { reserved: "Return will follow", waiting: "Return waiting", queued: "Return queued", delivered: "Return delivered", not_applicable: "No reply expected" };
function stopOutcome(receipt: BotPeerStopReceipt): string {
  if (receipt.state === "stopped") return "The host confirmed the linked work stopped.";
  if (receipt.state === "not_running") return "The host confirmed this exchange has no running work.";
  if (receipt.state === "blocked") return receipt.reason === "mixed_inputs" ? "The host refused Stop because this run includes other inputs." : "The host could not stop the linked work.";
  return "Stop is awaiting the host’s acknowledgement.";
}
function readPending(botId: string) {
  try { return { rows: pendingBotPeerChanges(botId), error: null as string | null }; }
  catch (error) { return { rows: [] as BotPeerAttempt[], error: errorText(error) }; }
}
function usePeerControls(botId: string, api: BotPeerApi) {
  const qc = useQueryClient();
  const [pending, setPending] = React.useState(() => readPending(botId));
  const alive = React.useRef(true), busyRef = React.useRef(false), [busy, setBusy] = React.useState(false);
  const refresh = React.useCallback(() => { if (alive.current) setPending(readPending(botId)); }, [botId]);
  React.useEffect(() => {
    alive.current = true;
    window.addEventListener("storage", refresh); window.addEventListener(BOT_PEER_JOURNAL_EVENT, refresh);
    return () => { alive.current = false; window.removeEventListener("storage", refresh); window.removeEventListener(BOT_PEER_JOURNAL_EVENT, refresh); };
  }, [refresh]);
  React.useEffect(() => api.onChanged?.((changed) => { if (changed === botId) void qc.invalidateQueries({ queryKey: ["bot-peers", botId] }); }), [api, botId, qc]);
  return { pending, alive, busy, refresh, begin: () => { if (!alive.current || busyRef.current) return false; busyRef.current = true; setBusy(true); return true; }, end: () => { busyRef.current = false; if (alive.current) { setBusy(false); refresh(); } } };
}

export function BotPeerManagerDialog({ botId, botName, onClose, api = botsApi.peers }: { botId: string; botName: string; onClose(): void; api?: BotPeerApi }) {
  const qc = useQueryClient(), controls = usePeerControls(botId, api);
  const view = useQuery({ queryKey: settingsKey(botId), queryFn: () => api.settings(botId), refetchInterval: 15_000 });
  const settings = view.data;
  const catalog = useQuery({ queryKey: ["bot-peers", botId, "catalog"], queryFn: () => api.catalog(botId) });
  const exchanges = useQuery({ queryKey: ["bot-peers", botId, "exchanges"], queryFn: () => api.exchanges(botId), refetchInterval: 15_000 });
  const saved = controls.pending.rows.filter((row) => row.kind === "settings");
  const initial = saved.find((row) => row.request.action === "describe");
  const [draft, setDraft] = React.useState<string | null>(() => initial?.request.action === "describe" ? initial.request.routingDescription : null);
  const [baseline, setBaseline] = React.useState<BotPeerSettings | null>(null), [conflict, setConflict] = React.useState<BotPeerSettings | null>(null);
  const [candidate, setCandidate] = React.useState(""), [error, setError] = React.useState<string | null>(null), [message, setMessage] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState<{ request: BotPeerMutation; name: string } | null>(null), [exchangeId, setExchangeId] = React.useState<string | null>(null);
  const acceptSettings = React.useCallback((latest: BotPeerSettings, descriptionSaved: boolean) => {
    const overlappingDescription = !descriptionSaved && baseline !== null && draft !== null && draft !== baseline.routingDescription && latest.routingDescription !== baseline.routingDescription;
    if (!overlappingDescription) setBaseline(latest);
    setDraft((value) => descriptionSaved || value === null || value === baseline?.routingDescription ? latest.routingDescription : value);
    setConflict(overlappingDescription ? latest : null);
  }, [baseline, draft]);
  React.useEffect(() => {
    if (!settings) return;
    if (!baseline) { setBaseline(settings); setDraft((value) => value ?? settings.routingDescription); }
    try {
      const confirmed = pendingBotPeerChanges(botId).find((row) => row.kind === "settings" && row.request.mutationId === settings.lastMutationId);
      if (settleBotPeerSettings(settings)) {
        acceptSettings(settings, confirmed?.kind === "settings" && confirmed.request.action === "describe");
        setMessage("The host confirmed the saved change.");
      }
    }
    catch { controls.refresh(); }
  }, [settings, baseline, botId, controls.refresh, acceptSettings]);
  const disabled = controls.busy || saved.length > 0 || Boolean(controls.pending.error);
  const dirty = draft !== null && baseline !== null && draft !== baseline.routingDescription;
  const guard = useDiscardChangesGuard({ dirty: dirty && saved.length === 0, onLeave: onClose, description: "Your unsaved Bot routing description will be discarded." });
  const perform = async (request: BotPeerMutation, retry = false) => {
    if (!controls.begin()) return;
    setError(null); setMessage(null);
    try {
      const attempt = recordBotPeerAttempt({ kind: "settings", request }, { retry });
      const result = await api.mutate(attempt.request as BotPeerMutation);
      if (!result.ok) {
        if (result.code !== "unavailable") clearBotPeerAttempt(attempt, false);
        if (controls.alive.current) {
          if (result.code === "conflict" && result.snapshot) setConflict(result.snapshot);
          setError(result.error + (retry || result.code === "unavailable" ? " The saved request remains unconfirmed." : ""));
          void catalog.refetch();
        }
        return;
      }
      clearBotPeerAttempt(attempt, true);
      if (controls.alive.current) {
        await qc.invalidateQueries({ queryKey: ["bot-peers", botId] });
        if (!controls.alive.current) return;
        const latest = qc.getQueryData<BotPeerSettings>(settingsKey(botId)) ?? result.snapshot;
        acceptSettings(latest, request.action === "describe"); setCandidate(""); setMessage("Bot messaging settings saved.");
      }
    } catch (error) { if (controls.alive.current) setError(errorText(error)); }
    finally { controls.end(); }
  };
  const available = catalog.data?.bots.filter((bot) => bot.botId !== botId && !settings?.pairs.some((pair) => pair.peer.botId === bot.botId)) ?? [];
  const chosen = available.find((bot) => bot.botId === candidate && bot.available);
  return <><Dialog open confirmHidden title={`Bot messaging · ${botName}`} onOpenChange={(open) => { if (!open) guard.requestLeave(); }}>
    <Text variant="small" color="secondary">Approve named Bot pairs to let them exchange requests in both directions. Each Bot keeps its own model, access, rules and spending limits.</Text>
    {(error || controls.pending.error) && <Text role="alert" variant="small" color="red">{error ?? controls.pending.error}</Text>}
    {message && <Text role="status" variant="small">{message}</Text>}
    {saved.map((row) => <Field key={row.request.mutationId} orientation="vertical" label="Saved change awaiting confirmation" description="Keep the original request until the host confirms its outcome."><Button size="small" disabled={controls.busy} onClick={() => void perform(row.request as BotPeerMutation, true)}>Retry saved change</Button></Field>)}
    {view.isError && !settings ? <Field label="Bot messaging unavailable"><Button size="small" onClick={() => void view.refetch()}>Try again</Button></Field> : !settings || draft === null ? <Text role="status">Loading Bot messaging…</Text> : <>
      <FieldSet title="Routing description">
        <Field orientation="vertical" label="When other Bots should ask me" description="A short description of this Bot’s role. This helps route requests; it grants no access."><Textarea aria-label="When other Bots should ask me" value={draft} maxLength={1000} disabled={disabled} onChange={(event) => setDraft(event.target.value)} /></Field>
        {conflict && <Field orientation="vertical" label="Changed on another device" description={conflict.routingDescription || "The host has a newer version of these settings."}><Button size="small" disabled={disabled} onClick={() => { setBaseline(conflict); setConflict(null); setError(null); }}>Use latest revision for my description</Button></Field>}
        <Field><Button size="small" disabled={disabled || !dirty || Boolean(conflict)} onClick={() => { if (baseline) void perform({ action: "describe", botId, mutationId: crypto.randomUUID(), expectedRevision: baseline.revision, routingDescription: draft }); }}>Save description</Button></Field>
      </FieldSet>
      <FieldSet title="Approved pairs">
        {settings.pairs.length ? settings.pairs.map((pair) => <Field key={pair.id} label={pair.peer.name} description={`${botName} and ${pair.peer.name} can message each other.`}><Button size="small" variant="transparent" disabled={disabled} aria-label={`Revoke pair with ${pair.peer.name}`} onClick={() => setConfirmation({ name: pair.peer.name, request: { action: "revoke", botId, mutationId: crypto.randomUUID(), expectedRevision: settings.revision, pairId: pair.id, pairRevision: pair.revision } })}>Revoke</Button></Field>) : <Field orientation="vertical"><Text variant="small" color="tertiary">No Bot pairs approved.</Text></Field>}
        <Field orientation="vertical" label="Add a Bot pair">
          {catalog.isError ? <Button size="small" onClick={() => void catalog.refetch()}>Reload Bots</Button> : <Select value={candidate} disabled={disabled || catalog.isPending || !available.length} onValueChange={setCandidate}><SelectTrigger aria-label="Bot to approve"><SelectValue placeholder="Choose a Bot" /></SelectTrigger><SelectContent>{available.map((bot) => <SelectItem key={bot.botId} value={bot.botId} disabled={!bot.available}>{bot.name}{!bot.available ? " · Unavailable" : ""}</SelectItem>)}</SelectContent></Select>}
          <Button size="small" disabled={disabled || !chosen || !catalog.data} onClick={() => { if (chosen && catalog.data) setConfirmation({ name: chosen.name, request: { action: "approve", botId, mutationId: crypto.randomUUID(), expectedRevision: settings.revision, catalogRevision: catalog.data.revision, peerBotId: chosen.botId } }); }}>Review pair</Button>
        </Field>
      </FieldSet>
    </>}
    <FieldSet title="Exchanges">{exchanges.isPending ? <Text role="status">Loading exchanges…</Text> : exchanges.isError ? <Field label="Exchanges unavailable"><Button size="small" onClick={() => void exchanges.refetch()}>Try again</Button></Field> : exchanges.data?.exchanges.length ? exchanges.data.exchanges.map((exchange) => <Field key={exchange.id} orientation="vertical" label={exchange.title} description={`${exchange.direction === "sent" ? "To " + exchange.recipient.name : "From " + exchange.sender.name} · ${stateLabel[exchange.state]}`}><Button size="small" variant="transparent" onClick={() => setExchangeId(exchange.id)}>View exchange</Button></Field>) : <Text variant="small" color="tertiary">No exchanges yet.</Text>}</FieldSet>
  </Dialog>
  {confirmation && <Dialog open confirmHidden title={confirmation.request.action === "approve" ? "Approve Bot pair" : "Revoke Bot pair"} onOpenChange={(open) => { if (!open) setConfirmation(null); }}><Text>{botName} ↔ {confirmation.name}</Text><Text variant="small" color="secondary">{confirmation.request.action === "approve" ? "Both Bots may send requests to each other. Each recipient keeps its own access and rules." : "This removes the pair’s permission to exchange requests. A Stop acknowledgement is still needed to confirm cancellation of work already running."}</Text><Button disabled={disabled} onClick={() => { const request = confirmation.request; setConfirmation(null); void perform(request); }}>{confirmation.request.action === "approve" ? "Approve both directions" : "Revoke pair"}</Button></Dialog>}
  {exchangeId && <BotPeerExchangeDialog key={exchangeId} botId={botId} exchangeId={exchangeId} onClose={() => setExchangeId(null)} api={api} />}
  {guard.dialog}</>;
}

export function BotPeerExchangeDialog({ botId, exchangeId, onClose, api = botsApi.peers }: { botId: string; exchangeId: string; onClose(): void; api?: BotPeerApi }) {
  const qc = useQueryClient(), controls = usePeerControls(botId, api);
  const view = useQuery({ queryKey: detailKey(botId, exchangeId), queryFn: () => api.exchange(botId, exchangeId), refetchInterval: 5_000 });
  const [error, setError] = React.useState<string | null>(null), [message, setMessage] = React.useState<string | null>(null), [confirmStop, setConfirmStop] = React.useState(false);
  const [evidence, setEvidence] = React.useState<BotPeerEvidence | null>(null), [reading, setReading] = React.useState(false);
  const saved = controls.pending.rows.filter((row) => row.kind === "stop" && row.request.exchangeId === exchangeId);
  React.useEffect(() => {
    if (!view.data) return;
    try { if (settleBotPeerStop(botId, view.data)) setMessage("The host confirmed the saved Stop outcome."); }
    catch { controls.refresh(); }
  }, [view.data, botId, controls.refresh]);
  const stop = async (request: BotPeerStopMutation, retry = false) => {
    if (!controls.begin()) return;
    setError(null); setMessage(null);
    try {
      // Only this fresh read can authorize an old, still-protected Stop retry.
      const freshExchange = retry ? await api.exchange(botId, exchangeId) : undefined;
      if (!controls.alive.current) return;
      if (freshExchange && settleBotPeerStop(botId, freshExchange)) { setMessage("The host confirmed the saved Stop outcome."); void view.refetch(); return; }
      const attempt = recordBotPeerAttempt({ kind: "stop", request }, { retry, freshExchange: freshExchange ?? undefined });
      const result = await api.stop(attempt.request as BotPeerStopMutation);
      if (!result.ok) {
        if (result.code !== "unavailable") clearBotPeerAttempt(attempt, false);
        if (controls.alive.current) setError(result.error + (retry || result.code === "unavailable" ? " The saved Stop remains unconfirmed." : ""));
      } else {
        const settled = settleBotPeerStop(botId, result.exchange);
        if (controls.alive.current) setMessage(settled ? stopOutcome(result.exchange.lastStop!) : "Stop requested. Waiting for the host’s acknowledgement; the original request is saved.");
      }
      if (controls.alive.current) { await qc.invalidateQueries({ queryKey: detailKey(botId, exchangeId) }); void qc.invalidateQueries({ queryKey: ["bot-peers", botId, "exchanges"] }); }
    } catch (error) { if (controls.alive.current) setError(errorText(error)); }
    finally { controls.end(); }
  };
  const readEvidence = async (kind: "source" | "result") => {
    setReading(true); setError(null);
    try { const value = await api.evidence(botId, exchangeId, kind); if (controls.alive.current) { setEvidence(value); if (!value) setMessage("This evidence is no longer retained."); } }
    catch (error) { if (controls.alive.current) setError(errorText(error)); }
    finally { if (controls.alive.current) setReading(false); }
  };
  const exchange = view.data;
  const hostStopPending = Boolean(exchange && (exchange.state === "stopping" || exchange.lastStop && ["requested", "uncertain"].includes(exchange.lastStop.state)));
  return <><Dialog open confirmHidden title="Bot exchange" onOpenChange={(open) => { if (!open) onClose(); }}>
    {(error || controls.pending.error) && <Text role="alert" variant="small" color="red">{error ?? controls.pending.error}</Text>}{message && <Text role="status" variant="small">{message}</Text>}
    {saved.map((row) => <Field key={row.request.mutationId} orientation="vertical" label="Saved Stop awaiting confirmation" description="A sent Stop does not confirm cancellation. The original request is retained."><Button size="small" disabled={controls.busy} onClick={() => void stop(row.request as BotPeerStopMutation, true)}>Retry saved Stop</Button></Field>)}
    {view.isPending ? <Text role="status">Loading exchange…</Text> : view.isError ? <Field label="Exchange unavailable"><Button size="small" onClick={() => void view.refetch()}>Try again</Button></Field> : !exchange ? <Text>This exchange is no longer available.</Text> : <>
      <FieldSet title={exchange.title}><Field orientation="vertical" label={`${exchange.sender.name} → ${exchange.recipient.name}`} description={`${exchange.kind === "fyi" ? "FYI" : exchange.kind === "status" ? "Status update" : exchange.kind === "question" ? "Question" : "Request"} · ${stateLabel[exchange.state]} · ${returnLabel[exchange.returnState]}`}><Text as="p" variant="small" className="whitespace-pre-wrap break-words">{exchange.request.text}</Text></Field>
        {exchange.result && <Field orientation="vertical" label={`Result · ${exchange.result.outcome}`}><Text as="p" variant="small" className="whitespace-pre-wrap break-words">{exchange.result.text}</Text>{exchange.result.truncated && <Text variant="small" color="tertiary">Result shortened by the host.</Text>}</Field>}
        {exchange.blockedReason && <Field orientation="vertical" label="Needs attention" description={exchange.blockedReason.replace(/_/gu, " ")} />}
        {hostStopPending && saved.length === 0 && <Field orientation="vertical" label="Stop awaiting acknowledgement" description="The host already has a pending Stop. Refresh to read its outcome; this device cannot replace the original request."><Button size="small" variant="transparent" onClick={() => void view.refetch()}>Refresh exchange</Button></Field>}
        <Field orientation="vertical"><div className="flex flex-wrap gap-2"><Button size="small" variant="transparent" disabled={reading} onClick={() => void readEvidence("source")}>View source</Button><Button size="small" variant="transparent" disabled={reading} onClick={() => void readEvidence("result")}>View result evidence</Button>{exchange.canStop && !hostStopPending && <Button size="small" disabled={controls.busy || saved.length > 0 || Boolean(controls.pending.error)} onClick={() => setConfirmStop(true)}>Stop exchange</Button>}</div></Field>
      </FieldSet>
    </>}
    {evidence && <FieldSet title={evidence.title}><Field orientation="vertical"><Text as="p" variant="small" className="whitespace-pre-wrap break-words">{evidence.text}</Text>{evidence.truncated && <Text variant="small" color="tertiary">Evidence shortened by the host.</Text>}</Field></FieldSet>}
  </Dialog>{confirmStop && exchange && <Dialog open confirmHidden title="Stop this exchange?" onOpenChange={(open) => { if (!open) setConfirmStop(false); }}><Text variant="small">Stop only the work linked to this exchange. If its inputs are mixed with other work, the host may refuse the Stop.</Text><Button disabled={controls.busy} onClick={() => { setConfirmStop(false); void stop({ botId, exchangeId, mutationId: crypto.randomUUID(), expectedRevision: exchange.revision }); }}>Confirm Stop</Button></Dialog>}</>;
}

export function BotPeerExchangeButton({ botId, exchangeId }: { botId: string; exchangeId: string }) {
  const [open, setOpen] = React.useState(false);
  return <><Button size="small" variant="transparent" onClick={() => setOpen(true)}>View exchange</Button>{open && <BotPeerExchangeDialog key={`${botId}:${exchangeId}`} botId={botId} exchangeId={exchangeId} onClose={() => setOpen(false)} />}</>;
}
