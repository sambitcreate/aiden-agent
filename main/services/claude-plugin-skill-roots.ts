/** Local installed-plugin metadata only. Never installs, launches, or fetches plugins. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import * as path from "node:path";

export const PLUGIN_DISCOVERY_LIMITS = Object.freeze({ metadataBytes: 1024 * 1024, plugins: 128, pathsPerPlugin: 16 });
export interface PluginSkillRoot {
  root: string;
  namespace: string;
  scope: "global" | "workspace";
  searches: Array<{ base: string; maxDepth: number }>;
}

async function canonicalPath(file: string): Promise<string | undefined> {
  try {
    return await realpath(file);
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PLUGIN_DISCOVERY_LIMITS.metadataBytes) return;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) return;
    const parsed: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    return record(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Inventory order selects the first applicable installed version, never all cached versions. */
export async function claudePluginSkillRoots(home: string, workspaceRoot?: string): Promise<PluginSkillRoot[]> {
  const config = path.join(home, ".claude");
  // Resolved once per call; a missing workspace never matches a project record.
  const workspaceReal = workspaceRoot ? await canonicalPath(workspaceRoot) : undefined;
  const homeReal = await canonicalPath(home);
  const projectSettingsRoot = workspaceRoot && !(workspaceReal !== undefined && workspaceReal === homeReal) ? workspaceRoot : undefined;
  const plugins = (await readJson(path.join(config, "plugins", "installed_plugins.json")))?.plugins;
  if (!record(plugins)) return [];
  const enabled = new Map<string, { value: unknown; workspace: boolean }>();
  for (const [file, workspace] of [
    [path.join(config, "settings.json"), false],
    ...(projectSettingsRoot ? [
      [path.join(projectSettingsRoot, ".claude", "settings.json"), true],
      [path.join(projectSettingsRoot, ".claude", "settings.local.json"), true],
    ] as const : []),
  ] as const) {
    const settings = (await readJson(file))?.enabledPlugins;
    if (!record(settings)) continue;
    for (const [name, value] of Object.entries(settings)) enabled.set(name, { value, workspace });
  }
  const roots: PluginSkillRoot[] = [];
  for (const [key, installs] of Object.entries(plugins).slice(0, PLUGIN_DISCOVERY_LIMITS.plugins)) {
    const setting = enabled.get(key);
    if (setting?.value !== true || !Array.isArray(installs)) continue;
    let install: unknown;
    for (const candidate of installs.slice(0, PLUGIN_DISCOVERY_LIMITS.plugins) as unknown[]) {
      if (!record(candidate) || typeof candidate.installPath !== "string" || !path.isAbsolute(candidate.installPath)) continue;
      if (candidate.scope === "user" || candidate.scope === "managed" || (
        (candidate.scope === "project" || candidate.scope === "local") && workspaceReal !== undefined &&
        typeof candidate.projectPath === "string" && (await canonicalPath(candidate.projectPath)) === workspaceReal
      )) {
        install = candidate;
        break;
      }
    }
    if (!record(install) || typeof install.installPath !== "string") continue;
    const root = install.installPath;
    const manifest = await readJson(path.join(root, ".claude-plugin", "plugin.json"));
    const namespace = manifest?.name ?? key.split("@")[0];
    if (typeof namespace !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/u.test(namespace)) continue;
    const custom = typeof manifest?.skills === "string" ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills : [];
    const searches = [{ base: "skills", maxDepth: 12 }];
    for (const candidate of custom.slice(0, PLUGIN_DISCOVERY_LIMITS.pathsPerPlugin)) {
      if (typeof candidate !== "string" || !candidate || path.isAbsolute(candidate) || candidate.includes("\\")) continue;
      const relative = path.relative(root, path.resolve(root, candidate));
      if (relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
      // A manifest may name a skill directory, a collection, or SKILL.md itself.
      // A named SKILL.md is that one file: depth 0 reads it without walking its folder.
      const file = candidate.endsWith("SKILL.md");
      searches.push({ base: file ? path.dirname(relative) : relative, maxDepth: file ? 0 : 12 });
    }
    searches.push({ base: "", maxDepth: 0 });
    roots.push({ root, namespace, scope: setting.workspace || install.scope === "project" || install.scope === "local" ? "workspace" : "global", searches });
  }
  return roots;
}
