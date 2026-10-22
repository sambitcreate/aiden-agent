// A Bot's rules on disk: `<profile>/bots/<dir>/rules.json` (plan §6.4, G6).
//
// The file holds only what the person changed: each built-in rule's behavior
// and the custom rules. Locked rules are code constants, so a tampered or
// missing file can never remove them. A missing file is the defaults; a file
// that does not parse exactly fails closed: the Bot's calls can't read their
// rules (so a call a rule would check doesn't run), the editor shows the
// defaults marked `unreadable`, and its next change starts again from them,
// replacing the file. Every edit names the revision it was made against, so
// two editors never overwrite each other silently.
//
// The Bot's directory is shared with its session database, which deleting the
// Bot removes. This store never brings that directory back for a deleted Bot:
// it writes only for a Bot the Bot store still knows, `forgetBot` refuses
// every later write in this process (checked again right before publishing),
// and it removes the file and the directory it may have recreated.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  BOT_CHANGEABLE_ACTION_CLASSES,
  BOT_CUSTOM_RULE_ID_PATTERN,
  BOT_CUSTOM_RULES_MAX,
  BOT_DEFAULT_RULES,
  BOT_LOCKED_RULES,
  BOT_RULE_TEXT_MAX_CHARS,
  isBotRuleBehavior,
  normalizeBotRuleText,
  type BotChangeableActionClass,
  type BotRule,
  type BotRuleBehavior,
  type BotRuleChange,
  type BotRuleRefusal,
  type BotRulesUpdateResult,
  type BotRulesView,
} from "../../../renderer/shared/bot-rules.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { createKeyedSerial, botSessionDirectory } from "../bot-routine-notes.js";
import { contentStems } from "./words.js";

export const BOT_RULES_FILE = "rules.json";
const FILE_VERSION = 1;

export interface BotRuleStore {
  /**
   * Missing file: the defaults, revision 0. A file that does not parse: the
   * same, marked `unreadable`. Throws when the file can't be read at all.
   */
  get(botId: string): Promise<BotRulesView>;
  /**
   * The effective rules: locked, then built-in, then custom. Throws
   * `BotRulesUnreadableError` for a file that does not parse, since the
   * defaults may be looser than what the person set.
   */
  rules(botId: string): Promise<readonly BotRule[]>;
  update(botId: string, revision: number, change: BotRuleChange): Promise<BotRulesUpdateResult>;
  /** Deleting the Bot: remove its rules and refuse every later write. */
  forgetBot(botId: string): Promise<void>;
}

export interface BotRuleStoreOptions {
  profileDir: string;
  /** Whether the Bot store still has this Bot. Writes are refused when it doesn't. */
  knownBot(botId: string): Promise<boolean>;
}

interface StoredCustomRule {
  id: string;
  text: string;
  behavior: BotRuleBehavior;
}

interface RulesFile {
  version: typeof FILE_VERSION;
  revision: number;
  behaviors: Partial<Record<BotChangeableActionClass, BotRuleBehavior>>;
  custom: StoredCustomRule[];
}

const EMPTY: RulesFile = Object.freeze({ version: FILE_VERSION, revision: 0, behaviors: {}, custom: [] }) as RulesFile;

/** The rules file is there but doesn't parse, so what the person set is unknown. */
export class BotRulesUnreadableError extends Error {
  constructor() {
    super("This Bot's rules file couldn't be read.");
    this.name = "BotRulesUnreadableError";
  }
}

export class BotRulesUnavailableError extends Error {
  constructor(message = "This Bot no longer exists.") {
    super(message);
    this.name = "BotRulesUnavailableError";
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

/** A custom rule's text as stored, or `undefined` when it is not a usable rule. */
export function validCustomRuleText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const normalized = normalizeBotRuleText(text);
  if (normalized.length === 0 || [...normalized].length > BOT_RULE_TEXT_MAX_CHARS) return undefined;
  // Only stop words ("do something") would match nothing at all.
  if (contentStems(normalized).length === 0) return undefined;
  return normalized;
}

/** The file exactly as written by this store, or `undefined`. */
function parseRulesFile(value: unknown): RulesFile | undefined {
  if (!plainObject(value) || !exactKeys(value, ["version", "revision", "behaviors", "custom"])) return undefined;
  if (value.version !== FILE_VERSION) return undefined;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return undefined;
  if (!plainObject(value.behaviors) || !Array.isArray(value.custom)) return undefined;
  const behaviors: RulesFile["behaviors"] = {};
  for (const [key, behavior] of Object.entries(value.behaviors)) {
    if (!(BOT_CHANGEABLE_ACTION_CLASSES as readonly string[]).includes(key) || !isBotRuleBehavior(behavior)) return undefined;
    behaviors[key as BotChangeableActionClass] = behavior;
  }
  if (value.custom.length > BOT_CUSTOM_RULES_MAX) return undefined;
  const ids = new Set<string>();
  const custom: StoredCustomRule[] = [];
  for (const entry of value.custom) {
    if (!plainObject(entry) || !exactKeys(entry, ["id", "text", "behavior"])) return undefined;
    if (typeof entry.id !== "string" || !BOT_CUSTOM_RULE_ID_PATTERN.test(entry.id) || ids.has(entry.id)) return undefined;
    const text = validCustomRuleText(entry.text);
    if (text === undefined || text !== entry.text || !isBotRuleBehavior(entry.behavior)) return undefined;
    ids.add(entry.id);
    custom.push({ id: entry.id, text, behavior: entry.behavior });
  }
  return { version: FILE_VERSION, revision: value.revision as number, behaviors, custom };
}

/** What's on disk: the file, or the defaults standing in for one that doesn't parse. */
interface StoredRules {
  file: RulesFile;
  unreadable: boolean;
}

function viewOf(botId: string, stored: StoredRules): BotRulesView {
  const { file } = stored;
  return {
    botId,
    revision: file.revision,
    ...(stored.unreadable ? { unreadable: true as const } : {}),
    rules: [
      ...BOT_LOCKED_RULES.map((rule) => ({ ...rule })),
      ...BOT_DEFAULT_RULES.map((rule) => ({
        ...rule,
        behavior: file.behaviors[rule.actionClass as BotChangeableActionClass] ?? rule.behavior,
      })),
      ...file.custom.map((rule) => ({ id: rule.id, text: rule.text, behavior: rule.behavior, locked: false })),
    ],
  };
}

type Applied = { ok: true; file: RulesFile } | { ok: false; reason: BotRuleRefusal };

const LOCKED_IDS = new Set(BOT_LOCKED_RULES.map((rule) => rule.id));
const BUILT_IN = new Map(BOT_DEFAULT_RULES.map((rule) => [rule.id, rule.actionClass as BotChangeableActionClass]));

/** The file after `change`, or why it is refused. Never mutates `file`. */
function applyChange(file: RulesFile, change: BotRuleChange): Applied {
  const next = (patch: Partial<RulesFile>): Applied => ({ ok: true, file: { ...file, ...patch, revision: file.revision + 1 } });
  if ("ruleId" in change && LOCKED_IDS.has(change.ruleId)) return { ok: false, reason: "locked" };
  switch (change.type) {
    case "set_behavior": {
      const actionClass = BUILT_IN.get(change.ruleId);
      if (actionClass === undefined) {
        return { ok: false, reason: file.custom.some((rule) => rule.id === change.ruleId) ? "invalid" : "not_found" };
      }
      if (!isBotRuleBehavior(change.behavior)) return { ok: false, reason: "invalid" };
      return next({ behaviors: { ...file.behaviors, [actionClass]: change.behavior } });
    }
    case "add_custom": {
      const text = validCustomRuleText(change.text);
      if (text === undefined || !isBotRuleBehavior(change.behavior)) return { ok: false, reason: "invalid" };
      if (file.custom.length >= BOT_CUSTOM_RULES_MAX) return { ok: false, reason: "limit" };
      return next({ custom: [...file.custom, { id: `custom.${randomUUID()}`, text, behavior: change.behavior }] });
    }
    case "edit_custom": {
      if (BUILT_IN.has(change.ruleId)) return { ok: false, reason: "invalid" };
      const index = file.custom.findIndex((rule) => rule.id === change.ruleId);
      if (index < 0) return { ok: false, reason: "not_found" };
      if (change.text === undefined && change.behavior === undefined) return { ok: false, reason: "invalid" };
      const text = change.text === undefined ? file.custom[index]!.text : validCustomRuleText(change.text);
      if (text === undefined) return { ok: false, reason: "invalid" };
      if (change.behavior !== undefined && !isBotRuleBehavior(change.behavior)) return { ok: false, reason: "invalid" };
      const custom = [...file.custom];
      custom[index] = { id: change.ruleId, text, behavior: change.behavior ?? file.custom[index]!.behavior };
      return next({ custom });
    }
    case "remove_custom": {
      // Built-in rules can change behavior but never go away.
      if (BUILT_IN.has(change.ruleId)) return { ok: false, reason: "locked" };
      if (!file.custom.some((rule) => rule.id === change.ruleId)) return { ok: false, reason: "not_found" };
      return next({ custom: file.custom.filter((rule) => rule.id !== change.ruleId) });
    }
    default:
      return { ok: false, reason: "invalid" };
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

export function createBotRuleStore(options: BotRuleStoreOptions): BotRuleStore {
  const serial = createKeyedSerial();
  const forgotten = new Set<string>();
  const directory = (botId: string) => botSessionDirectory(options.profileDir, botId);
  const fileOf = (botId: string) => path.join(directory(botId), BOT_RULES_FILE);

  async function read(botId: string): Promise<StoredRules> {
    let text: string;
    try {
      text = await fs.readFile(fileOf(botId), "utf8");
    } catch (error) {
      // No file (or no directory yet): nothing changed from the defaults.
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return { file: EMPTY, unreadable: false };
      throw error;
    }
    let parsed: RulesFile | undefined;
    try {
      parsed = parseRulesFile(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    return parsed === undefined ? { file: EMPTY, unreadable: true } : { file: parsed, unreadable: false };
  }

  async function ensureDirectory(botId: string): Promise<void> {
    await fs.mkdir(path.join(options.profileDir, "bots"), { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(directory(botId), { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }

  async function assertWritable(botId: string): Promise<void> {
    const known = await options.knownBot(botId);
    // Checked after the lookup, so a delete that started meanwhile still wins.
    if (!known || forgotten.has(botId)) throw new BotRulesUnavailableError();
  }

  return {
    async get(botId) {
      return viewOf(botId, await read(botId));
    },

    async rules(botId) {
      const stored = await read(botId);
      if (stored.unreadable) throw new BotRulesUnreadableError();
      return viewOf(botId, stored).rules;
    },

    update(botId, revision, change) {
      return serial(botId, async () => {
        await assertWritable(botId);
        // An unreadable file is the defaults at revision 0 here: the editor showed them, and its change replaces the file.
        const current = await read(botId);
        if (revision !== current.file.revision) return { ok: false, reason: "stale", view: viewOf(botId, current) };
        const applied = applyChange(current.file, change);
        if (!applied.ok) return { ok: false, reason: applied.reason, view: viewOf(botId, current) };
        await ensureDirectory(botId);
        await writeJsonAtomic(fileOf(botId), applied.file, {
          mode: 0o600,
          space: 2,
          trailingNewline: true,
          beforePublish: () => assertWritable(botId),
        });
        return { ok: true, view: viewOf(botId, { file: applied.file, unreadable: false }) };
      });
    },

    forgetBot(botId) {
      forgotten.add(botId);
      return serial(botId, async () => {
        await fs.rm(fileOf(botId), { force: true });
        // A write that raced the Bot's deletion may have recreated an empty directory.
        await fs.rmdir(directory(botId)).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") throw error;
        });
      });
    },
  };
}
