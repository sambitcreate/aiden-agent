import {
  BOT_LIMITS,
  isBotAvatar,
  parseBotChatActivity,
  parseBotInterruptions,
  type BotCreateInput,
  type BotUpdateInput,
} from "../../renderer/shared/bots.js";
import {
  isBoundedBotText,
  isPathSafeBotCapabilityId,
  parseBotAccessUpdate,
  type BotAccessUpdate,
} from "../../renderer/shared/bot-capabilities.js";
import type { BotMemoryEditInput, BotMemoryTarget } from "../../renderer/shared/bot-memory.js";
import { BOT_HANDOFF_NOTE_MAX_CHARS, type BotHandoffOutcome } from "../../renderer/shared/bot-handoffs.js";
import { isBotRuleBehavior, type BotRuleBehavior, type BotRuleChange, type BotRulesUpdateInput } from "../../renderer/shared/bot-rules.js";
import {
  ASK_USER_MAX_CUSTOM_ANSWER_LENGTH,
  ASK_USER_MAX_LABEL_LENGTH,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_QUESTION_VERSION,
  type AskUserQuestionAnswerV1,
  type AskUserQuestionResponseV1,
} from "../../renderer/shared/ask-user-question.js";

const CREATE_KEYS = new Set([
  "avatar",
  "description",
  "instructions",
  "name",
]);
const CREATE_WITH_ACCESS_KEYS = new Set(["access", "bot"]);
const UPDATE_KEYS = new Set([...CREATE_KEYS, "chatActivity", "interruptions", "expectedRevision", "id"]);
const CHAT_KEYS = new Set(["botId", "model", "providerId", "workspaceId"]);
const ACCESS_UPDATE_KEYS = new Set(["access", "botId", "expectedRevision"]);
function exact(value: unknown, keys: ReadonlySet<string>, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count > keys.size || !keys.has(key)) throw new Error(`Invalid ${label}.`);
  }
  return record;
}

function text(value: unknown, label: string, maximum: number, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || !isBoundedBotText(value, maximum))
    throw new Error(`Invalid ${label}.`);
  return value;
}

function createFields(record: Record<string, unknown>): BotCreateInput {
  if (!isBotAvatar(record.avatar)) throw new Error("Invalid bot avatar.");
  return {
    name: text(record.name, "bot name", BOT_LIMITS.nameChars)!,
    description: text(record.description, "bot description", BOT_LIMITS.descriptionChars, true),
    instructions: text(record.instructions, "bot instructions", BOT_LIMITS.instructionsChars)!,
    avatar: record.avatar,
  };
}

export function parseBotCreate(value: unknown): BotCreateInput {
  return createFields(exact(value, CREATE_KEYS, "bot creation fields"));
}

export function parseBotCreateWithAccess(value: unknown): {
  bot: BotCreateInput;
  access: BotAccessUpdate;
} {
  const record = exact(value, CREATE_WITH_ACCESS_KEYS, "bot creation fields");
  return {
    bot: parseBotCreate(record.bot),
    access: parseBotAccessUpdate(record.access),
  };
}

const FROM_PRESET_KEYS = new Set(["access", "presetId"]);
const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** `bots:createFromPreset`: a starter Bot id and, optionally, the access the person confirmed. */
export function parseBotCreateFromPreset(value: unknown): { presetId: string; access?: BotAccessUpdate } {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || Array.isArray(record) || !Object.keys(record).every((key) => FROM_PRESET_KEYS.has(key))) {
    throw new Error("Invalid starter Bot fields.");
  }
  if (typeof record.presetId !== "string" || !PRESET_ID.test(record.presetId)) {
    throw new Error("Invalid starter Bot id.");
  }
  return {
    presetId: record.presetId,
    ...(record.access === undefined ? {} : { access: parseBotAccessUpdate(record.access) }),
  };
}

/** A catalog plugin id, as stored by connection dismissals. */
export function parseConnectionPluginId(value: unknown): string {
  if (typeof value !== "string" || !PRESET_ID.test(value)) throw new Error("Invalid connection id.");
  return value;
}

export function parseBotUpdate(value: unknown): BotUpdateInput {
  const record = exact(value, UPDATE_KEYS, "bot update fields");
  const chatActivity = record.chatActivity === undefined ? undefined : parseBotChatActivity(record.chatActivity);
  if (record.chatActivity !== undefined && !chatActivity) throw new Error("Invalid bot chat activity.");
  return {
    id: parseBotId(record.id),
    expectedRevision: parseBotRevision(record.expectedRevision),
    ...createFields(record),
    ...(chatActivity ? { chatActivity } : {}),
    ...(record.interruptions !== undefined ? { interruptions: parseBotInterruptions(record.interruptions) } : {}),
  };
}

export function parseBotRevision(value: unknown): string {
  if (!isPathSafeBotCapabilityId(value, 128)) {
    throw new Error("Invalid bot revision.");
  }
  return value;
}

export function parseBotId(value: unknown): string {
  if (!isPathSafeBotCapabilityId(value, BOT_LIMITS.idChars)) {
    throw new Error("Invalid bot id.");
  }
  return value;
}

const BOT_SESSION_REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

const BOT_SEND_KEYS = new Set(["botId", "text", "requestId", "whenBusy", "attachments"]);
const BOT_SEND_TEXT_CHARS = 100_000;
const BOT_SEND_ATTACHMENTS = 20;
const BOT_SEND_IMAGE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4;
const BOT_SEND_IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/u;

/** A desktop message to a Bot: its renderer send UUID is the durable request id. */
export function parseBotSend(input: unknown): {
  botId: string;
  text: string;
  requestId: string;
  whenBusy?: "steer" | "followUp";
  attachments?: Array<{ type: "image"; mimeType: string; data: string }>;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid bot message fields.");
  const fields = input as Record<string, unknown>;
  if (!Object.keys(fields).every((key) => BOT_SEND_KEYS.has(key))) throw new Error("Invalid bot message fields.");
  if (typeof fields.text !== "string" || fields.text.length > BOT_SEND_TEXT_CHARS) {
    throw new Error("Invalid bot message text.");
  }
  if (typeof fields.requestId !== "string" || !BOT_SESSION_REQUEST_ID.test(fields.requestId)) {
    throw new Error("Invalid bot message request id.");
  }
  if (fields.whenBusy !== undefined && fields.whenBusy !== "steer" && fields.whenBusy !== "followUp") {
    throw new Error("Invalid bot message busy mode.");
  }
  let attachments: Array<{ type: "image"; mimeType: string; data: string }> | undefined;
  if (fields.attachments !== undefined) {
    if (!Array.isArray(fields.attachments) || fields.attachments.length > BOT_SEND_ATTACHMENTS) {
      throw new Error("Invalid bot message attachments.");
    }
    attachments = fields.attachments.map((value) => {
      const item = value as Record<string, unknown> | null;
      if (
        !item ||
        item.type !== "image" ||
        typeof item.mimeType !== "string" ||
        !BOT_SEND_IMAGE_MIME.test(item.mimeType) ||
        typeof item.data !== "string" ||
        item.data.length === 0 ||
        item.data.length > BOT_SEND_IMAGE_BASE64_CHARS ||
        Object.keys(item).some((key) => key !== "type" && key !== "mimeType" && key !== "data")
      ) {
        throw new Error("Invalid bot message attachments.");
      }
      return { type: "image" as const, mimeType: item.mimeType, data: item.data };
    });
  }
  if (fields.text.trim().length === 0 && (attachments?.length ?? 0) === 0) {
    throw new Error("A bot message needs text or an image.");
  }
  return {
    botId: parseBotId(fields.botId),
    text: fields.text,
    requestId: fields.requestId,
    ...(fields.whenBusy === undefined ? {} : { whenBusy: fields.whenBusy as "steer" | "followUp" }),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

/** `{ botId, requestId }` for Resume and Dismiss; the request id makes retries idempotent. */
export function parseBotSessionAction(
  input: unknown,
  action: "resume" | "dismiss",
): { botId: string; requestId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Invalid bot ${action} fields.`);
  }
  const fields = input as Record<string, unknown>;
  if (!Object.keys(fields).every((key) => key === "botId" || key === "requestId")) {
    throw new Error(`Invalid bot ${action} fields.`);
  }
  if (typeof fields.requestId !== "string" || !BOT_SESSION_REQUEST_ID.test(fields.requestId)) {
    throw new Error(`Invalid bot ${action} request id.`);
  }
  return { botId: parseBotId(fields.botId), requestId: fields.requestId };
}

/** At most 15 digits, so `Number()` stays exact (below 2^53). */
const BOT_SUBMISSION_ID = /^\d{1,15}$/u;

/** Remove on a queued message: the Bot and one durable submission id. */
export function parseBotWithdraw(input: unknown): { botId: string; submissionId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid bot withdraw fields.");
  const fields = input as Record<string, unknown>;
  if (!Object.keys(fields).every((key) => key === "botId" || key === "submissionId")) {
    throw new Error("Invalid bot withdraw fields.");
  }
  if (typeof fields.submissionId !== "string" || !BOT_SUBMISSION_ID.test(fields.submissionId)) {
    throw new Error("Invalid bot submission id.");
  }
  return { botId: parseBotId(fields.botId), submissionId: fields.submissionId };
}

const BOT_APPROVAL_WAIT_ID = /^[A-Za-z0-9-]{1,64}$/u;

/** A Bot approval answer: the durable `waitId` and allow or deny. */
export function parseBotApprovalDecision(input: unknown): { waitId: string; decision: "allow" | "deny" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid bot approval fields.");
  const fields = input as Record<string, unknown>;
  if (!Object.keys(fields).every((key) => key === "waitId" || key === "decision")) {
    throw new Error("Invalid bot approval fields.");
  }
  if (typeof fields.waitId !== "string" || !BOT_APPROVAL_WAIT_ID.test(fields.waitId)) {
    throw new Error("Invalid bot approval id.");
  }
  if (fields.decision !== "allow" && fields.decision !== "deny") throw new Error("Invalid bot approval decision.");
  return { waitId: fields.waitId, decision: fields.decision };
}

const ANSWER_KEYS = new Set(["botId", "waitId", "answer"]);
const RESPONSE_KEYS = new Set(["version", "promptId", "cancelled", "answers"]);
const TEXT_ANSWER_KEYS = new Set(["questionIndex", "kind", "answer"]);
const MULTI_ANSWER_KEYS = new Set(["questionIndex", "kind", "selected"]);

function questionAnswerItem(value: unknown): AskUserQuestionAnswerV1 {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  const record = exact(value, kind === "multi" ? MULTI_ANSWER_KEYS : TEXT_ANSWER_KEYS, "bot question answer");
  const questionIndex = record.questionIndex;
  if (!Number.isSafeInteger(questionIndex) || (questionIndex as number) < 0 || (questionIndex as number) >= ASK_USER_MAX_QUESTIONS) {
    throw new Error("Invalid bot question answer.");
  }
  const index = questionIndex as number;
  if (kind === "multi") {
    const selected = record.selected;
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > ASK_USER_MAX_OPTIONS) {
      throw new Error("Invalid bot question answer.");
    }
    return {
      questionIndex: index,
      kind,
      selected: selected.map((label) => text(label, "bot question answer", ASK_USER_MAX_LABEL_LENGTH)!),
    };
  }
  if (kind !== "option" && kind !== "custom") throw new Error("Invalid bot question answer.");
  const maximum = kind === "custom" ? ASK_USER_MAX_CUSTOM_ANSWER_LENGTH : ASK_USER_MAX_LABEL_LENGTH;
  return { questionIndex: index, kind, answer: text(record.answer, "bot question answer", maximum)! };
}

/**
 * A Bot question answer: the Bot, the durable `waitId`, and the quick-reply
 * card's response for that wait (`promptId` must be the `waitId`). Option
 * membership and the question count are checked against the waiting question
 * itself when it settles.
 */
export function parseBotQuestionAnswer(input: unknown): { botId: string; waitId: string; answer: AskUserQuestionResponseV1 } {
  const fields = exact(input, ANSWER_KEYS, "bot question answer fields");
  if (typeof fields.waitId !== "string" || !BOT_APPROVAL_WAIT_ID.test(fields.waitId)) {
    throw new Error("Invalid bot question id.");
  }
  const response = exact(fields.answer, RESPONSE_KEYS, "bot question answer");
  if (
    response.version !== ASK_USER_QUESTION_VERSION ||
    response.promptId !== fields.waitId ||
    typeof response.cancelled !== "boolean" ||
    !Array.isArray(response.answers) ||
    response.answers.length > ASK_USER_MAX_QUESTIONS
  ) {
    throw new Error("Invalid bot question answer.");
  }
  return {
    botId: parseBotId(fields.botId),
    waitId: fields.waitId,
    answer: {
      version: ASK_USER_QUESTION_VERSION,
      promptId: fields.waitId,
      cancelled: response.cancelled,
      answers: response.answers.map(questionAnswerItem),
    },
  };
}

const HANDOFF_ANSWER_KEYS = new Set(["botId", "waitId", "outcome", "note"]);
const HANDOFF_OPEN_KEYS = new Set(["botId", "waitId"]);

function handoffWaitId(value: unknown): string {
  if (typeof value !== "string" || !BOT_APPROVAL_WAIT_ID.test(value)) throw new Error("Invalid bot hand-off id.");
  return value;
}

/** A hand-off card answer: the Bot, the durable `waitId`, Done or Skip, and an optional note. */
export function parseBotHandoffAnswer(input: unknown): {
  botId: string;
  waitId: string;
  outcome: BotHandoffOutcome;
  note?: string;
} {
  const fields = exact(input, HANDOFF_ANSWER_KEYS, "bot hand-off answer fields");
  const waitId = handoffWaitId(fields.waitId);
  if (fields.outcome !== "done" && fields.outcome !== "skipped") throw new Error("Invalid bot hand-off answer.");
  const note = text(fields.note, "bot hand-off note", BOT_HANDOFF_NOTE_MAX_CHARS, true);
  return {
    botId: parseBotId(fields.botId),
    waitId,
    outcome: fields.outcome,
    ...(note === undefined ? {} : { note }),
  };
}

/** Open on a hand-off card: the Bot and the durable `waitId`. */
export function parseBotHandoffOpen(input: unknown): { botId: string; waitId: string } {
  const fields = exact(input, HANDOFF_OPEN_KEYS, "bot hand-off fields");
  return { botId: parseBotId(fields.botId), waitId: handoffWaitId(fields.waitId) };
}

export function parseBotChatCreate(value: unknown) {
  const record = exact(value, CHAT_KEYS, "bot chat creation fields");
  // Legacy desktop renderers still send the visible workspace selection. Bot
  // chats now always use their main-owned hidden home, so accept but ignore it.
  if (record.workspaceId !== undefined) {
    text(record.workspaceId, "workspace id", 256);
  }
  return {
    botId: parseBotId(record.botId),
    providerId: text(record.providerId, "provider id", 256, true),
    model: text(record.model, "model id", 512, true),
  };
}


export function parseBotAccessUpdateInput(value: unknown): {
  botId: string;
  expectedRevision: string;
  access: BotAccessUpdate;
} {
  const record = exact(value, ACCESS_UPDATE_KEYS, "bot access update fields");
  return {
    botId: parseBotId(record.botId),
    expectedRevision: parseBotRevision(record.expectedRevision),
    access: parseBotAccessUpdate(record.access),
  };
}

const MEMORY_EDIT_INPUT_KEYS = new Set(["botId", "edit"]);
const MEMORY_REPLACE_KEYS = new Set(["kind", "target", "entryId", "text"]);
const MEMORY_REMOVE_KEYS = new Set(["kind", "target", "entryId"]);
const MEMORY_CLEAR_KEYS = new Set(["kind"]);
const MEMORY_ENTRY_ID = /^[0-9a-f]{16}$/u;
/** Hard bound on edit text; the service explains anything over the entry limit. */
const MEMORY_EDIT_TEXT_CHARS = 4_000;

function memoryTarget(value: unknown): BotMemoryTarget {
  if (value !== "memory" && value !== "user") throw new Error("Invalid bot memory target.");
  return value;
}

function memoryEntryId(value: unknown): string {
  if (typeof value !== "string" || !MEMORY_ENTRY_ID.test(value)) throw new Error("Invalid bot memory entry id.");
  return value;
}

/** `bots:memory:edit`: `{ botId, edit }` with exactly the keys of one edit kind. */
export function parseBotMemoryEdit(value: unknown): BotMemoryEditInput {
  const record = exact(value, MEMORY_EDIT_INPUT_KEYS, "bot memory edit");
  const botId = parseBotId(record.botId);
  const kind = (record.edit as { kind?: unknown } | null | undefined)?.kind;
  if (kind === "clear") {
    exact(record.edit, MEMORY_CLEAR_KEYS, "bot memory edit");
    return { botId, edit: { kind } };
  }
  if (kind === "remove") {
    const edit = exact(record.edit, MEMORY_REMOVE_KEYS, "bot memory edit");
    return { botId, edit: { kind, target: memoryTarget(edit.target), entryId: memoryEntryId(edit.entryId) } };
  }
  if (kind === "replace") {
    const edit = exact(record.edit, MEMORY_REPLACE_KEYS, "bot memory edit");
    if (typeof edit.text !== "string" || edit.text.length > MEMORY_EDIT_TEXT_CHARS) {
      throw new Error("Invalid bot memory text.");
    }
    return {
      botId,
      edit: { kind, target: memoryTarget(edit.target), entryId: memoryEntryId(edit.entryId), text: edit.text },
    };
  }
  throw new Error("Invalid bot memory edit.");
}

const RULES_UPDATE_KEYS = new Set(["botId", "revision", "change"]);
const RULE_CHANGE_KEYS: Readonly<Record<BotRuleChange["type"], ReadonlySet<string>>> = {
  set_behavior: new Set(["type", "ruleId", "behavior"]),
  add_custom: new Set(["type", "text", "behavior"]),
  edit_custom: new Set(["type", "ruleId", "text", "behavior"]),
  remove_custom: new Set(["type", "ruleId"]),
};
/** `locked.money`, `default.purchase`, `custom.<uuid>`; the store says whether it exists. */
const RULE_ID = /^[a-z]{1,16}\.[a-z0-9-]{1,64}$/u;
/** Hard bound on rule text; the store refuses anything over the rule limit as `invalid`, with its message. */
const RULE_TEXT_CHARS = 1_000;

function ruleId(value: unknown): string {
  if (typeof value !== "string" || !RULE_ID.test(value)) throw new Error("Invalid bot rule id.");
  return value;
}

function ruleBehavior(value: unknown): BotRuleBehavior {
  if (!isBotRuleBehavior(value)) throw new Error("Invalid bot rule behavior.");
  return value;
}

function ruleText(value: unknown): string {
  if (typeof value !== "string" || value.length > RULE_TEXT_CHARS) throw new Error("Invalid bot rule text.");
  return value;
}

function ruleChange(value: unknown): BotRuleChange {
  const type = (value as { type?: unknown } | null | undefined)?.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(RULE_CHANGE_KEYS, type)) {
    throw new Error("Invalid bot rule change.");
  }
  const change = exact(value, RULE_CHANGE_KEYS[type as BotRuleChange["type"]], "bot rule change");
  switch (type as BotRuleChange["type"]) {
    case "set_behavior":
      return { type: "set_behavior", ruleId: ruleId(change.ruleId), behavior: ruleBehavior(change.behavior) };
    case "add_custom":
      return { type: "add_custom", text: ruleText(change.text), behavior: ruleBehavior(change.behavior) };
    case "edit_custom":
      if (change.text === undefined && change.behavior === undefined) throw new Error("Invalid bot rule change.");
      return {
        type: "edit_custom",
        ruleId: ruleId(change.ruleId),
        ...(change.text === undefined ? {} : { text: ruleText(change.text) }),
        ...(change.behavior === undefined ? {} : { behavior: ruleBehavior(change.behavior) }),
      };
    case "remove_custom":
      return { type: "remove_custom", ruleId: ruleId(change.ruleId) };
  }
}

/** `bots:rules:update`: `{ botId, revision, change }` with exactly the keys of one change type. */
export function parseBotRulesUpdate(value: unknown): BotRulesUpdateInput {
  const record = exact(value, RULES_UPDATE_KEYS, "bot rules update");
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Invalid bot rules revision.");
  }
  return { botId: parseBotId(record.botId), revision, change: ruleChange(record.change) };
}
