/**
 * What the desktop approval card shows for a coding tool call: the exact
 * command, or the lines a file change removes and adds. The main process builds
 * it from the call's own arguments and sends it only to the window that owns
 * the chat. Paired devices and run observers never receive it; they keep the
 * approval summary.
 */

export type ToolApprovalPreviewLine = {
  type: "context" | "removed" | "added";
  text: string;
};

export type ToolApprovalPreview =
  | { kind: "command"; command: string }
  | {
      kind: "file";
      operation: "edit" | "write";
      path: string;
      lines: ToolApprovalPreviewLine[];
      /** Changed lines in the whole call, including ones left out of `lines`. */
      added: number;
      removed: number;
      /** Lines of the change that `lines` leaves out. */
      omittedLines: number;
    };

/** Lines a file preview shows before it says how many more there are. */
export const TOOL_APPROVAL_PREVIEW_MAX_LINES = 40;
/** Unchanged lines kept around an edit, on each side. */
const CONTEXT_LINES = 2;
const MAX_LINE_LENGTH = 400;
const MAX_PATH_LENGTH = 1_024;

function previewText(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n?/gu, "\n").split("\n");
}

/** A whole file's lines: its final newline ends the last line rather than starting another. */
function fileLines(content: string): string[] {
  const lines = splitLines(content);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function bounded(lines: ToolApprovalPreviewLine[]): { lines: ToolApprovalPreviewLine[]; omittedLines: number } {
  const shown = lines.slice(0, TOOL_APPROVAL_PREVIEW_MAX_LINES).map((line) => ({ ...line, text: previewText(line.text) }));
  return { lines: shown, omittedLines: lines.length - shown.length };
}

/** An exact-substring edit as context, removed and added lines. */
function editPreview(path: string, oldText: string, newText: string): ToolApprovalPreview {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const lines: ToolApprovalPreviewLine[] = [
    ...before.slice(Math.max(0, prefix - CONTEXT_LINES), prefix).map((text) => ({ type: "context" as const, text })),
    ...removed.map((text) => ({ type: "removed" as const, text })),
    ...added.map((text) => ({ type: "added" as const, text })),
    ...before
      .slice(before.length - suffix, before.length - suffix + CONTEXT_LINES)
      .map((text) => ({ type: "context" as const, text })),
  ];
  return { kind: "file", operation: "edit", path, added: added.length, removed: removed.length, ...bounded(lines) };
}

/**
 * The preview for a coding tool call that needs approval, or undefined when the
 * tool has none or its arguments are not the expected strings.
 */
export function toolApprovalPreview(toolName: string, args: unknown): ToolApprovalPreview | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  if (toolName === "run_command") {
    return typeof a.command === "string" && a.command.trim() ? { kind: "command", command: a.command } : undefined;
  }
  if (typeof a.path !== "string" || !a.path.trim() || a.path.length > MAX_PATH_LENGTH) return undefined;
  if (toolName === "edit_file" && typeof a.old_string === "string" && typeof a.new_string === "string") {
    return editPreview(a.path, a.old_string, a.new_string);
  }
  if (toolName === "write_file" && typeof a.content === "string") {
    const lines = fileLines(a.content).map((text) => ({ type: "added" as const, text }));
    return { kind: "file", operation: "write", path: a.path, added: lines.length, removed: 0, ...bounded(lines) };
  }
  return undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Validates a preview received over IPC. Anything malformed is dropped, never repaired. */
export function parseToolApprovalPreview(value: unknown): ToolApprovalPreview | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind === "command") {
    return typeof v.command === "string" && v.command.trim() ? { kind: "command", command: v.command } : undefined;
  }
  if (v.kind !== "file" || (v.operation !== "edit" && v.operation !== "write")) return undefined;
  if (typeof v.path !== "string" || !v.path.trim() || v.path.length > MAX_PATH_LENGTH) return undefined;
  if (!Array.isArray(v.lines) || v.lines.length > TOOL_APPROVAL_PREVIEW_MAX_LINES) return undefined;
  const lines: ToolApprovalPreviewLine[] = [];
  for (const entry of v.lines as unknown[]) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { type, text } = entry as Record<string, unknown>;
    if ((type !== "context" && type !== "removed" && type !== "added") || typeof text !== "string") return undefined;
    lines.push({ type, text: previewText(text) });
  }
  const added = count(v.added);
  const removed = count(v.removed);
  const omittedLines = count(v.omittedLines);
  if (added === undefined || removed === undefined || omittedLines === undefined) return undefined;
  return { kind: "file", operation: v.operation, path: v.path, lines, added, removed, omittedLines };
}
