// One Bot tool call, as the chat may show it (spec §6 "Projection changes"):
// its phase kind, a past-tense label and a short, safe detail. The detail is
// built here in main and only from allow-listed arguments: a file's base name,
// a search query or pattern, a command's own description (the model's
// plain-words summary), or the stated intent of a step in the Bot's own
// computer ("Click Place order"), never the text it types. The command itself is never shown: the redactor does
// not know shell shapes (`curl -H 'X-Api-Key: …'`, `mysql -pSecret`). Text
// passes the diagnostic redactor before it is cut to the display length.
// Arguments of connection tools are never shown.

import {
  botToolApp,
  botToolPhase,
  botToolStepLabel,
  type BotToolPhase,
} from "../../../renderer/shared/bot-activity.js";
import { sanitizeDiagnosticText } from "../diagnostics-contract.js";

export const BOT_STEP_DETAIL_CHARS = 80;
/**
 * Longest argument read before redaction. Far beyond the 80 characters shown,
 * and cut at whitespace, so a secret straddling the cut cannot reach the
 * visible part as a clipped prefix the redactor no longer recognises.
 */
const RAW_DETAIL_CHARS = 16_000;
/** Invisible format characters (bidi overrides, zero-width marks) can disguise text. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

export interface BotStepDescriptor {
  kind: BotToolPhase;
  label: string;
  detail?: string;
  app?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function baseName(value: unknown): string | undefined {
  const text = stringOf(value);
  if (!text) return undefined;
  const parts = text.replace(/\\/gu, "/").split("/").filter(Boolean);
  return parts[parts.length - 1];
}

/**
 * Drops the last word and the whitespace before it. A linear scan: the
 * equivalent `/\s+\S*$/` backtracks quadratically on long runs of spaces.
 */
function cutAtLastWhitespace(text: string): string {
  let end = text.length;
  while (end > 0 && !/\s/u.test(text[end - 1]!)) end -= 1;
  if (end === 0) return text;
  while (end > 0 && /\s/u.test(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const stripped = value.replace(FORMAT_CHARACTERS, "");
  const points = [...stripped];
  const window =
    points.length > RAW_DETAIL_CHARS ? cutAtLastWhitespace(points.slice(0, RAW_DETAIL_CHARS).join("")) : stripped;
  const clean = sanitizeDiagnosticText(window, RAW_DETAIL_CHARS);
  if (!clean) return undefined;
  const shown = [...clean];
  return shown.length > BOT_STEP_DETAIL_CHARS
    ? `${shown.slice(0, BOT_STEP_DETAIL_CHARS - 1).join("").trimEnd()}…`
    : clean;
}

function rawDetail(toolName: string, kind: BotToolPhase, args: Record<string, unknown>): string | undefined {
  switch (kind) {
    case "reading":
    case "editing":
      return toolName === "glob" || toolName === "grep"
        ? stringOf(args.pattern)
        : baseName(args.path ?? args.filePath ?? args.directory);
    case "command":
      // Only the model's own description; never the command (see the header).
      return stringOf(args.description);
    case "searching":
      return stringOf(args.query);
    case "app":
      // Only the Bot's own computer; connection tools never show arguments.
      return toolName === "computer" ? stringOf(args.intent) : undefined;
    default:
      return undefined;
  }
}

export function botStepDescriptor(toolName: string, args: unknown): BotStepDescriptor {
  const app = botToolApp(toolName);
  const kind = botToolPhase(toolName, app);
  const detail = bounded(rawDetail(toolName, kind, record(args)));
  return {
    kind,
    label: botToolStepLabel(toolName, kind, app),
    ...(detail ? { detail } : {}),
    ...(app ? { app } : {}),
  };
}
