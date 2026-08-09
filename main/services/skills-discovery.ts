// Discovers Agent Skills from the filesystem. Each skill is a folder containing
// a SKILL.md file with YAML frontmatter (name, description) and a Markdown body
// used as the skill's instructions.
//
// Scanned roots and layouts:
//   - Global: ~/.agents, ~/.claude, ~/.aiden
//   - Workspace: <workspaceRoot>/.agents, <workspaceRoot>/.claude, <workspaceRoot>/.aiden
// Supported layouts per root:
//   - Legacy: <root>/<skill>/SKILL.md
//   - Nested: <root>/skills/<skill>/SKILL.md
//   - Aiden native: <root>/{skill,skills}/<skill>/SKILL.md
// Workspace skills win over global skills of the same name.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { constants as fsConstants } from "node:fs";
import { SLASH_LIMITS } from "../../renderer/shared/slash-commands.js";
import { AIDEN_DIR_NAME, aidenConfigDir } from "./aiden-config-dir.js";
import type { DiscoveredSkill } from "./types.js";

interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Parse a minimal `key: value` YAML frontmatter block delimited by `---`.
 * Only the flat scalar keys we care about (name, description) are read; the rest
 * of the document is returned as the body (the skill instructions).
 */
function parseSkillMd(input: string): { frontmatter: Frontmatter; body: string } {
  const raw = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // strip BOM if present
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };
  const [, block, body] = match;
  const frontmatter: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") frontmatter.name = value;
    else if (key === "description") frontmatter.description = value;
  }
  return { frontmatter, body: body.trim() };
}

interface ScanConfig {
  root: string;
  patterns: string[];
  source: DiscoveredSkill["source"];
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function assertNoSymlinkSegments(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  if (!isContainedPath(root, candidate) || !relative) throw new Error("Invalid skill path.");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Skill paths cannot contain symbolic links.");
  }
}

async function readBoundedSkillFile(skillRoot: string, skillMd: string): Promise<string> {
  const realRoot = await fs.realpath(skillRoot);
  await assertNoSymlinkSegments(realRoot, skillMd);
  const realSkillMd = await fs.realpath(skillMd);
  if (!isContainedPath(realRoot, realSkillMd)) throw new Error("Skill path escapes its root.");
  const handle = await fs.open(realSkillMd, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Skill instructions must be a regular file.");
    const buffer = Buffer.alloc(SLASH_LIMITS.instructionBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > SLASH_LIMITS.instructionBytes) {
      throw new Error("Skill instructions exceed Aiden's safety limit.");
    }
    return buffer.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

async function scanPatterns(config: ScanConfig): Promise<DiscoveredSkill[]> {
  if (!(await dirExists(config.root))) return [];
  const rootStat = await fs.lstat(config.root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return [];
  const realRoot = await fs.realpath(config.root);

  const seenPaths = new Set<string>();
  const skills: DiscoveredSkill[] = [];

  for (const pattern of config.patterns) {
    const matches = fs.glob(pattern, { cwd: config.root });
    for await (const relative of matches) {
      const skillMd = path.resolve(realRoot, relative);
      if (seenPaths.has(skillMd)) continue;
      seenPaths.add(skillMd);

      let raw: string;
      try {
        raw = await readBoundedSkillFile(realRoot, skillMd);
      } catch {
        continue;
      }

      const { frontmatter, body } = parseSkillMd(raw);
      const entryName = path.basename(path.dirname(skillMd));
      const name = (frontmatter.name || entryName).trim();
      const instructions = body || frontmatter.description || "";
      if (!name || !instructions) continue;

      skills.push({
        // The resolved path keeps ids unique across roots that share a source
        // and entry name (e.g. ~/.agents/notes and ~/.claude/skills/notes).
        id: `${config.source}:${skillMd}`,
        name,
        description: (frontmatter.description || "").trim(),
        instructions,
        source: config.source,
        path: skillMd,
      });
    }
  }

  return skills;
}

const LEGACY_AGENTS_PATTERNS = ["*/SKILL.md"];
const NESTED_AGENTS_PATTERNS = ["skills/**/SKILL.md"];
const CLAUDE_PATTERNS = ["skills/**/SKILL.md"];
const AIDEN_PATTERNS = ["skill/**/SKILL.md", "skills/**/SKILL.md"];

/**
 * Discover skills from global and workspace skill directories.
 * On a name clash the later root wins, so workspace skills override global
 * ones (and, within a source, `.aiden` overrides `.claude`, which overrides
 * `.agents`).
 */
async function scanAllSkills(
  workspaceRoot: string | undefined,
  home: string,
  aidenDir: string,
): Promise<DiscoveredSkill[]> {
  const roots: ScanConfig[] = [
    {
      root: path.join(home, ".agents"),
      patterns: [...LEGACY_AGENTS_PATTERNS, ...NESTED_AGENTS_PATTERNS],
      source: "global",
    },
    { root: path.join(home, ".claude"), patterns: CLAUDE_PATTERNS, source: "global" },
    { root: aidenDir, patterns: AIDEN_PATTERNS, source: "global" },
  ];

  if (workspaceRoot) {
    roots.push(
      {
        root: path.join(workspaceRoot, ".agents"),
        patterns: [...LEGACY_AGENTS_PATTERNS, ...NESTED_AGENTS_PATTERNS],
        source: "workspace",
      },
      { root: path.join(workspaceRoot, ".claude"), patterns: CLAUDE_PATTERNS, source: "workspace" },
      {
        root: path.join(workspaceRoot, AIDEN_DIR_NAME),
        patterns: AIDEN_PATTERNS,
        source: "workspace",
      },
    );
  }

  try {
    const results = await Promise.all(roots.map((config) => scanPatterns(config)));
    const byName = new Map<string, DiscoveredSkill>();
    for (const skills of results) {
      for (const skill of skills) {
        byName.set(skill.name.toLowerCase(), skill);
      }
    }
    return [...byName.values()];
  } catch (error) {
    console.warn("Skill discovery failed:", error instanceof Error ? error.message : String(error));
    return [];
  }
}

const DISCOVERY_CACHE_TTL_MS = 5_000;
const DISCOVERY_CACHE_LIMIT = 50;
const discoveryCache = new Map<string, { expires: number; result: Promise<DiscoveredSkill[]> }>();

/**
 * Discover skills from global and workspace skill directories.
 * Both the system prompt and the tool set discover once per generation, so
 * results are cached for a few seconds to collapse those into one filesystem
 * scan without going meaningfully stale.
 */
export function discoverSkills(
  workspaceRoot?: string,
  homeDir?: string,
): Promise<DiscoveredSkill[]> {
  const home = homeDir ?? os.homedir();
  // An explicitly injected home wins over AIDEN_CONFIG_DIR so tests stay
  // hermetic; the default path honours the override so redirecting the config
  // directory moves global skill discovery along with it.
  const aidenDir = homeDir === undefined ? aidenConfigDir() : path.join(home, AIDEN_DIR_NAME);
  const key = `${home}\n${aidenDir}\n${workspaceRoot ?? ""}`;
  const hit = discoveryCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.result;
  const result = scanAllSkills(workspaceRoot, home, aidenDir);
  if (discoveryCache.size >= DISCOVERY_CACHE_LIMIT) discoveryCache.clear();
  discoveryCache.set(key, { expires: Date.now() + DISCOVERY_CACHE_TTL_MS, result });
  return result;
}
