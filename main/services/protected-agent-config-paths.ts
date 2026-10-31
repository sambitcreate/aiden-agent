// Hook and agent-harness configuration that runs commands on the owner's
// computer. Agent file tools (parent, Bot, subagent and ACP writes) never
// create, replace or edit these paths, whatever the workspace permission:
// a model that could rewrite them could grant itself code execution outside
// any approval. Reading them stays allowed. `run_command` is out of scope
// here; Aiden's hook digest check disables a hook whose file changed.

import { realpathSync } from "node:fs";
import * as path from "node:path";

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
  ".codex/config.toml, .codex/hooks.json, .codex/hooks/, or Aiden's own hooks folder) because they run commands on this computer. " +
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

function foldedSegments(candidate: string): string[] {
  const segments: string[] = [];
  for (const raw of candidate.split(/[\\/]+/u)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      segments.pop();
      continue;
    }
    segments.push(foldSegment(raw));
  }
  return segments;
}

/**
 * Absolute directories protected as a whole, such as Aiden's own hook store
 * (`<userData>/hooks/`, `<agentDir>/hooks/` for the CLI), whose name alone
 * would not mark it. Each root is kept as given and with its parent's
 * symlinks resolved, folded the same way as candidate paths.
 */
let protectedRoots: string[][] = [];

/** The host registers its hook store here once it knows where it lives. */
export function setProtectedAgentConfigRoots(roots: readonly string[]): void {
  const forms = new Map<string, string[]>();
  for (const root of roots) {
    if (typeof root !== "string" || !path.isAbsolute(root)) continue;
    const resolved = path.resolve(root);
    const variants = [resolved];
    try {
      variants.push(path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved)));
    } catch {
      // A parent that does not exist yet has no other spelling.
    }
    for (const variant of variants) {
      const segments = foldedSegments(variant);
      if (segments.length > 0) forms.set(segments.join("/"), segments);
    }
  }
  protectedRoots = [...forms.values()];
}

function underProtectedRoot(candidate: string): boolean {
  if (protectedRoots.length === 0 || !path.isAbsolute(candidate)) return false;
  const segments = foldedSegments(candidate);
  return protectedRoots.some(
    (root) => root.length <= segments.length && root.every((segment, index) => segments[index] === segment),
  );
}

/**
 * Whether a workspace-relative or absolute path names protected hook or
 * agent configuration. `.` and `..` are resolved lexically, matching the
 * file tools' own `path.resolve` semantics; callers also pass the canonical
 * (symlink-resolved) target so a link cannot route around the rule.
 */
export function isProtectedAgentConfigPath(candidate: string): boolean {
  if (typeof candidate !== "string") return false;
  if (underProtectedRoot(candidate)) return true;
  const segments = foldedSegments(candidate);
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
