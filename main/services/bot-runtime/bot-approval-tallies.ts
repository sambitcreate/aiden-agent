// Private decision receipts and bounded approval history beside each Bot's rules.
// Receipts are never collected until the host can prove their tasks settled.
import * as fs from "node:fs/promises";
import path from "node:path";
import { botApprovalRuleKey, type BotApprovalRuleTarget } from "../../../renderer/shared/tool-approval-scope.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { syncDirectory, writeJsonAtomic } from "../durable-fs.js";
import { readRegularUtf8File } from "../regular-file-read.js";

export const BOT_APPROVAL_TALLIES_FILE = "approval-tallies.json";
export const BOT_APPROVAL_NUDGE_THRESHOLD = 3;
export const BOT_APPROVAL_NUDGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const BOT_APPROVAL_HINT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export type BotApprovalAnswer = "allow" | "allow_always" | "deny";
export interface BotApprovalDecision {
  id: string;
  authorizationFingerprint: string;
  answer: BotApprovalAnswer;
  source: "person" | "expiry" | "allow_list";
}
export interface BotApprovalPublicationContext {
  consentRevision: string;
  label: string;
  title: string;
}
export interface BotApprovalPublicationRecord {
  decision: BotApprovalDecision;
  target: BotApprovalRuleTarget;
  offered: boolean;
  decidedAt: number;
  context: BotApprovalPublicationContext;
  status: "pending" | "published" | "revoked";
}
export type BotApprovalTallyKey = BotApprovalRuleTarget | { kind: "folder"; path: string };
export interface BotApprovalHintContext { label: string; choice: string; place?: string }
export function botApprovalNudgeHint(input: BotApprovalHintContext & { count: number }): string {
  return `Aiden note: the person has approved “${input.label}” ${input.count} times in the last 14 days. Once, in one short sentence of your own, tell them they can stop being asked: “${input.choice}” on the next card${input.place ? `, or ${input.place}` : ""}. Don't bring it up again.`;
}
export interface BotApprovalTallyResult { counted: boolean; hintCount?: number; hint?: string }
export interface BotApprovalRecordingContext {
  /** Main-only provenance of this bookkeeping call, independent of event time. Defaults to live. */
  origin?: "live" | "historical";
  /** A recomputed card offer is not new person consent. All other receipt identity checks remain strict. */
  replayOffer?: "stored";
  /** Display text captured before I/O, saved only if this decision owns the hint. */
  hint?: BotApprovalHintContext;
}
export interface BotApprovalTallies {
  /** decidedAt is trusted original event time for delayed host-journal recovery.
   * Omitted replay time uses the receipt; explicit replay time must match it. */
  record(botId: string, key: BotApprovalTallyKey, decision: BotApprovalDecision & { offered: boolean; decidedAt?: number; publicationContext?: BotApprovalPublicationContext }, context?: BotApprovalRecordingContext): Promise<BotApprovalTallyResult>;
  /** Grants nothing. First terminal result sticks; publication clears earlier history and its own exact event. */
  completePublication(botId: string, decisionId: string, authorizationFingerprint: string, status: "published" | "revoked"): Promise<void>;
  decision(botId: string, id: string, authorizationFingerprint: string): Promise<BotApprovalDecision | undefined>;
  publication(botId: string, id: string, authorizationFingerprint: string): Promise<BotApprovalPublicationRecord | undefined>;
  pendingPublications(botId: string): Promise<BotApprovalPublicationRecord[]>;
  nudge(botId: string, key: BotApprovalTallyKey): Promise<{ count: number } | undefined>;
  /** Explicit class-cache reset. Publication settlement uses completePublication instead. */
  forget(botId: string, key: BotApprovalTallyKey): Promise<void>;
  forgetBot(botId: string): Promise<void>;
}

interface ClassHistory {
  key: string;
  allowed: number[];
  /** Aligned identities prove which events remain after caps, forget and eviction. */
  allowedDecisionIds: string[];
  deniedAt?: number;
  hintedAt?: number;
}
interface DecisionReceipt extends BotApprovalDecision {
  key: string;
  offered: boolean;
  at: number;
  result: BotApprovalTallyResult;
  /** Only a person's Always decision carries this entitlement. First completion wins. */
  publication?: "pending" | "published" | "revoked";
  publicationContext?: BotApprovalPublicationContext;
}
interface TallyFile { version: 1; classes: ClassHistory[]; decisions: DecisionReceipt[] }
interface FileState {
  observed: boolean;
  blocked: boolean;
  forgotten: boolean;
  /** Detect lost or rewritten receipts even in otherwise valid JSON. */
  receipts: Map<string, string>;
  publications: Map<string, DecisionReceipt["publication"]>;
}
interface Context { file: string; state: FileState }
interface Loaded { document: TallyFile; text: string | undefined }

// All factories in this process share the same lane, under the host profile lease.
// Separate roots and Bots have separate lanes. No run callbacks are retained here.
const serial = createKeyedSerial();
const states = new Map<string, FileState>();
const empty = (): TallyFile => ({ version: 1, classes: [], decisions: [] });
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function text(v: unknown, max: number): v is string {
  return typeof v === "string" && !!v.trim() && v.length <= max &&
    ![...v].some((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f);
}
function decisionFields(v: unknown): v is BotApprovalDecision {
  return obj(v) && text(v.id, 256) && text(v.authorizationFingerprint, 512) &&
    (v.answer === "allow" || v.answer === "allow_always" || v.answer === "deny") &&
    (v.source === "person" || v.source === "expiry" || v.source === "allow_list");
}

function safePublicationDisplay(value: unknown): value is string {
  return text(value, 200) && value === value.replace(/\s+/gu, " ").trim() &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && !/(?:https?|file):\/\//iu.test(value);
}
function validPublicationContext(value: unknown): value is BotApprovalPublicationContext {
  return obj(value) && keys(value, ["consentRevision", "label", "title"]) &&
    typeof value.consentRevision === "string" && /^[a-f0-9]{64}$/u.test(value.consentRevision) &&
    safePublicationDisplay(value.label) && safePublicationDisplay(value.title);
}
function publicationContextIdentity(context: BotApprovalPublicationContext | undefined): string {
  return JSON.stringify(context ? [context.consentRevision, context.label, context.title] : null);
}
function publicationTarget(key: string): BotApprovalRuleTarget | undefined {
  // Callers use this only after canonicalKey/keyOf validated the tuple.
  const tuple = JSON.parse(key) as string[];
  if (tuple[0] === "connection") return { kind: "connection", serverId: tuple[1]!, tool: tuple[2]! };
  if (tuple[0] === "site") return { kind: "site", host: tuple[1]!, action: tuple[2] as "click" | "type" | "press" };
  return undefined;
}
function publicationRecord(receipt: DecisionReceipt): BotApprovalPublicationRecord | undefined {
  if (!receipt.publicationContext || !receipt.publication) return undefined;
  const target = publicationTarget(receipt.key);
  if (!target) return undefined;
  return { decision: { id: receipt.id, authorizationFingerprint: receipt.authorizationFingerprint,
    answer: receipt.answer, source: receipt.source }, target, offered: receipt.offered,
    decidedAt: receipt.at, context: { ...receipt.publicationContext }, status: receipt.publication };
}

function keyOf(value: BotApprovalTallyKey): string {
  if (!obj(value)) throw new Error("Invalid Bot approval tally class.");
  if (value.kind === "connection" && text(value.serverId, 256) && text(value.tool, 256)) {
    return botApprovalRuleKey({ kind: "connection", serverId: value.serverId, tool: value.tool });
  }
  if (value.kind === "site" && text(value.host, 253) && /^[a-z0-9.-]+$/u.test(value.host) &&
    !value.host.startsWith("www.") && (value.action === "click" || value.action === "type" || value.action === "press")) {
    return botApprovalRuleKey({ kind: "site", host: value.host, action: value.action });
  }
  if (value.kind === "folder" && text(value.path, 4096) && path.isAbsolute(value.path) &&
    path.normalize(value.path) === value.path && value.path !== path.parse(value.path).root) {
    return JSON.stringify(["folder", value.path]);
  }
  throw new Error("Invalid Bot approval tally class.");
}

function canonicalKey(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const tuple: unknown = JSON.parse(v);
    if (!Array.isArray(tuple)) return false;
    let target: BotApprovalTallyKey;
    if (tuple[0] === "connection" && tuple.length === 3) target = { kind: "connection", serverId: tuple[1], tool: tuple[2] };
    else if (tuple[0] === "site" && tuple.length === 3) target = { kind: "site", host: tuple[1], action: tuple[2] };
    else if (tuple[0] === "folder" && tuple.length === 2) target = { kind: "folder", path: tuple[1] };
    else return false;
    return keyOf(target) === v;
  } catch { return false; }
}

function parseFile(value: unknown): TallyFile | undefined {
  if (!obj(value) || !keys(value, ["version", "classes", "decisions"]) || value.version !== 1 ||
    !Array.isArray(value.classes) || value.classes.length > 100 || !Array.isArray(value.decisions)) return undefined;
  const ids = new Set<string>();
  const hints = new Map<string, number>();
  for (const r of value.decisions) {
    if (!obj(r) || !keys(r, ["id", "authorizationFingerprint", "answer", "source", "key", "offered", "at", "result", "publication", "publicationContext"]) ||
      !decisionFields(r) || ids.has(r.id) || !canonicalKey(r.key) || typeof r.offered !== "boolean" || !timestamp(r.at) ||
      !obj(r.result) || !keys(r.result, ["counted", "hintCount", "hint"]) || r.result.counted !== (r.source === "person") ||
      (r.result.hint !== undefined && (r.result.hintCount === undefined || !text(r.result.hint, 2_048)))) return undefined;
    if (r.source === "person" && r.answer === "allow_always"
      ? r.publication !== "pending" && r.publication !== "published" && r.publication !== "revoked"
      : r.publication !== undefined) return undefined;
    if (r.publicationContext !== undefined && (!validPublicationContext(r.publicationContext) ||
      r.source !== "person" || r.answer !== "allow_always" || !publicationTarget(r.key))) return undefined;
    ids.add(r.id);
    if (r.result.hintCount !== undefined) {
      if (r.source !== "person" || r.answer !== "allow" || !r.offered ||
        !Number.isInteger(r.result.hintCount) || (r.result.hintCount as number) < 4 || (r.result.hintCount as number) > 21 ||
        (hints.has(r.key) && r.at - hints.get(r.key)! < BOT_APPROVAL_HINT_COOLDOWN_MS)) return undefined;
      hints.set(r.key, r.at);
    }
  }
  const receipts = new Map((value.decisions as DecisionReceipt[]).map((r) => [r.id, r]));
  const classKeys = new Set<string>();
  for (const c of value.classes) {
    if (!obj(c) || !keys(c, ["key", "allowed", "allowedDecisionIds", "deniedAt", "hintedAt"]) || !canonicalKey(c.key) || classKeys.has(c.key) ||
      !Array.isArray(c.allowed) || c.allowed.length > 20 || !c.allowed.every(timestamp) ||
      !Array.isArray(c.allowedDecisionIds) || c.allowedDecisionIds.length !== c.allowed.length ||
      !c.allowedDecisionIds.every((id) => text(id, 256)) || new Set(c.allowedDecisionIds).size !== c.allowedDecisionIds.length ||
      (c.deniedAt !== undefined && !timestamp(c.deniedAt)) || (c.hintedAt !== undefined && !timestamp(c.hintedAt))) return undefined;
    const allowed = c.allowed;
    if (allowed.some((at, index) => index > 0 && at < allowed[index - 1])) return undefined;
    classKeys.add(c.key);
    // A timestamp alone cannot prove whether the publishing Always survived a
    // cache cap or reset. Never guess which of several equal-time events it was.
    const allowedDecisionIds = c.allowedDecisionIds;
    for (let index = 0; index < allowed.length; index++) {
      const receipt = receipts.get(allowedDecisionIds[index]);
      if (!receipt || receipt.key !== c.key || receipt.source !== "person" ||
        receipt.answer === "deny" || receipt.at !== allowed[index]) return undefined;
    }
    const related = (value.decisions as DecisionReceipt[]).filter((r) => r.key === c.key && r.source === "person");
    if (c.deniedAt !== undefined && !related.some((r) => r.answer === "deny" && r.at === c.deniedAt)) return undefined;
    if (c.hintedAt !== undefined && !related.some((r) => r.result.hintCount !== undefined && r.at === c.hintedAt)) return undefined;
  }
  return value as unknown as TallyFile;
}

function unreadable(context: Context): never {
  context.state.blocked = true;
  throw new Error("This Bot's approval receipt ledger couldn't be read. Bookkeeping is blocked.");
}
function assertActive(context: Context): void {
  if (context.state.forgotten) throw new Error("This Bot no longer exists.");
  if (context.state.blocked) unreadable(context);
}
function observe(context: Context, document: TallyFile): void {
  const next = new Map(document.decisions.map((r) => [r.id, JSON.stringify([
    r.id, r.authorizationFingerprint, r.answer, r.source, r.key, r.offered, r.at,
    r.result.counted, r.result.hintCount ?? null, r.result.hint ?? null, publicationContextIdentity(r.publicationContext),
  ])]));
  const publications = new Map(document.decisions.map((r) => [r.id, r.publication]));
  for (const [id, previous] of context.state.receipts) {
    if (next.get(id) !== previous) unreadable(context);
    const before = context.state.publications.get(id);
    const after = publications.get(id);
    if (before !== after && !(before === "pending" && (after === "published" || after === "revoked"))) unreadable(context);
  }
  context.state.receipts = next;
  context.state.publications = publications;
  context.state.observed = true;
}

async function load(context: Context): Promise<Loaded> {
  assertActive(context);
  let contents: string;
  try {
    contents = await readRegularUtf8File(context.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !context.state.observed) {
      // A dangling symlink is existing evidence, not a fresh ledger.
      try { await fs.lstat(context.file); } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return { document: empty(), text: undefined };
      }
    }
    return unreadable(context);
  }
  let document: TallyFile | undefined;
  try { document = parseFile(JSON.parse(contents)); } catch { /* Preserve the original file. */ }
  if (!document) return unreadable(context);
  observe(context, document);
  return { document, text: contents };
}

async function publish(context: Context, loaded: Loaded): Promise<void> {
  assertActive(context);
  await writeJsonAtomic(context.file, loaded.document, {
    mode: 0o600, mkdirMode: 0o700,
    beforePublish: async () => {
      assertActive(context);
      // Do not overwrite evidence changed/lost while the staged file was flushed.
      if ((await load(context)).text !== loaded.text) unreadable(context);
      assertActive(context);
    },
  });
  observe(context, loaded.document);
}

/** Equal-time events are ambiguous and must remain after a reset. */
function publicationCutoff(document: TallyFile, key: string): number {
  let cutoff = 0;
  for (const receipt of document.decisions) {
    if (receipt.key === key && receipt.publication === "published") cutoff = Math.max(cutoff, receipt.at);
  }
  return cutoff;
}
function cachedApprovals(document: TallyFile, key: string): DecisionReceipt[] {
  const history = document.classes.find((c) => c.key === key);
  if (!history) return [];
  const receipts = new Map(document.decisions.map((r) => [r.id, r]));
  // The strict decoder checked the membership, identity, class and timestamp.
  return history.allowedDecisionIds.map((id) => receipts.get(id)!);
}
function currentApprovals(document: TallyFile, key: string, at: number): DecisionReceipt[] {
  const cutoff = publicationCutoff(document, key);
  return cachedApprovals(document, key).filter((receipt) => receipt.publication !== "published" &&
    receipt.at >= cutoff && receipt.at >= at - BOT_APPROVAL_NUDGE_WINDOW_MS && receipt.at <= at);
}
function lastReceiptTime(document: TallyFile, key: string, kind: "deny" | "hint"): number | undefined {
  let latest: number | undefined;
  const cutoff = kind === "deny" ? publicationCutoff(document, key) : 0;
  for (const r of document.decisions) {
    if (r.key !== key || r.source !== "person" || r.at < cutoff ||
      (kind === "deny" ? r.answer !== "deny" : r.result.hintCount === undefined)) continue;
    latest = latest === undefined ? r.at : Math.max(latest, r.at);
  }
  return latest;
}
function recentDenial(document: TallyFile, key: string, at: number): boolean {
  const deniedAt = lastReceiptTime(document, key, "deny");
  return deniedAt !== undefined && deniedAt >= at - BOT_APPROVAL_NUDGE_WINDOW_MS;
}

export function createBotApprovalTallies(options: { profileDir(): string; now?(): number }): BotApprovalTallies {
  const now = options.now ?? Date.now;
  function contextOf(botId: string): Context {
    const file = path.resolve(botSessionDirectory(options.profileDir(), botId), BOT_APPROVAL_TALLIES_FILE);
    let state = states.get(file);
    if (!state) {
      state = { observed: false, blocked: false, forgotten: false, receipts: new Map(), publications: new Map() };
      states.set(file, state);
    }
    return { file, state };
  }
  function clock(): number {
    const at = now();
    if (!timestamp(at)) throw new Error("Invalid Bot approval tally time.");
    return at;
  }
  return {
    async record(botId, target, decision, recordingContext) {
      // Capture only scalar data before the first await; never retain a caller's object.
      const key = keyOf(target);
      if (!decisionFields(decision) || typeof decision.offered !== "boolean" ||
        (decision.decidedAt !== undefined && !timestamp(decision.decidedAt))) throw new Error("Invalid Bot approval decision.");
      const captured = { id: decision.id, authorizationFingerprint: decision.authorizationFingerprint,
        answer: decision.answer, source: decision.source, offered: decision.offered };
      const decidedAt = decision.decidedAt;
      const origin = recordingContext?.origin ?? "live", replayOffer = recordingContext?.replayOffer;
      const hint = recordingContext?.hint ? { ...recordingContext.hint } : undefined;
      if ((origin !== "live" && origin !== "historical") || (replayOffer !== undefined && replayOffer !== "stored") ||
        (hint && (!safePublicationDisplay(hint.label) || !safePublicationDisplay(hint.choice) ||
          (hint.place !== undefined && !safePublicationDisplay(hint.place))))) throw new Error("Invalid Bot approval recording context.");
      let publicationContext: BotApprovalPublicationContext | undefined;
      if (decision.publicationContext !== undefined) {
        if (!validPublicationContext(decision.publicationContext) || captured.source !== "person" ||
          captured.answer !== "allow_always" || !publicationTarget(key)) throw new Error("Invalid Bot approval publication context.");
        publicationContext = { consentRevision: decision.publicationContext.consentRevision,
          label: decision.publicationContext.label, title: decision.publicationContext.title };
      }
      const context = contextOf(botId);
      return serial(context.file, async () => {
        const loaded = await load(context);
        const document = loaded.document;
        const existing = document.decisions.find((r) => r.id === captured.id);
        if (existing) {
          if (existing.authorizationFingerprint !== captured.authorizationFingerprint || existing.key !== key ||
            existing.answer !== captured.answer || existing.source !== captured.source ||
            (replayOffer !== "stored" && existing.offered !== captured.offered) ||
            (decidedAt !== undefined && existing.at !== decidedAt) ||
            (publicationContext !== undefined && publicationContextIdentity(publicationContext) !== publicationContextIdentity(existing.publicationContext))) {
            throw new Error("Bot approval decision changed its immutable identity.");
          }
          return { ...existing.result };
        }
        const observedAt = clock();
        const at = decidedAt ?? observedAt;
        const cutoff = publicationCutoff(document, key);
        const allowed = currentApprovals(document, key, observedAt);
        const denied = recentDenial(document, key, observedAt);
        const hintedAt = lastReceiptTime(document, key, "hint");
        const result: BotApprovalTallyResult = { counted: captured.source === "person" };
        const receipt: DecisionReceipt = { ...captured, key, at, result,
          ...(publicationContext ? { publicationContext } : {}),
          ...(captured.source === "person" && captured.answer === "allow_always" ? { publication: "pending" as const } : {}) };
        if (captured.source === "person") {
          if (captured.answer === "allow" && captured.offered && origin === "live" && at <= observedAt &&
            at >= observedAt - BOT_APPROVAL_NUDGE_WINDOW_MS && allowed.length >= BOT_APPROVAL_NUDGE_THRESHOLD && !denied &&
            (hintedAt === undefined || at - hintedAt >= BOT_APPROVAL_HINT_COOLDOWN_MS)) {
            result.hintCount = allowed.length + 1;
            if (hint) result.hint = botApprovalNudgeHint({ ...hint, count: result.hintCount });
          }
          const deniedAt = captured.answer === "deny" && at >= cutoff
            ? Math.max(lastReceiptTime(document, key, "deny") ?? at, at) : lastReceiptTime(document, key, "deny");
          if (captured.answer !== "deny" && at >= cutoff && at >= observedAt - BOT_APPROVAL_NUDGE_WINDOW_MS && at <= observedAt) allowed.push(receipt);
          const recent = allowed.sort((a, b) => a.at - b.at).slice(-20);
          const history: ClassHistory = { key, allowed: recent.map((r) => r.at), allowedDecisionIds: recent.map((r) => r.id),
            ...(deniedAt === undefined ? {} : { deniedAt }),
            ...(result.hintCount !== undefined ? { hintedAt: at } : hintedAt === undefined ? {} : { hintedAt }) };
          document.classes = [...document.classes.filter((c) => c.key !== key), history].slice(-100);
        }
        document.decisions.push(receipt);
        await publish(context, loaded);
        return { ...result };
      });
    },
    async completePublication(botId, decisionId, authorizationFingerprint, status) {
      if (!text(decisionId, 256) || !text(authorizationFingerprint, 512) || (status !== "published" && status !== "revoked")) {
        throw new Error("Invalid Bot approval publication decision.");
      }
      const context = contextOf(botId);
      return serial(context.file, async () => {
        const loaded = await load(context);
        const receipt = loaded.document.decisions.find((r) => r.id === decisionId);
        if (!receipt || receipt.authorizationFingerprint !== authorizationFingerprint ||
          receipt.source !== "person" || receipt.answer !== "allow_always" || receipt.publication === undefined) {
          throw new Error("Unknown or changed Bot approval publication decision.");
        }
        // A later retry must not clear post-consent history, even when the rule
        // has since been revoked. This method never grants or restores access.
        if (receipt.publication !== "pending") return;
        receipt.publication = status;
        if (status === "published") {
          const cutoff = publicationCutoff(loaded.document, receipt.key);
          const history = loaded.document.classes.find((c) => c.key === receipt.key);
          if (history) {
            const remaining = cachedApprovals(loaded.document, receipt.key)
              .filter((event) => event.publication !== "published" && event.at >= cutoff);
            history.allowed = remaining.map((event) => event.at);
            history.allowedDecisionIds = remaining.map((event) => event.id);
            if (history.deniedAt !== undefined && history.deniedAt < cutoff) delete history.deniedAt;
          }
        }
        await publish(context, loaded);
      });
    },
    async decision(botId, id, authorizationFingerprint) {
      if (!text(id, 256) || !text(authorizationFingerprint, 512)) throw new Error("Invalid Bot approval decision identity.");
      const context = contextOf(botId);
      return serial(context.file, async () => {
        const { document } = await load(context);
        const receipt = document.decisions.find((r) => r.id === id && r.authorizationFingerprint === authorizationFingerprint);
        return receipt ? { id: receipt.id, authorizationFingerprint: receipt.authorizationFingerprint,
          answer: receipt.answer, source: receipt.source } : undefined;
      });
    },
    async publication(botId, id, authorizationFingerprint) {
      if (!text(id, 256) || !text(authorizationFingerprint, 512)) throw new Error("Invalid Bot approval decision identity.");
      const context = contextOf(botId);
      return serial(context.file, async () => {
        const { document } = await load(context);
        const receipt = document.decisions.find((r) => r.id === id && r.authorizationFingerprint === authorizationFingerprint);
        return receipt ? publicationRecord(receipt) : undefined;
      });
    },
    async pendingPublications(botId) {
      const context = contextOf(botId);
      return serial(context.file, async () => {
        const { document } = await load(context);
        return document.decisions.filter((r) => r.publication === "pending")
          .map(publicationRecord).filter((record): record is BotApprovalPublicationRecord => record !== undefined);
      });
    },
    async nudge(botId, target) {
      const key = keyOf(target);
      const context = contextOf(botId);
      return serial(context.file, async () => {
        const { document } = await load(context);
        const at = clock();
        const count = currentApprovals(document, key, at).length;
        return count >= BOT_APPROVAL_NUDGE_THRESHOLD && !recentDenial(document, key, at) ? { count } : undefined;
      });
    },
    async forget(botId, target) {
      const key = keyOf(target);
      const context = contextOf(botId);
      return serial(context.file, async () => {
        const loaded = await load(context);
        const previous = loaded.document.classes.length;
        loaded.document.classes = loaded.document.classes.filter((c) => c.key !== key);
        if (previous !== loaded.document.classes.length) await publish(context, loaded);
      });
    },
    async forgetBot(botId) {
      const context = contextOf(botId);
      // Fence the running writer immediately, before joining the serial lane.
      context.state.forgotten = true;
      return serial(context.file, async () => {
        await fs.rm(context.file, { force: true });
        const directory = path.dirname(context.file);
        try { await syncDirectory(directory); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        context.state.receipts.clear();
        context.state.publications.clear();
        await fs.rmdir(directory).catch((error: unknown) => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        });
      });
    },
  };
}
