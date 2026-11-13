// Settings from chat (plan §4.6): the Bot's `update_bot` tool and the
// person's answers to it. With no fields the tool reads the Bot's settings.
// In a run the owner started, a change applies at once and the chat shows a
// receipt with Undo. It is held on a card until the person applies it when
// any other run (a routine, another Bot, Telegram, a wake-up) asks, when the
// conversation already read content from outside the chat, or when the change
// has the Bot reach out more on its own.
//
// Records live in `<profile>/bots/<dir>/settings-changes.json`, which Bot
// file tools cannot write. Undo is compare-and-swap: it restores the earlier
// values only while the settings still hold what the change set, and writes
// against the Bot revision it read, so an edit made in between is kept.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BOT_SETTINGS_CHANGE_ENTRY_KIND,
  BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND,
  BOT_SETTINGS_FIELDS,
  BOT_SETTINGS_UNDO_REFUSED_MESSAGE,
  botSettingsHeldTitle,
  botSettingsLine,
  botSettingsPatchWidens,
  botSettingsReceiptLabel,
  changedBotSettingsFields,
  parseBotSettingsArgs,
  sameBotSettingsValue,
  type BotSettingsChangeDecision,
  type BotSettingsChangeEntryData,
  type BotSettingsChangeStatus,
  type BotSettingsField,
  type BotSettingsHeldReason,
  type BotSettingsModel,
  type BotSettingsPatch,
  type BotSettingsValues,
} from "../../../renderer/shared/bot-settings-changes.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_SETTINGS_CHANGES_FILE = "settings-changes.json";
const SETTLED_KEPT = 50;
const PENDING_LIMIT = 5;

/** A model the Bot may switch to: one already connected and available. */
export interface BotSettingsModelOption extends BotSettingsModel {
  label: string;
}

/** The Bot changed since its settings were read: the write was refused and nothing was written. */
export class BotSettingsConflictError extends Error {
  constructor() {
    super("This Bot's settings changed while saving. Nothing was changed.");
    this.name = "BotSettingsConflictError";
  }
}

export interface BotSettingsPorts {
  profileDir(): string;
  /** The Bot's current settings, and the Bot revision they were read at. */
  read(botId: string): Promise<{ values: BotSettingsValues; revision: string }>;
  /** Models from providers already connected on this device. */
  models(botId: string): Promise<BotSettingsModelOption[]>;
  /**
   * Writes these values (each field present is set), only while the Bot is
   * still at `expectedRevision`; otherwise throws `BotSettingsConflictError`.
   */
  write(botId: string, patch: BotSettingsPatch, expectedRevision: string): Promise<void>;
  appendEntry(botId: string, kind: string, data: Record<string, unknown>): Promise<void>;
  now?(): number;
  newId?(): string;
}

type Append = (kind: string, data: Record<string, unknown>) => Promise<void>;

interface StoredChange {
  changeId: string;
  mode: "applied" | "held";
  fields: BotSettingsField[];
  /** The values before (applied) or when proposed (held), for the changed fields only. */
  before: BotSettingsPatch;
  after: BotSettingsPatch;
  /**
   * A held change's own arguments, as the Bot sent them: Apply merges them
   * onto the settings as they are then, so a quiet-hours or look edit made
   * since is kept. Older records without it apply `after`.
   */
  requested?: Record<string, unknown>;
  /** False when Undo can't put the change back: the Bot had no model of its own before. */
  undoable?: false;
  /** `pending` until answered: a held change waits for Apply; an applied one can be undone. */
  status: "pending" | BotSettingsChangeStatus;
  createdAt: number;
  decidedAt?: number;
}

export type BotSettingsRespondResult =
  | { ok: true; status: BotSettingsChangeStatus; message?: string }
  | { ok: false; message: string };

function pick(values: BotSettingsValues, fields: readonly BotSettingsField[]): BotSettingsPatch {
  const patch: BotSettingsPatch = {};
  for (const field of fields) (patch as Record<string, unknown>)[field] = structuredClone(values[field]);
  return patch;
}

function modelText(models: readonly BotSettingsModelOption[]) {
  return (model: BotSettingsModel | null) =>
    model === null ? "None" : models.find((option) => option.providerId === model.providerId && option.modelId === model.modelId)?.label ?? model.modelId;
}

export function createBotSettingsChangeService(ports: BotSettingsPorts) {
  const now = ports.now ?? Date.now;
  const newId = ports.newId ?? randomUUID;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(ports.profileDir(), botId), BOT_SETTINGS_CHANGES_FILE);

  async function load(botId: string): Promise<StoredChange[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredChange[]).filter((record) => typeof record?.changeId === "string") : [];
    } catch {
      return [];
    }
  }

  async function save(botId: string, records: StoredChange[]): Promise<void> {
    // Keep every held change still waiting, and the latest settled ones (Undo reads them).
    const settled = new Set(records.filter((record) => !(record.mode === "held" && record.status === "pending")).slice(-SETTLED_KEPT));
    await writeJsonAtomic(fileOf(botId), records.filter((record) => settled.has(record) || (record.mode === "held" && record.status === "pending")), {
      mode: 0o600,
      mkdirMode: 0o700,
    });
  }

  async function modelAllowed(botId: string, model: BotSettingsModel | null | undefined): Promise<string | undefined> {
    if (model === undefined) return undefined;
    if (model === null) return "update_bot can't take a Bot's model away.";
    const models = await ports.models(botId);
    if (models.some((option) => option.providerId === model.providerId && option.modelId === model.modelId)) return undefined;
    return models.length === 0
      ? "No other models are connected on this device. The person adds providers in Settings → Providers."
      : `That model isn't one of the connected ones. Choose from: ${models.map((option) => `${option.label} (${option.providerId} / ${option.modelId})`).join("; ")}.`;
  }

  async function settle(botId: string, record: StoredChange, status: BotSettingsChangeStatus, records: StoredChange[], append: Append): Promise<void> {
    record.status = status;
    record.decidedAt = now();
    await save(botId, records);
    await append(BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND, { changeId: record.changeId, status });
  }

  return {
    /**
     * The Bot's `update_bot`. `owner` is whether the person alone started this
     * run; `readOutside` whether its conversation already read content from
     * outside the chat (the tool counts a history it can't read as having). Returns the tool's text; throws with a message the Bot can read
     * when the change is refused.
     */
    call(botId: string, raw: unknown, context: { owner: boolean; readOutside?: boolean; append?: Append }): Promise<string> {
      const append: Append = context.append ?? ((kind, data) => ports.appendEntry(botId, kind, data));
      return serial(botId, async () => {
        const { values: current, revision } = await ports.read(botId);
        const isEmpty = raw === undefined || raw === null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0);
        if (isEmpty) {
          const models = await ports.models(botId);
          return JSON.stringify({
            settings: current,
            models,
            changes: [...BOT_SETTINGS_FIELDS],
            note: "Change only what the person asked for. Access, tools, connections, other Bots, Bot messaging, the computer, approvals and spending are the person's to change in this Bot's settings.",
          });
        }
        const parsed = parseBotSettingsArgs(raw, current);
        if (!parsed.ok) throw new Error(parsed.error);
        const refusal = await modelAllowed(botId, parsed.patch.model);
        if (refusal) throw new Error(refusal);
        const fields = changedBotSettingsFields(current, parsed.patch);
        if (fields.length === 0) return "Nothing changed: those are already this Bot's settings.";
        const next: BotSettingsValues = { ...current, ...parsed.patch };
        const models = parsed.patch.model ? await ports.models(botId) : [];
        const lines = fields.map((field) => botSettingsLine(field, current, next, modelText(models)));
        const records = await load(botId);
        // Words from outside the chat may be steering the Bot, and reaching out
        // more on its own is the person's call: both wait, like any run not theirs.
        const reason: BotSettingsHeldReason | undefined = !context.owner ? "not_owner"
          : context.readOutside === true ? "outside_content"
            : botSettingsPatchWidens(current, parsed.patch) ? "widens" : undefined;
        const before = pick(current, fields);
        const record: StoredChange = {
          changeId: newId(),
          mode: reason === undefined ? "applied" : "held",
          fields,
          before,
          after: pick(next, fields),
          ...(reason !== undefined ? { requested: structuredClone(raw) as Record<string, unknown> } : {}),
          // A Bot with no model of its own can't be put back to none.
          ...(reason === undefined && fields.includes("model") && before.model === null ? { undoable: false as const } : {}),
          status: "pending",
          createdAt: now(),
        };
        if (reason !== undefined) {
          if (records.filter((stored) => stored.mode === "held" && stored.status === "pending").length >= PENDING_LIMIT) {
            throw new Error("The person already has settings changes to look at. Wait for their answer.");
          }
        } else {
          await ports.write(botId, record.after, revision);
        }
        records.push(record);
        await save(botId, records);
        const entry: BotSettingsChangeEntryData = {
          changeId: record.changeId,
          mode: record.mode,
          fields,
          lines,
          ...(reason !== undefined && record.after.instructions !== undefined
            ? { instructions: record.after.instructions, previousInstructions: current.instructions }
            : {}),
          ...(reason !== undefined ? { heldReason: reason } : {}),
          ...(record.undoable === false ? { undoable: false as const } : {}),
        };
        await append(BOT_SETTINGS_CHANGE_ENTRY_KIND, { ...entry });
        if (reason === undefined) {
          return record.undoable === false
            ? `${botSettingsReceiptLabel(fields)}: ${lines.join("; ")}. This change can't be undone from the chat; the person changes the model in this Bot's settings.`
            : `${botSettingsReceiptLabel(fields)}: ${lines.join("; ")}. The person can undo it from the chat.`;
        }
        const why = reason === "not_owner" ? "This run wasn't started by the person"
          : reason === "outside_content" ? "This conversation has read content from outside the chat"
            : "Reaching out more on your own is the person's call";
        return `${botSettingsHeldTitle(fields)} ${why}, so the change waits for them to apply it: ${lines.join("; ")}.`;
      });
    },

    /** The person's answer: Undo an applied change, or Apply, Edit or Dismiss a held one. */
    respond(botId: string, changeId: string, decision: BotSettingsChangeDecision, append?: Append): Promise<BotSettingsRespondResult> {
      const write: Append = append ?? ((kind, data) => ports.appendEntry(botId, kind, data));
      return serial(botId, async () => {
        const records = await load(botId);
        const record = records.find((stored) => stored.changeId === changeId);
        if (!record || record.status !== "pending") return { ok: false, message: "This change was already answered." };
        if (decision === "undo") {
          if (record.mode !== "applied") return { ok: false, message: "This change hasn't been applied." };
          // No model to go back to: Undo would leave the new one and still say Restored.
          if (record.undoable === false || (record.fields.includes("model") && !record.before.model)) {
            return { ok: false, message: "This change can't be undone here. Change the model in this Bot's settings." };
          }
          const { values: current, revision } = await ports.read(botId);
          const after = { ...current, ...record.after } as BotSettingsValues;
          const unchanged = record.fields.every((field) => sameBotSettingsValue(field, current, after));
          const refused = async (): Promise<BotSettingsRespondResult> => {
            await settle(botId, record, "undo_refused", records, write);
            return { ok: true, status: "undo_refused", message: BOT_SETTINGS_UNDO_REFUSED_MESSAGE };
          };
          if (!unchanged) return refused();
          try {
            await ports.write(botId, record.before, revision);
          } catch (error) {
            // Changed between the read and the write: the newer edit stays.
            if (error instanceof BotSettingsConflictError) return refused();
            throw error;
          }
          await settle(botId, record, "restored", records, write);
          return { ok: true, status: "restored" };
        }
        if (record.mode !== "held") return { ok: false, message: "This change was already applied." };
        if (decision === "dismiss") {
          await settle(botId, record, "dismissed", records, write);
          return { ok: true, status: "dismissed" };
        }
        if (decision === "edited") {
          // The person saved their own version of the instructions in the editor.
          await settle(botId, record, "edited", records, write);
          return { ok: true, status: "edited" };
        }
        const { values: current, revision } = await ports.read(botId);
        let patch = record.after;
        if (record.requested !== undefined) {
          // Only what the Bot asked for, merged onto the settings as they are now.
          const parsed = parseBotSettingsArgs(record.requested, current);
          if (!parsed.ok) return { ok: false, message: "This change can't be applied any more." };
          patch = parsed.patch;
        }
        const refusal = await modelAllowed(botId, patch.model);
        if (refusal) return { ok: false, message: "That model isn't connected any more." };
        try {
          await ports.write(botId, patch, revision);
        } catch (error) {
          if (error instanceof BotSettingsConflictError) return { ok: false, message: "This Bot's settings changed just now. Try Apply again." };
          throw error;
        }
        await settle(botId, record, "applied", records, write);
        return { ok: true, status: "applied" };
      });
    },
  };
}

export type BotSettingsChangeService = ReturnType<typeof createBotSettingsChangeService>;
