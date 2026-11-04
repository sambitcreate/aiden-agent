import { createHash, randomUUID } from "node:crypto";
import {
  BOT_CONNECTOR_WATCH_TEMPLATES, BOT_CONNECTOR_WATCH_LIMITS as LIMITS,
  type BotConnectorWatchCondition, type BotConnectorWatchConfig, type BotConnectorWatchCreateInput,
  type BotConnectorWatchEnableInput, type BotConnectorWatchIdentityInput, type BotConnectorWatchList,
  type BotConnectorWatchSourceList, type BotConnectorWatchTestInput, type BotConnectorWatchTestResult,
  type BotConnectorWatchUpdateInput, type BotConnectorWatchView,
} from "../../../renderer/shared/bot-connector-watches.js";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import { createKeyedSerial } from "../bot-routine-notes.js";
import { compareImcpWatch, type ConnectorWatchItem, type ImcpWatchPort, readImcpWatch } from "./connector-watch-imcp.js";
import { parseConnectorPrivate, connectorBindingMatchesCondition, parseConnectorBaseline, type BotConnectorWatchBinding, type BotConnectorWatchPrivate, type ImcpMailWatchBinding, type ComposioCalendarWatchBinding } from "./connector-types.js";
import { readComposioCalendarWatch, type ComposioCalendarReadPort } from "./connector-watch-composio.js";
import type { BotEventRoutine, BotEventRoutineStore } from "./store.js";
import type { BotWatchCheck } from "./watch-sources.js";
import type { BotRoutineEventDispatcher } from "./dispatcher.js";
import { boundedConnectorText, connectorSourceLabels, connectorTextIsWellFormed } from "./connector-text.js";

const DAY = 86_400_000;
// Keep accepted configurations below Remote's standard 1 MiB response limit,
// reserving space for bounded check/run metadata added after a config write.
const MAX_LIST_BYTES = 900 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export class BotConnectorWatchError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "revision_conflict" | "idempotency_conflict" | "idempotency_capacity" | "capability_denied" | "unavailable", message: string, readonly details?: Record<string, unknown>) { super(message); }
}
class ConnectorReadInterrupted extends BotConnectorWatchError {
  constructor() { super("unavailable", "This check stopped because the Bot, watch or host paused or changed. Check again when it is ready."); }
}
function fail(message: string): never { throw new BotConnectorWatchError("invalid_request", message); }
export function connectorFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const clean = copyBoundedJson(value, { maxNodes: 200, maxDepth: 5, maxSize: 256 * 1024, measure: utf8Size });
  if (!clean || typeof clean !== "object" || Array.isArray(clean) || Object.keys(clean).some((key) => !allowed.includes(key))) fail("Invalid connector watch request.");
  return clean as Record<string, unknown>;
}
function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0") || !connectorTextIsWellFormed(value)) fail("A connector watch field is missing, too long or contains invalid text.");
  return value.trim();
}
export function connectorId(value: unknown): string { const id = string(value, 36); if (!UUID.test(id)) fail("Invalid connector watch identity."); return id.toLowerCase(); }
function condition(value: unknown): BotConnectorWatchCondition {
  const fields = connectorFields(value, ["kind", "sender", "subject", "unreadOnly", "lookAheadMinutes", "timezone"]);
  if(fields.kind==="calendar"){
    if(fields.sender!==undefined||fields.subject!==undefined||fields.unreadOnly!==undefined||!Number.isSafeInteger(fields.lookAheadMinutes)||(fields.lookAheadMinutes as number)<LIMITS.lookAheadMinMinutes||(fields.lookAheadMinutes as number)>LIMITS.lookAheadMaxMinutes)fail("Choose a Calendar window between fifteen minutes and one day.");
    const timezone=string(fields.timezone,LIMITS.timezoneChars);try{new Intl.DateTimeFormat("en",{timeZone:timezone});}catch{fail("Choose a valid Calendar timezone.");}return {kind:"calendar",lookAheadMinutes:fields.lookAheadMinutes as number,timezone};
  }
  if(fields.kind!=="email"||fields.lookAheadMinutes!==undefined||fields.timezone!==undefined||typeof fields.unreadOnly!=="boolean")fail("Choose a supported watch template.");
  return {kind:"email",unreadOnly:fields.unreadOnly,...(fields.sender!==undefined?{sender:string(fields.sender,LIMITS.filterChars)}:{}),...(fields.subject!==undefined?{subject:string(fields.subject,LIMITS.filterChars)}:{})};
}
function config(record: Record<string, unknown>): BotConnectorWatchConfig {
  if (![15, 30, 60].includes(record.everyMinutes as number)) fail("Choose a check interval of 15, 30 or 60 minutes.");
  return { name: string(record.name, LIMITS.nameChars), prompt: string(record.prompt, LIMITS.promptChars), condition: condition(record.condition), everyMinutes: record.everyMinutes as 15 | 30 | 60 };
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function isConnector(routine: BotEventRoutine): boolean { return routine.trigger.kind === "watch" && routine.trigger.source.type === "connector"; }
function view(routine: BotEventRoutine): BotConnectorWatchView {
  const privateState = routine.connector;
  if (!privateState || !isConnector(routine) || privateState.deletedAt !== undefined || routine.trigger.kind !== "watch") throw new BotConnectorWatchError("not_found", "This connector watch no longer exists.");
  const watch = routine.watch;
  return { id: routine.id, botId: routine.botId, revision: String(routine.updatedAt), name: routine.name, prompt: routine.prompt,
    templateId: privateState.binding.adapter==="imcp-mail-v1"?"mail_messages":"calendar_upcoming", condition: structuredClone(privateState.condition), everyMinutes: routine.trigger.everyMinutes as 15 | 30 | 60,
    source: connectorSourceLabels(privateState.binding.labels), enabled: routine.enabled,
    state: !routine.enabled ? "paused" : watch?.lastResult === "error" ? "error" : watch?.connectorItemCount === 0 ? "empty"
      : watch?.lastResult === "changed" ? "changed" : watch?.lastResult === "no_change" ? "unchanged" : "waiting",
    ...(watch?.lastCheckAt !== undefined ? { lastCheckAt: watch.lastCheckAt } : {}),
    ...(watch?.nextCheckAt !== undefined ? { nextCheckAt: watch.nextCheckAt } : {}),
    ...(routine.lastRunAt !== undefined ? { lastRunAt: routine.lastRunAt } : {}),
    ...(watch?.lastError ? { lastError: boundedConnectorText(watch.lastError, LIMITS.errorChars) } : {}) };
}
export interface BotConnectorWatchServicePorts {
  store: BotEventRoutineStore;
  supported(): boolean;
  mailAvailable?():boolean;
  calendarAvailable?():boolean;
  knownBot(botId: string): Promise<boolean>;
  discover(botId: string, signal: AbortSignal, assertActive: () => Promise<void>): Promise<{ bindings: BotConnectorWatchBinding[]; unavailableReasons: string[] }>;
  withPort<T>(botId: string, binding: ImcpMailWatchBinding, signal: AbortSignal, action: (port: ImcpWatchPort) => Promise<T>): Promise<T>;
  withCalendarPort?<T>(botId:string,binding:ComposioCalendarWatchBinding,signal:AbortSignal,action:(port:ComposioCalendarReadPort)=>Promise<T>):Promise<T>;
  authorize(botId: string, binding: BotConnectorWatchBinding, signal?:AbortSignal): Promise<{ signal: AbortSignal; assertCurrent?():void; revalidateBeforeEffect?():Promise<void>; release(): void }>;
  dispatcher: Pick<BotRoutineEventDispatcher, "emit">;
  changed(botId: string): void;
  isPaused(botId: string): Promise<boolean>;
  now(): number;
  retainSource?(binding: BotConnectorWatchBinding): (() => void) | undefined;
  withBotMutation?<T>(botId: string, operation: () => Promise<T>): Promise<T>;
}
export interface BotConnectorWatchDiscoveryLifetime {
  signal: AbortSignal;
  assertCurrent(): void | Promise<void>;
}
export function createBotConnectorWatchService(ports: BotConnectorWatchServicePorts) {
  const localSerial = createKeyedSerial();
  const serial = <T>(botId: string, operation: () => Promise<T>) => localSerial(botId, () => ports.withBotMutation ? ports.withBotMutation(botId, operation) : operation());
  const choices = new Map<string, { botId: string; at: number; binding: BotConnectorWatchBinding }>();
  const active = new Map<AbortController, { botId: string; id?: string }>();
  const cancelWatch = (botId: string, id: string) => { for (const [controller, owner] of active) if (owner.botId === botId && owner.id === id) controller.abort(); };
  let suspended = false;
  const retainedSources = new Map<string, () => void>();
  function projection(routines: readonly BotEventRoutine[]): BotConnectorWatchList {
    const supported = ports.supported();
    return { supported, ...(!supported ? { unavailableReason: "Connector watches are not available on this host." } : {}), templates: structuredClone(BOT_CONNECTOR_WATCH_TEMPLATES.map(template=>template.kind==="calendar"&&ports.calendarAvailable?.()?{...template,available:true,unavailableReason:undefined}:template.kind==="email"&&ports.mailAvailable?.()===false?{...template,available:false,unavailableReason:"Local Mail watches require the owning Mac and iMCP."}:template)), watches: routines.filter((row) => isConnector(row) && row.connector?.deletedAt === undefined).map(view) };
  }
  function withinListBudget(routines: readonly BotEventRoutine[]): void {
    if (Buffer.byteLength(JSON.stringify(projection(routines)), "utf8") > MAX_LIST_BYTES) fail("These watches have too much saved text. Shorten the instructions or remove a watch before adding more.");
  }
  async function assertActive(botId: string, signal: AbortSignal, controller?: AbortController): Promise<void> {
    signal.throwIfAborted();
    if (suspended || await ports.isPaused(botId)) {
      controller?.abort();
      throw new ConnectorReadInterrupted();
    }
    signal.throwIfAborted();
  }
  async function bot(botId: string): Promise<void> {
    if (!await ports.knownBot(botId)) throw new BotConnectorWatchError("not_found", "This Bot no longer exists.");
    if (!ports.supported()) throw new BotConnectorWatchError("unavailable", "Connector watches require the owning desktop host.");
  }
  async function current(botId: string, id: string): Promise<BotEventRoutine> {
    await bot(botId);
    const routine = (await ports.store.list(botId)).find((item) => item.id === id && isConnector(item));
    if (!routine?.connector) throw new BotConnectorWatchError("not_found", "This connector watch no longer exists.");
    return routine;
  }
  function revision(routine: BotEventRoutine, expected: unknown): void {
    if (typeof expected !== "string" || String(routine.updatedAt) !== expected) throw new BotConnectorWatchError("revision_conflict", "This connector watch changed. Refresh before editing it.", { currentRevision: String(routine.updatedAt), ...(routine.connector?.deletedAt === undefined ? { current: view(routine) } : {}) });
  }
  function choice(botId: string, id: unknown): BotConnectorWatchBinding {
    const found = choices.get(connectorId(id));
    if (!found || found.botId !== botId || ports.now() - found.at > 15 * 60_000) throw new BotConnectorWatchError("unavailable", "The source choice expired. Check connected sources again.");
    return structuredClone(found.binding);
  }
  function checkedPrivate(state: BotConnectorWatchPrivate): BotConnectorWatchPrivate {
    if (!parseConnectorPrivate(state)) throw new BotConnectorWatchError("idempotency_capacity", "This watch has too much recent change history. Try again tomorrow.");
    return state;
  }
  function receipts(state: BotConnectorWatchPrivate) { return state.mutations.filter((receipt) => receipt.at >= ports.now() - DAY); }
  function publicationGuard(grant:Awaited<ReturnType<BotConnectorWatchServicePorts["authorize"]>>) {
    return {assertCurrent:()=>{grant.signal.throwIfAborted();grant.assertCurrent?.();},beforePublish:async()=>{grant.signal.throwIfAborted();await grant.revalidateBeforeEffect?.();grant.signal.throwIfAborted();}};
  }
  async function mutate(input: BotConnectorWatchIdentityInput, raw: Record<string, unknown>, update: (routine: BotEventRoutine) => BotEventRoutine, guard?:ReturnType<typeof publicationGuard>): Promise<BotConnectorWatchView> {
    await bot(input.botId);
    const id = connectorId(input.id); const mutationId = connectorId(input.mutationId); const hash = digest(raw);
    const result = await ports.store.mutate(input.botId, id, (routine, routines) => {
      if (!routine.connector || !isConnector(routine)) throw new BotConnectorWatchError("not_found", "This connector watch no longer exists.");
      const replay = routine.connector.mutations.find((entry) => entry.id === mutationId);
      if (replay) { if (replay.digest !== hash) throw new BotConnectorWatchError("idempotency_conflict", "This action identity was already used for a different change."); return { result: replay.result as BotConnectorWatchView }; }
      revision(routine, input.expectedRevision); view(routine);
      const retained = receipts(routine.connector);
      if (retained.length >= 128) throw new BotConnectorWatchError("idempotency_capacity", "This watch has too many recent changes. Try again tomorrow.");
      const next = update(routine); const result = view(next);
      if (raw.action === "update") withinListBudget(routines.map((row) => row.id === id ? next : row));
      next.connector = checkedPrivate({ ...next.connector!, mutations: [...retained, { id: mutationId, digest: hash, at: ports.now(), result }] });
      return { next, result };
    },guard);
    if (!result) throw new BotConnectorWatchError("not_found", "This connector watch no longer exists.");
    cancelWatch(input.botId, id); ports.changed(input.botId); return result;
  }
  async function read(botId: string, binding: BotConnectorWatchBinding, selected: BotConnectorWatchCondition, previous: BotEventRoutine["watch"], signal: AbortSignal, id?: string) {
    if(!connectorBindingMatchesCondition(binding,selected))fail("Choose a source matching this watch template.");
    if(binding.adapter==="composio-calendar-v1"&&(!ports.calendarAvailable?.()||!ports.withCalendarPort))throw new BotConnectorWatchError("unavailable","Calendar watches require the verified read transport on the owning host.");
    const controller = new AbortController(); active.set(controller, { botId, ...(id ? { id } : {}) });
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      await assertActive(botId, combined, controller);
      if(binding.adapter==="composio-calendar-v1"&&selected.kind==="calendar"){
        const baseline=parseConnectorBaseline(previous?.connectorBaseline,binding);
        if (baseline && !("version" in baseline)) throw new BotConnectorWatchError("unavailable", "This Calendar watch has invalid saved history.");
        return await ports.withCalendarPort!(botId,binding,combined,port=>readComposioCalendarWatch({accountId:binding.accountId,calendarId:binding.calendarId,labels:binding.labels},{lookAheadMinutes:selected.lookAheadMinutes,timezone:selected.timezone},baseline,{
          assertCurrent:async(read,callSignal)=>{await assertActive(botId,combined,controller);callSignal.throwIfAborted();await port.assertCurrent(read,callSignal);await assertActive(botId,combined,controller);},
          read:async(read,callSignal)=>{await assertActive(botId,combined,controller);callSignal.throwIfAborted();const result=await port.read(read,callSignal);await assertActive(botId,combined,controller);return result;},
        },ports.now(),combined));
      }
      if(binding.adapter!=="imcp-mail-v1"||selected.kind!=="email")fail("Choose a source matching this watch template.");
      const items = await ports.withPort(botId, binding, combined, (port) => readImcpWatch({ kind: "email", mailbox: binding.mailbox, account: binding.account,
        ...(selected.sender ? { sender: selected.sender } : {}), ...(selected.subject ? { subject: selected.subject } : {}), unreadOnly: selected.unreadOnly }, {
        async assertEligible(tool, callSignal) {
          await assertActive(botId, combined, controller); callSignal.throwIfAborted();
          await port.assertEligible(tool, callSignal);
          await assertActive(botId, combined, controller);
        },
        async call(tool, args, callSignal) {
          await assertActive(botId, combined, controller); callSignal.throwIfAborted();
          const result = await port.call(tool, args, callSignal);
          await assertActive(botId, combined, controller); return result;
        },
      }, ports.now(), combined));
      await assertActive(botId, combined, controller);
      const compared = compareImcpWatch("email", parseConnectorBaseline(previous?.connectorBaseline,binding) as import("./connector-watch-imcp.js").ConnectorWatchBaseline|undefined, items, ports.now());
      return { items, ...compared };
    } catch (error) {
      if (controller.signal.aborted) throw new ConnectorReadInterrupted();
      throw error;
    } finally { active.delete(controller); }
  }
  const api = {
    async list(botId: string): Promise<BotConnectorWatchList> {
      if (!await ports.knownBot(botId)) throw new BotConnectorWatchError("not_found", "This Bot no longer exists.");
      const result = projection(await ports.store.list(botId));
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1_048_576) throw new BotConnectorWatchError("unavailable", "Saved watch data exceeds this host's limit. Restore the last valid backup or contact support.");
      return result;
    },
    async discoverSources(botId: string, lifetime?: BotConnectorWatchDiscoveryLifetime): Promise<BotConnectorWatchSourceList> {
      await bot(botId);
      const controller = new AbortController(); active.set(controller, { botId });
      const signal = lifetime ? AbortSignal.any([controller.signal, lifetime.signal]) : controller.signal;
      try {
        const check = async () => { await assertActive(botId, signal, controller); await lifetime?.assertCurrent(); signal.throwIfAborted(); };
        await check();
        const discovered = await ports.discover(botId, signal, check);
        await check();
        if (discovered.bindings.length > LIMITS.sources) throw new BotConnectorWatchError("unavailable", "Too many sources. Narrow the connected account selection.");
        const retained = [...choices.values()].filter((item) => item.botId !== botId && ports.now() - item.at <= 15 * 60_000);
        if (retained.length + discovered.bindings.length > 2_000) throw new BotConnectorWatchError("unavailable", "Too many recent source choices. Try again in fifteen minutes.");
        const result = discovered.bindings.map((binding) => {
          const labels = connectorSourceLabels(binding.labels);
          const id = randomUUID();
          return { id, templateId: binding.adapter==="imcp-mail-v1"?"mail_messages" as const:"calendar_upcoming" as const, ...labels, available: true };
        });
        const response = { choices: result, unavailableReasons: discovered.unavailableReasons.map((reason) => boundedConnectorText(reason, LIMITS.errorChars)).slice(0, 16) };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_LIST_BYTES) throw new BotConnectorWatchError("unavailable", "Source labels are too large to show together. Narrow the connected account selection and check again.");
        // Publish only a fully bounded discovery; a refusal preserves prior
        // unexpired options and cannot consume the global option capacity.
        for (const [id, item] of choices) if (item.botId === botId || ports.now() - item.at > 15 * 60_000) choices.delete(id);
        result.forEach((source, index) => choices.set(source.id, { botId, at: ports.now(), binding: { ...discovered.bindings[index]!, labels: connectorSourceLabels(discovered.bindings[index]!.labels) } }));
        return response;
      } catch (error) {
        if (signal.aborted) throw new ConnectorReadInterrupted();
        throw error;
      } finally { active.delete(controller); }
    },
    create(input: BotConnectorWatchCreateInput): Promise<BotConnectorWatchView> {
      return serial(input.botId, async () => {
        await bot(input.botId);
        const fields = connectorFields(input, ["botId", "sourceChoiceId", "mutationId", "name", "prompt", "condition", "everyMinutes"]);
        const clean = config(fields); const id = connectorId(fields.mutationId); const hash = digest({ ...clean, sourceChoiceId: connectorId(fields.sourceChoiceId) });
        const old = (await ports.store.list(input.botId)).find((row) => row.id === id);
        if (old) { if (old.connector?.createDigest !== hash) throw new BotConnectorWatchError("idempotency_conflict", "This create identity was already used."); return view(old); }
        const binding = choice(input.botId, fields.sourceChoiceId);
        if(!connectorBindingMatchesCondition(binding,clean.condition))fail("Choose a source matching this watch template.");
        const grant = await ports.authorize(input.botId, binding);
        try {
          grant.signal.throwIfAborted();
          const created = await ports.store.create(input.botId, { id, name: clean.name, prompt: clean.prompt,
            trigger: { kind: "watch", source: { type: "connector", watchId: id }, everyMinutes: clean.everyMinutes },
            connector: checkedPrivate({ binding, condition: clean.condition, createDigest: hash, mutations: [] }) }, withinListBudget,publicationGuard(grant));
          grant.signal.throwIfAborted(); ports.changed(input.botId); return view(created.routine);
        } finally { grant.release(); }
      });
    },
    update(input: BotConnectorWatchUpdateInput) {
      return serial(input.botId, async () => {
        const fields = connectorFields(input, ["botId", "id", "expectedRevision", "mutationId", "sourceChoiceId", "name", "prompt", "condition", "everyMinutes"]);
        const clean = config(fields); const old = await current(input.botId, connectorId(input.id));
        if (old.connector!.mutations.some((receipt) => receipt.id === connectorId(input.mutationId))) return mutate(input, { action: "update", ...fields }, (row) => row);
        const binding = fields.sourceChoiceId === undefined ? old.connector!.binding : choice(input.botId, fields.sourceChoiceId);
        if(!connectorBindingMatchesCondition(binding,clean.condition))fail("Choose a source matching this watch template.");
        const grant = await ports.authorize(input.botId, binding);
        try { return await mutate(input, { action: "update", ...fields }, (row) => {
          const changedBinding = digest(row.connector!.binding) !== digest(binding);
          const changedSource = changedBinding || digest(row.connector!.condition) !== digest(clean.condition);
          const calendarHistory = !changedBinding && binding.adapter === "composio-calendar-v1" ? row.watch?.connectorBaseline : undefined;
          const changedPrompt = row.prompt !== clean.prompt;
          const revision = Math.max(ports.now(), row.updatedAt + 1);
          const next: BotEventRoutine = { ...row, name: clean.name, prompt: clean.prompt, updatedAt: revision,
            trigger: { kind: "watch", source: { type: "connector", watchId: row.id }, everyMinutes: clean.everyMinutes },
            connector: { ...row.connector!, binding, condition: clean.condition },
            watch: changedSource ? { failures: 0, nextCheckAt: ports.now(), ...(calendarHistory ? { connectorBaseline: calendarHistory } : {}) } : { ...row.watch!, nextCheckAt: (row.watch?.lastCheckAt ?? ports.now()) + clean.everyMinutes * 60_000 } };
          if (changedSource || changedPrompt) { delete next.held; delete next.running; if (next.watch) delete next.watch.pending; }
          else { if (next.watch?.pending) next.watch.pending.revision = revision; if (next.held?.watchRevision === row.updatedAt) next.held.watchRevision = revision; next.running = next.running?.filter((event) => event.watchRevision === row.updatedAt).map((event) => ({ ...event, watchRevision: revision })); }
          return next;
        },publicationGuard(grant)); } finally { grant.release(); }
      });
    },
    setEnabled(input: BotConnectorWatchEnableInput) {
      return serial(input.botId, async () => {
        const fields = connectorFields(input, ["botId", "id", "expectedRevision", "mutationId", "enabled"]);
        if (typeof fields.enabled !== "boolean") fail("Choose whether this watch is on.");
        const row = await current(input.botId, connectorId(input.id));
        if (row.connector!.mutations.some((receipt) => receipt.id === connectorId(input.mutationId))) return mutate(input, { action: "enabled", ...fields }, (fresh) => fresh);
        const grant = fields.enabled ? await ports.authorize(input.botId, row.connector!.binding) : undefined;
        try { return await mutate(input, { action: "enabled", ...fields }, (fresh) => {
          const revision = Math.max(ports.now(), fresh.updatedAt + 1);
          const watch = { ...fresh.watch!, ...(fields.enabled ? { failures: 0, nextCheckAt: ports.now() } : {}) };
          if (watch.pending) watch.pending.revision = revision;
          return { ...fresh, enabled: fields.enabled as boolean, updatedAt: revision, watch,
            ...(fresh.held?.watchRevision === fresh.updatedAt ? { held: { ...fresh.held, watchRevision: revision } } : {}),
            running: fresh.running?.filter((event) => event.watchRevision === fresh.updatedAt).map((event) => ({ ...event, watchRevision: revision })) };
        },grant?publicationGuard(grant):undefined); } finally { grant?.release(); }
      });
    },
    remove(input: BotConnectorWatchIdentityInput) {
      return serial(input.botId, async () => {
        connectorFields(input, ["botId", "id", "expectedRevision", "mutationId"]);
        await bot(input.botId); const id = connectorId(input.id); connectorId(input.mutationId);
        const result = await ports.store.mutate(input.botId, id, (row) => {
          if (!row.connector) throw new BotConnectorWatchError("not_found", "This connector watch no longer exists.");
          if (row.connector.deletedAt !== undefined) return { result: { id, revision: `deleted:${input.expectedRevision}`, removed: true } };
          revision(row, input.expectedRevision);
          const next = { ...row, enabled: false, connector: { ...row.connector, deletedAt: ports.now() } }; delete next.held; delete next.running; if (next.watch) delete next.watch.pending;
          return { next, result: { id, revision: `deleted:${input.expectedRevision}`, removed: true } };
        });
        if (!result) throw new BotConnectorWatchError("not_found", "This connector watch no longer exists.");
        cancelWatch(input.botId, id); ports.changed(input.botId); return result;
      });
    },
    async testCheck(input: BotConnectorWatchTestInput): Promise<BotConnectorWatchTestResult> {
      const fields = connectorFields(input, ["botId", "id", "expectedRevision", "sourceChoiceId", "condition"]); await bot(input.botId);
      const row = fields.id !== undefined ? await current(input.botId, connectorId(fields.id)) : undefined;
      if (row) { revision(row, fields.expectedRevision); view(row); if (fields.sourceChoiceId !== undefined || fields.condition !== undefined) fail("Choose a saved watch or a draft preview."); }
      const binding = row?.connector!.binding ?? choice(input.botId, fields.sourceChoiceId);
      const selected = row?.connector!.condition ?? condition(fields.condition);
      const result = await read(input.botId, binding, selected, row?.watch, new AbortController().signal, row?.id);
      if (row) revision(await current(input.botId, row.id), fields.expectedRevision);
      return { checkedAt: ports.now(), result: result.items.length === 0 ? "empty" : !row?.watch?.connectorBaseline ? "baseline" : result.changes.length ? "changed" : "unchanged", itemCount: result.items.length, changeCount: result.changes.length,
        preview: result.items.slice(0, LIMITS.previewItems).map((item) => boundedConnectorText(item.title, LIMITS.previewChars)) };
    },
    runNow(input: BotConnectorWatchIdentityInput) {
      return serial(input.botId, async () => {
        connectorFields(input, ["botId", "id", "expectedRevision", "mutationId"]);
        const row = await current(input.botId, connectorId(input.id)); const key = connectorId(input.mutationId); view(row);
        const hash = digest({ action: "run", ...input });
        const replay = row.connector!.mutations.find((entry) => entry.id === key);
        if (replay) { if (replay.digest !== hash) throw new BotConnectorWatchError("idempotency_conflict", "This action identity was already used."); return replay.result as { id: string; revision: string; admitted: boolean }; }
        revision(row, input.expectedRevision);
        if (!row.enabled || suspended || await ports.isPaused(input.botId)) throw new BotConnectorWatchError("unavailable", "Resume this Bot and watch before running it.");
        const grant = await ports.authorize(input.botId, row.connector!.binding);
        try {
          // Reserve the logical request and its new revision BEFORE dispatch.
          // Receipt expiry can never make its stale expectedRevision fresh again.
          const eventId = `${digest(key).slice(0, 24)}-manual`;
          const reserved = await ports.store.mutate(input.botId, row.id, (fresh) => {
            revision(fresh, input.expectedRevision); view(fresh); grant.signal.throwIfAborted();
            const retained = receipts(fresh.connector!);
            if (retained.length >= 128) throw new BotConnectorWatchError("idempotency_capacity", "This watch has too many recent changes. Try again tomorrow.");
            if (fresh.watch?.pending) throw new BotConnectorWatchError("unavailable", "This watch already has a change waiting to run. Let it settle first.");
            const nextRevision = Math.max(ports.now(), fresh.updatedAt + 1);
            const result = { id: fresh.id, revision: String(nextRevision), admitted: true };
            const next = { ...fresh, updatedAt: nextRevision, connector: checkedPrivate({ ...fresh.connector!, mutations: [...retained, { id: key, digest: hash, at: ports.now(), result }] }),
              watch: { ...fresh.watch!, pending: { eventId, payload: "The person chose Run now for this connector watch.", revision: nextRevision, nextAttemptAt: ports.now() } },
              ...(fresh.held?.watchRevision === fresh.updatedAt ? { held: { ...fresh.held, watchRevision: nextRevision } } : {}),
              running: fresh.running?.filter((event) => event.watchRevision === fresh.updatedAt).map((event) => ({ ...event, watchRevision: nextRevision })) };
            return { next, result: { routine: next, result } };
          },publicationGuard(grant));
          if (!reserved) throw new BotConnectorWatchError("not_found", "This connector watch no longer exists.");
          ports.changed(input.botId);
          const emitted = await ports.dispatcher.emit(input.botId, row.id, { eventId, payload: reserved.routine.watch!.pending!.payload,
            watchRevision: reserved.routine.updatedAt, isCurrent: () => !grant.signal.aborted && !suspended });
          const accepted = ["queued", "held", "duplicate", "daily_limit"].includes(emitted);
          const result = { ...reserved.result, admitted: ["queued", "held", "duplicate"].includes(emitted) };
          if (accepted) await ports.store.mutate(input.botId, row.id, (fresh) => {
            if (fresh.watch?.pending?.eventId !== eventId || fresh.updatedAt !== reserved.routine.updatedAt || !fresh.connector) return { result: undefined };
            const { pending: _pending, ...watch } = fresh.watch;
            return { next: { ...fresh, watch, connector: { ...fresh.connector, mutations: fresh.connector.mutations.map((receipt) => receipt.id === key ? { ...receipt, result } : receipt) } }, result: undefined };
          });
          ports.changed(input.botId); return result;
        } finally { grant.release(); }
      });
    },
    async check(routine: BotEventRoutine, signal: AbortSignal): Promise<BotWatchCheck> {
      let held:Awaited<ReturnType<BotConnectorWatchServicePorts["authorize"]>>|undefined;
      const combined=AbortSignal.any([signal,AbortSignal.timeout(15_000)]);
      try {
        held=await ports.authorize(routine.botId,routine.connector!.binding,combined);combined.throwIfAborted();
        const result = await read(routine.botId, routine.connector!.binding, routine.connector!.condition, routine.watch, combined, routine.id);
        return { ok: true, publication:{signal:held.signal,guard:publicationGuard(held),release:()=>held!.release()}, bytes: new TextEncoder().encode(JSON.stringify(result.baseline)), connector: { baseline: result.baseline, itemCount: result.items.length, changeCount: result.changes.length,
          payload: boundedConnectorText(result.changes.slice(0, 8).map((change) => `${change.kind}: ${change.item.title}`).join("\n"), 3_900) } };
      } catch (error) {
        held?.release();
        if (error instanceof ConnectorReadInterrupted) return { ok: false, skipped: true, error: error.message };
        return { ok: false, error: error instanceof BotConnectorWatchError ? boundedConnectorText(error.message, 200) : "The connector could not be read. Check its existing access in Settings → Connectors.", pause: error instanceof BotConnectorWatchError };
      }
    },
    async authorize(routine: BotEventRoutine) {
      if (!routine.connector || routine.connector.deletedAt !== undefined || suspended) return { error: "This connector watch is unavailable." };
      try { return await ports.authorize(routine.botId, routine.connector.binding); } catch { return { error: "This connector's access changed. Review it in Settings → Connectors." }; }
    },
    rearmSources(routines: readonly BotEventRoutine[]) {
      const wanted = new Map(routines.filter((row) => row.enabled && row.connector && row.connector.deletedAt === undefined).map((row) => [row.connector!.binding.serverId, row.connector!.binding]));
      for (const [id, release] of retainedSources) if (!wanted.has(id) || suspended) { release(); retainedSources.delete(id); }
      if (!suspended) for (const [id, binding] of wanted) if (!retainedSources.has(id)) { const release = ports.retainSource?.(binding); if (release) retainedSources.set(id, release); }
    },
    pauseBot(botId: string) { for (const [controller, owner] of active) if (owner.botId === botId) controller.abort(); },
    suspend() { suspended = true; for (const release of retainedSources.values()) release(); retainedSources.clear(); for (const controller of active.keys()) controller.abort(); active.clear(); },
    resume() { suspended = false; },
  };
  return api;
}
export type BotConnectorWatchService = ReturnType<typeof createBotConnectorWatchService>;
export type { ConnectorWatchItem };
