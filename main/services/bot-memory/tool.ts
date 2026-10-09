// The `bot_memory` tool (spec 2026-10-09 §7).
//
// Main-owned and needs no file authority or approval: it writes only this
// Bot's own memory files. It is offered on attended turns and withheld on
// `routine:` and `intro:` turns, so content injected into an unattended run
// never reaches long-term memory (routines keep `routine_notes` instead).
//
// One call applies a batch to one store atomically; the budget is checked on
// the final result, so a full store is consolidated in a single call. The
// result is compact JSON the model reads back as the live state (the prompt
// snapshot stays frozen until the next session).
//
// Replay is `unsafe`: an interrupted batch becomes an interrupted error and
// the model reads the live state from its next result.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BotMemoryTarget } from "../../../renderer/shared/bot-memory.js";
import { BOT_INTRO_REQUEST_PREFIX } from "../bot-runtime/bot-intro.js";
import type { BotToolEntry } from "../bot-runtime/bot-extension.js";
import { memoryLimit, usedChars } from "./files.js";
import type { BotMemoryRuntime } from "./service.js";
import type { BotMemoryApplyResult, BotMemoryOperation } from "./store.js";

export const BOT_MEMORY_TOOL_NAME = "bot_memory";
export const BOT_MEMORY_MAX_OPERATIONS = 8;

/** `details` of a `bot_memory` result; the live projection reads `changed`. */
export interface BotMemoryToolDetails {
  [key: string]: number | BotMemoryTarget[];
  changed: number;
  targets: BotMemoryTarget[];
}

const DESCRIPTION = [
  "Save what will matter in future conversations with this person. Saved memory is shown to you at the start of every conversation, so keep it short and useful.",
  "",
  "TARGETS: 'user' is about the person and their world (who they are, family, places, routines, standing preferences). 'memory' is your own notes (promises or follow-ups you committed to, how you help them best, things you learned while helping).",
  "",
  "SAVE: durable facts, standing preferences, commitments you made. SKIP: one-off requests, anything already in your instructions, passwords or other secrets, raw dumps, progress on the current task.",
  "",
  "Write declarative facts (\"Prefers short answers.\"), never commands to yourself.",
  "",
  "HOW: make every change in ONE call. List all operations; they apply together and the size limit is checked only on the final result. 'replace' and 'remove' locate one entry by 'match' (its exact text, or a part of it that only that entry contains). For 'replace', 'content' is the WHOLE new entry.",
  "",
  "IF FULL: the call is refused and shows the store's entries. Retry as ONE call that removes or shortens stale entries and adds the new one.",
].join("\n");

const ADD_ONLY_NOTE = "\n\nOnly 'add' is available here.";

const parameters = Type.Object({
  target: Type.Union([Type.Literal("memory"), Type.Literal("user")], {
    description: "'user' for facts about the person, 'memory' for your own notes.",
  }),
  operations: Type.Array(
    Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
      content: Type.Optional(
        Type.String({ description: "The entry text for 'add', or the WHOLE new entry for 'replace'." }),
      ),
      match: Type.Optional(
        Type.String({ description: "For 'replace' and 'remove': the entry's text, or a part only that entry contains." }),
      ),
    }),
    { minItems: 1, maxItems: BOT_MEMORY_MAX_OPERATIONS, description: "Applied together, in order." },
  ),
});

type RawOperation = { action: "add" | "replace" | "remove"; content?: string; match?: string };

function formatUsage(texts: readonly string[], target: BotMemoryTarget): string {
  return `${usedChars(texts).toLocaleString("en-US")}/${memoryLimit(target).toLocaleString("en-US")}`;
}

function toOperations(raw: readonly RawOperation[]): BotMemoryOperation[] | string {
  const operations: BotMemoryOperation[] = [];
  for (const [index, operation] of raw.entries()) {
    const label = `Operation ${index + 1} (${operation.action})`;
    if (operation.action === "add") {
      if (typeof operation.content !== "string") return `${label} needs 'content'.`;
      operations.push({ action: "add", content: operation.content });
    } else if (operation.action === "replace") {
      if (typeof operation.match !== "string" || typeof operation.content !== "string") {
        return `${label} needs 'match' and 'content'.`;
      }
      operations.push({ action: "replace", match: operation.match, content: operation.content });
    } else {
      if (typeof operation.match !== "string") return `${label} needs 'match'.`;
      operations.push({ action: "remove", match: operation.match });
    }
  }
  return operations;
}

function resultOf(text: unknown, details: BotMemoryToolDetails, isError: boolean): AgentToolResult<BotMemoryToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(text) }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/** The model-facing JSON for an applied batch. */
export function botMemoryToolResult(result: BotMemoryApplyResult): AgentToolResult<BotMemoryToolDetails> {
  if (result.ok) {
    return resultOf(
      { ok: true, target: result.target, changed: result.changed, usage: formatUsage(result.texts, result.target), entries: result.texts },
      { changed: result.changed, targets: result.changed > 0 ? [result.target] : [] },
      false,
    );
  }
  return resultOf(
    {
      ok: false,
      code: result.code,
      target: result.target,
      usage: formatUsage(result.texts, result.target),
      error: result.error,
      ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
      entries: result.texts,
    },
    { changed: 0, targets: [] },
    true,
  );
}

export interface BotMemoryToolOptions {
  /** Background review and compaction flush: `replace` and `remove` are refused. */
  addOnly?: boolean;
}

export function createBotMemoryTool(
  botId: string,
  memory: Pick<BotMemoryRuntime, "apply">,
  options: BotMemoryToolOptions = {},
): AgentTool<typeof parameters, BotMemoryToolDetails> {
  return {
    name: BOT_MEMORY_TOOL_NAME,
    label: "Memory",
    description: options.addOnly ? DESCRIPTION + ADD_ONLY_NOTE : DESCRIPTION,
    parameters,
    async execute(_toolCallId, params) {
      const { target, operations: raw } = params as { target: BotMemoryTarget; operations: RawOperation[] };
      if (raw.length > BOT_MEMORY_MAX_OPERATIONS) {
        return resultOf(
          { ok: false, code: "invalid", target, error: `At most ${BOT_MEMORY_MAX_OPERATIONS} operations per call.` },
          { changed: 0, targets: [] },
          true,
        );
      }
      const operations = toOperations(raw);
      if (typeof operations === "string") {
        return resultOf({ ok: false, code: "invalid", target, error: operations }, { changed: 0, targets: [] }, true);
      }
      return botMemoryToolResult(await memory.apply(botId, target, operations, { addOnly: options.addOnly === true }));
    },
  };
}

/** The attended-turn entry `bot-session-main` adds to every Bot's tools. */
export function botMemoryToolEntry(botId: string, memory: Pick<BotMemoryRuntime, "apply">): BotToolEntry {
  return { tool: createBotMemoryTool(botId, memory) as unknown as AgentTool, replay: "unsafe" };
}

/** Whether a run serving inputs with these request ids may save memory: never on routine or self-intro turns. */
export function botMemoryAllowed(requestIds: readonly (string | undefined)[]): boolean {
  return !requestIds.some((id) => id?.startsWith("routine:") || id?.startsWith(BOT_INTRO_REQUEST_PREFIX));
}

/** Wrap the ingress rule so `bot_memory` follows `botMemoryAllowed` and every other tool `base`. */
export function withBotMemoryIngress(
  base: (name: string, requestIds: readonly (string | undefined)[]) => boolean,
): (name: string, requestIds: readonly (string | undefined)[]) => boolean {
  return (name, requestIds) => (name === BOT_MEMORY_TOOL_NAME ? botMemoryAllowed(requestIds) : base(name, requestIds));
}
