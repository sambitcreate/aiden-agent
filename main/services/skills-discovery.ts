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
import { projectDiagnosticError } from "./diagnostics-contract.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";
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
  searches: Array<{ base: string; maxDepth: number }>;
  source: DiscoveredSkill["source"];
  priority: number;
}

export const SKILL_DISCOVERY_LIMITS = Object.freeze({
  candidatesPerSource: 1_000,
  traversedEntriesPerSource: 4_000,
  aggregateBytesPerSource: 16 * 1024 * 1024,
  relativeDepth: 12,
});

interface DiscoveryBudget {
  candidates: number;
  traversedEntries: number;
  aggregateBytes: number;
}

/** Deterministic filesystem-race seam used only by focused discovery tests. */
export interface SkillDiscoveryTestHooks {
  beforeSkillRootRealpath?(root: string): Promise<void>;
  beforeSkillFileOpen?(skillMd: string): Promise<void>;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function discoveryBudgetExhausted(budget: DiscoveryBudget): boolean {
  return (
    budget.candidates >= SKILL_DISCOVERY_LIMITS.candidatesPerSource ||
    budget.traversedEntries >= SKILL_DISCOVERY_LIMITS.traversedEntriesPerSource ||
    budget.aggregateBytes >= SKILL_DISCOVERY_LIMITS.aggregateBytesPerSource
  );
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

class SkillReadLimitError extends Error {
  constructor(
    message: string,
    readonly attemptedBytes: number,
  ) {
    super(message);
  }
}

async function readBoundedSkillFile(
  skillRoot: string,
  skillMd: string,
  aggregateBytesRemaining: number,
  testHooks: SkillDiscoveryTestHooks,
  expectedRootIdentity: DirectoryIdentity,
): Promise<{ text: string; bytesRead: number }> {
  const realRoot = await fs.realpath(skillRoot);
  const rootHandle = await fs.open(
    realRoot,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  let handle: fs.FileHandle | undefined;
  try {
    const rootIdentity = await rootHandle.stat();
    if (!sameIdentity(rootIdentity, expectedRootIdentity)) {
      throw new Error("Skill root changed before file open.");
    }
    await assertNoSymlinkSegments(realRoot, skillMd);
    const realSkillMd = await fs.realpath(skillMd);
    if (!isContainedPath(realRoot, realSkillMd)) {
      throw new Error("Skill path escapes its root.");
    }
    await testHooks.beforeSkillFileOpen?.(skillMd);
    handle = await fs.open(realSkillMd, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Skill instructions must be a regular file.");

    // Bind containment to the descriptors whose bytes are accepted. A path
    // segment or root swapped between the first validation and open must not
    // turn an approved skill into a read outside that stable root.
    const verifiedRoot = await fs.realpath(realRoot);
    const verifiedRootStat = await fs.stat(verifiedRoot);
    if (verifiedRoot !== realRoot || !sameIdentity(verifiedRootStat, rootIdentity)) {
      throw new Error("Skill root changed during discovery.");
    }
    await assertNoSymlinkSegments(realRoot, skillMd);
    const verifiedSkillMd = await fs.realpath(skillMd);
    if (!isContainedPath(realRoot, verifiedSkillMd)) {
      throw new Error("Skill path escapes its stable root.");
    }
    const verifiedSkillStat = await fs.stat(verifiedSkillMd);
    if (verifiedSkillStat.dev !== stat.dev || verifiedSkillStat.ino !== stat.ino) {
      throw new Error("Skill file changed during discovery.");
    }
    // Reject ordinary oversized files from metadata alone so a directory full
    // of them cannot force the main process to read the per-file maximum over
    // and over. The bounded read below still handles a file that grows after
    // this check.
    if (stat.size > SLASH_LIMITS.instructionBytes) {
      throw new Error("Skill instructions exceed Aiden's safety limit.");
    }
    if (stat.size > aggregateBytesRemaining) {
      throw new SkillReadLimitError(
        "Skill discovery exceeds Aiden's aggregate safety limit.",
        aggregateBytesRemaining,
      );
    }
    const readLimit = Math.min(SLASH_LIMITS.instructionBytes, aggregateBytesRemaining);
    const buffer = Buffer.alloc(readLimit + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > readLimit) {
      throw new SkillReadLimitError(
        "Skill instructions exceed Aiden's safety limit.",
        offset,
      );
    }
    return { text: buffer.toString("utf8", 0, offset), bytesRead: offset };
  } finally {
    await handle?.close();
    await rootHandle.close();
  }
}

async function* boundedSkillPaths(
  config: ScanConfig,
  budget: DiscoveryBudget,
): AsyncGenerator<string> {
  for (const search of config.searches) {
    if (discoveryBudgetExhausted(budget)) return;
    const base = path.join(config.root, search.base);
    const baseStat = await fs.lstat(base).catch(() => null);
    if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) continue;
    const queue: Array<{ absolute: string; relative: string; depth: number }> = [
      { absolute: base, relative: search.base, depth: 0 },
    ];
    while (queue.length > 0 && !discoveryBudgetExhausted(budget)) {
      const current = queue.shift()!;
      const entries: Array<{ name: string; directory: boolean; file: boolean }> = [];
      try {
        const directory = await fs.opendir(current.absolute);
        for await (const entry of directory) {
          budget.traversedEntries += 1;
          if (budget.traversedEntries > SKILL_DISCOVERY_LIMITS.traversedEntriesPerSource) break;
          if (entry.isSymbolicLink()) continue;
          entries.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
        }
      } catch {
        continue;
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const entry of entries) {
        const relative = path.join(current.relative, entry.name);
        if (entry.file && entry.name === "SKILL.md" && current.depth >= 1) {
          yield relative;
        } else if (entry.directory && current.depth < search.maxDepth) {
          queue.push({
            absolute: path.join(current.absolute, entry.name),
            relative,
            depth: current.depth + 1,
          });
        }
      }
    }
  }
}

async function scanPatterns(
  config: ScanConfig,
  budget: DiscoveryBudget,
  testHooks: SkillDiscoveryTestHooks,
): Promise<DiscoveredSkill[]> {
  if (!(await dirExists(config.root))) return [];
  const rootHandle = await fs
    .open(
      config.root,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    )
    .catch(() => null);
  if (!rootHandle) return [];
  try {
    const rootIdentity = await rootHandle.stat();
    await testHooks.beforeSkillRootRealpath?.(config.root);
    const realRoot = await fs.realpath(config.root).catch(() => null);
    if (!realRoot) return [];
    const resolvedRootStat = await fs.stat(realRoot).catch(() => null);
    if (!resolvedRootStat?.isDirectory() || !sameIdentity(resolvedRootStat, rootIdentity)) {
      return [];
    }

    const seenPaths = new Set<string>();
    const skills: DiscoveredSkill[] = [];
    const stableConfig = { ...config, root: realRoot };

    for await (const relative of boundedSkillPaths(stableConfig, budget)) {
      if (discoveryBudgetExhausted(budget)) break;
      if (relative.split(path.sep).length > SKILL_DISCOVERY_LIMITS.relativeDepth) continue;
      const skillMd = path.resolve(realRoot, relative);
      if (seenPaths.has(skillMd)) continue;
      seenPaths.add(skillMd);

      let raw: string;
      try {
        const read = await readBoundedSkillFile(
          realRoot,
          skillMd,
          SKILL_DISCOVERY_LIMITS.aggregateBytesPerSource - budget.aggregateBytes,
          testHooks,
          rootIdentity,
        );
        raw = read.text;
        budget.aggregateBytes += read.bytesRead;
      } catch (error) {
        if (error instanceof SkillReadLimitError) {
          budget.aggregateBytes = Math.min(
            SKILL_DISCOVERY_LIMITS.aggregateBytesPerSource,
            budget.aggregateBytes + error.attemptedBytes,
          );
        }
        continue;
      }

      const { frontmatter, body } = parseSkillMd(raw);
      const entryName = path.basename(path.dirname(skillMd));
      const name = (frontmatter.name || entryName).trim();
      const instructions = body || frontmatter.description || "";
      if (!name || !instructions) continue;

      skills.push({
        // Priority preserves .aiden > .claude > .agents within each source;
        // the resolved path keeps identities unique within that tier.
        id: `${config.source}:${String(config.priority).padStart(2, "0")}:${skillMd}`,
        name,
        description: (frontmatter.description || "").trim(),
        instructions,
        source: config.source,
        path: skillMd,
      });
      budget.candidates += 1;
      if (discoveryBudgetExhausted(budget)) break;
    }
    return skills;
  } catch {
    return [];
  } finally {
    await rootHandle.close();
  }
}

const AGENTS_SEARCHES = [
  { base: "", maxDepth: 1 },
  { base: "skills", maxDepth: SKILL_DISCOVERY_LIMITS.relativeDepth },
];
const CLAUDE_SEARCHES = [{ base: "skills", maxDepth: SKILL_DISCOVERY_LIMITS.relativeDepth }];
const AIDEN_SEARCHES = [
  { base: "skill", maxDepth: SKILL_DISCOVERY_LIMITS.relativeDepth },
  { base: "skills", maxDepth: SKILL_DISCOVERY_LIMITS.relativeDepth },
];

/**
 * Discover skills from global and workspace skill directories.
 * Roots scan in precedence order so workspace skills override global ones and,
 * within a source, `.aiden` overrides `.claude`, which overrides `.agents`.
 */
async function scanAllSkillCandidates(
  workspaceRoot: string | undefined,
  home: string,
  aidenDir: string,
  testHooks: SkillDiscoveryTestHooks = {},
): Promise<DiscoveredSkill[]> {
  const roots: ScanConfig[] = [
    {
      root: path.join(home, ".agents"),
      searches: AGENTS_SEARCHES,
      source: "global",
      priority: 20,
    },
    {
      root: path.join(home, ".claude"),
      searches: CLAUDE_SEARCHES,
      source: "global",
      priority: 10,
    },
    { root: aidenDir, searches: AIDEN_SEARCHES, source: "global", priority: 0 },
  ];

  if (workspaceRoot) {
    roots.push(
      {
        root: path.join(workspaceRoot, ".agents"),
        searches: AGENTS_SEARCHES,
        source: "workspace",
        priority: 20,
      },
      {
        root: path.join(workspaceRoot, ".claude"),
        searches: CLAUDE_SEARCHES,
        source: "workspace",
        priority: 10,
      },
      {
        root: path.join(workspaceRoot, AIDEN_DIR_NAME),
        searches: AIDEN_SEARCHES,
        source: "workspace",
        priority: 0,
      },
    );
  }

  try {
    roots.sort(
      (left, right) =>
        (left.source === "workspace" ? 0 : 1) - (right.source === "workspace" ? 0 : 1) ||
        left.priority - right.priority ||
        (left.root < right.root ? -1 : left.root > right.root ? 1 : 0),
    );
    // Independent source budgets prevent a hostile workspace from starving
    // global skills. Their two fixed 16 MiB byte ceilings preserve a 32 MiB
    // aggregate process bound.
    const budgets: Record<DiscoveredSkill["source"], DiscoveryBudget> = {
      workspace: { candidates: 0, traversedEntries: 0, aggregateBytes: 0 },
      global: { candidates: 0, traversedEntries: 0, aggregateBytes: 0 },
    };
    const results: DiscoveredSkill[][] = [];
    for (const config of roots) {
      const budget = budgets[config.source];
      if (discoveryBudgetExhausted(budget)) continue;
      results.push(await scanPatterns(config, budget, testHooks));
    }
    return results.flat();
  } catch (error) {
    const projected = projectDiagnosticError(error);
    writeDiagnosticEvent({
      level: "warn",
      area: "skills",
      event: "skills-discovery-failed",
      outcome: "degraded",
      code: projected.code,
      fields: { errorType: projected.errorType, fingerprint: projected.fingerprint ?? null },
    });
    return [];
  }
}

const DISCOVERY_CACHE_TTL_MS = 5_000;
const DISCOVERY_CACHE_LIMIT = 50;
const discoveryCache = new Map<string, { expires: number; result: Promise<DiscoveredSkill[]> }>();

/** Uncached candidates for the authoritative registry, including collisions. */
export function discoverSkillCandidates(
  workspaceRoot?: string,
  homeDir?: string,
  testHooks: SkillDiscoveryTestHooks = {},
): Promise<DiscoveredSkill[]> {
  const home = homeDir ?? os.homedir();
  const aidenDir = homeDir === undefined ? aidenConfigDir() : path.join(home, AIDEN_DIR_NAME);
  return scanAllSkillCandidates(workspaceRoot, home, aidenDir, testHooks);
}

export function invalidateSkillDiscoveryCache(): void {
  discoveryCache.clear();
}

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
  const result = scanAllSkillCandidates(workspaceRoot, home, aidenDir).then((candidates) => {
    const byName = new Map<string, DiscoveredSkill>();
    for (const skill of candidates) {
      const key = skill.name.normalize("NFKC").toLowerCase();
      if (!byName.has(key)) byName.set(key, skill);
    }
    return [...byName.values()];
  });
  if (discoveryCache.size >= DISCOVERY_CACHE_LIMIT) discoveryCache.clear();
  discoveryCache.set(key, { expires: Date.now() + DISCOVERY_CACHE_TTL_MS, result });
  return result;
}
