/**
 * Tool-name and input-key aliases between Aiden and Claude Code, so hook
 * scripts written for Claude Code match and read Aiden's tool calls.
 *
 * Aiden's MCP connector tools are named `<server>__<tool>` (see
 * `mcp-tool-identity.ts`); Claude Code spells them `mcp__<server>__<tool>`.
 * Built-in Aiden tools never contain `__`.
 */

import { checkImageSavePath } from "../image-save-path.js";

const SHARED_NAMES: Readonly<Record<string, string>> = {
  run_command: "Bash",
  write_file: "Write",
  edit_file: "Edit",
  read_file: "Read",
  glob: "Glob",
  grep: "Grep",
  list_dir: "LS",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  subagent: "Task",
  todo: "TodoWrite",
  ask_user_question: "AskUserQuestion",
  skill: "Skill",
  computer_use: "computer",
};

/**
 * Other tools that run a shell command. A `Bash` hook has to see them, or a
 * rule on shell commands could be stepped around, but `Bash` as a name still
 * means `run_command`. Matching goes by name, so `background_job`'s read, list
 * and stop actions count too; their `tool_input` has no `command`.
 */
const OTHER_SHELL_TOOLS: Readonly<Record<string, string>> = {
  background_job: "Bash",
  computer_shell: "Bash",
};

/**
 * Other tools that may write a workspace file. A `Write` (or `write_file`)
 * hook has to see them, or a guard on written files could be stepped around,
 * but their `tool_name` stays their own. generate_image writes only with
 * `savePath`, which `tool_input` also carries as `file_path`; matching goes by
 * name, so its calls without one count too.
 */
const OTHER_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["generate_image"]);

const AIDEN_TO_CLAUDE: Readonly<Record<string, string>> = { ...SHARED_NAMES, ...OTHER_SHELL_TOOLS };

const CLAUDE_TO_AIDEN: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(SHARED_NAMES).map(([aiden, claude]) => [claude, aiden])),
  MultiEdit: "edit_file",
  Agent: "subagent",
};

const MCP_PREFIX = "mcp__";

function own(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The Claude Code spelling of an Aiden tool name, or the name itself when there is none. */
export function claudeToolName(aidenName: string): string {
  const alias = own(AIDEN_TO_CLAUDE, aidenName);
  if (alias) return alias;
  if (!aidenName.startsWith(MCP_PREFIX) && aidenName.includes("__")) return `${MCP_PREFIX}${aidenName}`;
  return aidenName;
}

/** The Aiden tool name for a Claude Code (or Aiden) spelling. */
export function aidenToolName(name: string): string {
  const alias = own(CLAUDE_TO_AIDEN, name);
  if (alias) return alias;
  if (name.startsWith(MCP_PREFIX) && name.length > MCP_PREFIX.length) return name.slice(MCP_PREFIX.length);
  return name;
}

/** Every spelling a matcher may use for one tool: the Aiden name first, then its aliases. */
export function toolNameSpellings(name: string): string[] {
  const aiden = aidenToolName(name);
  const spellings = new Set<string>([aiden, claudeToolName(aiden), name]);
  if (own(OTHER_SHELL_TOOLS, aiden)) spellings.add("run_command");
  if (OTHER_FILE_WRITE_TOOLS.has(aiden)) {
    spellings.add("write_file");
    spellings.add("Write");
  }
  for (const [claude, target] of Object.entries(CLAUDE_TO_AIDEN)) {
    if (target === aiden) spellings.add(claude);
  }
  return [...spellings];
}

/**
 * Tool input as a hook sees it: Aiden's keys plus Claude aliases (`path`, or
 * generate_image's `savePath`, also as `file_path`). The original object is
 * not changed. `file_path` for a savePath is the workspace path the image is
 * written to (`./design//hero.png` becomes `design/hero.png`), so a hook that
 * guards paths sees the same file the approval names; a savePath the tool
 * would refuse gets no `file_path`.
 */
export function claudeToolInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return input;
  const result: Record<string, unknown> = { ...input };
  if (!("file_path" in input)) {
    if (typeof input.path === "string") result.file_path = input.path;
    else if (typeof input.savePath === "string") {
      const savePath = parsedSavePath(input.savePath);
      if (savePath !== undefined) result.file_path = savePath;
    }
  }
  return result;
}

function parsedSavePath(value: string): string | undefined {
  try {
    return checkImageSavePath(value);
  } catch {
    return undefined;
  }
}

/**
 * A hook's `updatedInput` mapped back onto Aiden's keys for `aidenName`:
 * `file_path` becomes `path` for tools that take a path.
 */
export function aidenToolInput(
  aidenName: string,
  updated: Record<string, unknown>,
  original: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...updated };
  const takesPath = original ? "path" in original : PATH_TOOLS.has(aidenName);
  // The key `file_path` stands for: `path`, or generate_image's `savePath`.
  const key = takesPath ? "path" : original && "savePath" in original ? "savePath" : undefined;
  if (key && typeof result.file_path === "string") {
    if (!(key in updated) || updated[key] === original?.[key]) result[key] = result.file_path;
    delete result.file_path;
  }
  return result;
}

const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "list_dir"]);

/** The file a tool call touches, when its input names one. */
export function toolInputFile(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() && !value.includes("\0")) return value;
  }
  return undefined;
}
