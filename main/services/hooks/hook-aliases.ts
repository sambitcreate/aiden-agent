/**
 * Tool-name and input-key aliases between Aiden and Claude Code, so hook
 * scripts written for Claude Code match and read Aiden's tool calls.
 *
 * Aiden's MCP connector tools are named `<server>__<tool>` (see
 * `mcp-tool-identity.ts`); Claude Code spells them `mcp__<server>__<tool>`.
 * Built-in Aiden tools never contain `__`.
 */

const AIDEN_TO_CLAUDE: Readonly<Record<string, string>> = {
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

const CLAUDE_TO_AIDEN: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(AIDEN_TO_CLAUDE).map(([aiden, claude]) => [claude, aiden])),
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
  for (const [claude, target] of Object.entries(CLAUDE_TO_AIDEN)) {
    if (target === aiden) spellings.add(claude);
  }
  return [...spellings];
}

/**
 * Tool input as a hook sees it: Aiden's keys plus Claude aliases
 * (`path` also as `file_path`). The original object is not changed.
 */
export function claudeToolInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return input;
  const result: Record<string, unknown> = { ...input };
  if (typeof input.path === "string" && !("file_path" in input)) result.file_path = input.path;
  return result;
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
  if (takesPath && typeof result.file_path === "string") {
    if (!("path" in updated) || updated.path === original?.path) result.path = result.file_path;
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
