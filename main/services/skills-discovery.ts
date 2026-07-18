// Discovers Agent Skills from the filesystem. Each skill is a subfolder of a
// `.agents` directory containing a SKILL.md file with YAML frontmatter (name,
// description) and a Markdown body used as the skill's instructions.
//
// Two roots are scanned: the workspace folder's `.agents` and the user's global
// `~/.agents`. Workspace skills win over global skills of the same name.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { logger } from "@glaze/core/backend";
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name") frontmatter.name = value;
    else if (key === "description") frontmatter.description = value;
  }
  return { frontmatter, body: body.trim() };
}

/** Scan one `.agents` directory for SKILL.md-based skills. */
async function scanRoot(agentsDir: string, source: DiscoveredSkill["source"]): Promise<DiscoveredSkill[]> {
  let entries;
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return []; // No `.agents` folder here — that's normal.
  }

  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(agentsDir, entry.name, "SKILL.md");
    let raw: string;
    try {
      raw = await fs.readFile(skillMd, "utf-8");
    } catch {
      continue; // Subfolder without a SKILL.md — skip.
    }
    const { frontmatter, body } = parseSkillMd(raw);
    const name = (frontmatter.name || entry.name).trim();
    const instructions = body || frontmatter.description || "";
    if (!name || !instructions) continue;
    skills.push({
      id: `${source}:${entry.name}`,
      name,
      description: (frontmatter.description || "").trim(),
      instructions,
      source,
      path: skillMd,
    });
  }
  return skills;
}

/**
 * Discover skills from the workspace `.agents` folder and the global
 * `~/.agents` folder. On a name clash, the workspace skill wins.
 */
export async function discoverSkills(workspaceRoot?: string): Promise<DiscoveredSkill[]> {
  const roots: Array<Promise<DiscoveredSkill[]>> = [scanRoot(path.join(os.homedir(), ".agents"), "global")];
  if (workspaceRoot) roots.push(scanRoot(path.join(workspaceRoot, ".agents"), "workspace"));

  try {
    const [global, workspace = []] = await Promise.all(roots);
    // Workspace overrides global by (case-insensitive) name.
    const byName = new Map<string, DiscoveredSkill>();
    for (const skill of global) byName.set(skill.name.toLowerCase(), skill);
    for (const skill of workspace) byName.set(skill.name.toLowerCase(), skill);
    return [...byName.values()];
  } catch (error) {
    logger.warn("skills", `Skill discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
