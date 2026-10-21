/** Local installed-plugin metadata only. Never installs, launches, or fetches plugins. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import * as path from "node:path";

export const PLUGIN_DISCOVERY_LIMITS = Object.freeze({ metadataBytes: 1024 * 1024, plugins: 128, pathsPerPlugin: 16 });
export interface PluginSkillRoot {
  root: string;
  namespace: string;
  scope: "global" | "workspace";
  searches: Array<{ base: string; maxDepth: number }>;
}

function sameWorkspace(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PLUGIN_DISCOVERY_LIMITS.metadataBytes) return;
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > stat.size) return;
    const parsed: unknown = JSON.parse(buffer.toString("utf8", 0, bytes));
    return record(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Inventory order selects the first applicable installed version, never all cached versions. */
export function claudePluginSkillRoots(home: string, workspaceRoot?: string): PluginSkillRoot[] {
  const config = path.join(home, ".claude");
  const projectSettingsRoot = workspaceRoot && !sameWorkspace(home, workspaceRoot) ? workspaceRoot : undefined;
  const plugins = readJson(path.join(config, "plugins", "installed_plugins.json"))?.plugins;
  if (!record(plugins)) return [];
  const enabled = new Map<string, { value: unknown; workspace: boolean }>();
  for (const [file, workspace] of [
    [path.join(config, "settings.json"), false],
    ...(projectSettingsRoot ? [
      [path.join(projectSettingsRoot, ".claude", "settings.json"), true],
      [path.join(projectSettingsRoot, ".claude", "settings.local.json"), true],
    ] as const : []),
  ] as const) {
    const settings = readJson(file)?.enabledPlugins;
    if (!record(settings)) continue;
    for (const [name, value] of Object.entries(settings)) enabled.set(name, { value, workspace });
  }
  const roots: PluginSkillRoot[] = [];
  for (const [key, installs] of Object.entries(plugins).slice(0, PLUGIN_DISCOVERY_LIMITS.plugins)) {
    const setting = enabled.get(key);
    if (setting?.value !== true || !Array.isArray(installs)) continue;
    const install = installs.slice(0, PLUGIN_DISCOVERY_LIMITS.plugins).find((candidate: unknown) => {
      if (!record(candidate) || typeof candidate.installPath !== "string" || !path.isAbsolute(candidate.installPath)) return false;
      if (candidate.scope === "user" || candidate.scope === "managed") return true;
      return (candidate.scope === "project" || candidate.scope === "local") && workspaceRoot !== undefined &&
        typeof candidate.projectPath === "string" && sameWorkspace(candidate.projectPath, workspaceRoot);
    });
    if (!record(install) || typeof install.installPath !== "string") continue;
    const root = install.installPath;
    const manifest = readJson(path.join(root, ".claude-plugin", "plugin.json"));
    const namespace = manifest?.name ?? key.split("@")[0];
    if (typeof namespace !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/u.test(namespace)) continue;
    const custom = typeof manifest?.skills === "string" ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills : [];
    const searches = [{ base: "skills", maxDepth: 12 }];
    for (const candidate of custom.slice(0, PLUGIN_DISCOVERY_LIMITS.pathsPerPlugin)) {
      if (typeof candidate !== "string" || !candidate || path.isAbsolute(candidate) || candidate.includes("\\")) continue;
      const relative = path.relative(root, path.resolve(root, candidate));
      if (relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
      // A manifest may name a skill directory, a collection, or SKILL.md itself.
      searches.push({ base: candidate.endsWith("SKILL.md") ? path.dirname(relative) : relative, maxDepth: 12 });
    }
    searches.push({ base: "", maxDepth: 0 });
    roots.push({ root, namespace, scope: setting.workspace || install.scope === "project" || install.scope === "local" ? "workspace" : "global", searches });
  }
  return roots;
}
