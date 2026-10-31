// Hook and agent-harness configuration that runs commands on the owner's
// computer. Agent file tools (parent, Bot, subagent and ACP writes) never
// create, replace or edit these paths, whatever the workspace permission:
// a model that could rewrite them could grant itself code execution outside
// any approval. Reading them stays allowed. `run_command` is out of scope
// here; Aiden's hook digest check disables a hook whose file changed.

/**
 * Protected children of a configuration directory. Each entry is protected
 * along with anything beneath it, at any depth of the workspace and of the
 * absolute path (so a workspace opened inside `~/.claude` is covered too).
 */
const PROTECTED_CONFIG_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Aiden hooks (docs/plans/aiden-hooks-plan.md §8.4) and the scripts they run.
  [".aiden", new Set(["hooks.json", "hooks"])],
  // Claude Code hooks, permissions and plugin hooks. `.claude/skills`,
  // `.claude/agents`, `.claude/commands` and CLAUDE.md stay writable.
  [".claude", new Set(["settings.json", "settings.local.json", "hooks", "plugins"])],
  // Codex hooks and configuration (`[hooks]`, MCP servers, sandbox policy).
  [".codex", new Set(["config.toml", "hooks.json", "hooks"])],
]);

export const PROTECTED_AGENT_CONFIG_WRITE_MESSAGE =
  "File tools cannot change hook or agent settings files (.aiden/hooks.json, .aiden/hooks/, " +
  ".claude/settings.json, .claude/settings.local.json, .claude/hooks/, .claude/plugins/, " +
  ".codex/config.toml, .codex/hooks.json, .codex/hooks/) because they run commands on this computer. " +
  "Ask the person to change it in Settings → Hooks or to edit the file by hand.";

/**
 * Fold a path segment the way a case- and normalization-insensitive volume
 * (macOS) may match it, erring toward a match: NFKC, no default-ignorable
 * code points, lower case.
 */
function foldSegment(segment: string): string {
  return segment
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .toLocaleLowerCase("en-US");
}

/**
 * Whether a workspace-relative or absolute path names protected hook or
 * agent configuration. `.` and `..` are resolved lexically, matching the
 * file tools' own `path.resolve` semantics; callers also pass the canonical
 * (symlink-resolved) target so a link cannot route around the rule.
 */
export function isProtectedAgentConfigPath(candidate: string): boolean {
  if (typeof candidate !== "string") return false;
  const segments: string[] = [];
  for (const raw of candidate.split(/[\\/]+/u)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      segments.pop();
      continue;
    }
    segments.push(foldSegment(raw));
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    const children = PROTECTED_CONFIG_CHILDREN.get(segments[index]!);
    if (children?.has(segments[index + 1]!)) return true;
  }
  return false;
}

/** Throw the shared refusal when any of the given forms of a target is protected. */
export function assertAgentMayWriteConfigPath(...candidates: readonly string[]): void {
  if (candidates.some(isProtectedAgentConfigPath)) {
    throw new Error(PROTECTED_AGENT_CONFIG_WRITE_MESSAGE);
  }
}
