// One Bot tool call, as the chat may show it (spec §6 "Projection changes"):
// its phase kind, a past-tense label and a short, safe detail. The detail is
// built here in main and only from allow-listed arguments: a file's base name,
// a search query or pattern, or a command (the model's own description when it
// gave one). Text passes the diagnostic redactor before it is cut, so a secret
// is never split past it. Arguments of connection tools are never shown.

import {
  botStepPhrase,
  botToolApp,
  botToolPhase,
  type BotToolPhase,
} from "../../../renderer/shared/bot-activity.js";
import { sanitizeDiagnosticText } from "../diagnostics-contract.js";

export const BOT_STEP_DETAIL_CHARS = 80;
/** Longest argument read before redaction; enough for any useful first 80 characters. */
const RAW_DETAIL_CHARS = 4_000;

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

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeDiagnosticText([...value].slice(0, RAW_DETAIL_CHARS).join(""), RAW_DETAIL_CHARS);
  if (!clean) return undefined;
  const points = [...clean];
  return points.length > BOT_STEP_DETAIL_CHARS
    ? `${points.slice(0, BOT_STEP_DETAIL_CHARS - 1).join("").trimEnd()}…`
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
      return stringOf(args.description) ?? stringOf(args.command);
    case "searching":
      return stringOf(args.query);
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
    label: botStepPhrase(kind, 1, app),
    ...(detail ? { detail } : {}),
    ...(app ? { app } : {}),
  };
}
