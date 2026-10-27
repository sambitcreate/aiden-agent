// The Mac app behind a Mac app connector (iMCP): where it is installed and
// whether it is open. Aiden never installs, updates or quits the app, and
// opens it only when the person chooses Open in Settings → Connectors. The
// probes are injected so these rules run under plain tsx on any platform.

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import type { ConnectorMacApp } from "../../renderer/shared/connector-catalog.js";
import type { McpMacAppStatus } from "../../renderer/shared/mcp-status.js";
import { macAppServerCommands, type MacAppMcpPreset } from "./mcp-presets.js";

export type { McpMacAppStatus };

type BundleInfoKey = "CFBundleIdentifier" | "CFBundleShortVersionString";

export interface McpMacAppProbe {
  platform: NodeJS.Platform;
  homedir: string;
  /** The path is a file this user may execute. */
  isExecutable(file: string): Promise<boolean>;
  /** One string value from the bundle's Info.plist, or undefined when it can't be read. */
  bundleInfo(bundle: string, key: BundleInfoKey): Promise<string | undefined>;
  /** A process with exactly this name runs as this user. */
  isRunning(processName: string): Promise<boolean>;
  /** Open the app bundle as if the person double-clicked it. */
  open(bundle: string): Promise<void>;
}

interface InstalledMacApp {
  bundle: string;
  command: string;
  version?: string;
}

/**
 * The installed copy: the first Applications folder whose bundle has the
 * server and declares the app's bundle identifier. An app with the same name
 * from someone else is not it.
 */
async function findMacApp(app: ConnectorMacApp, probe: McpMacAppProbe): Promise<InstalledMacApp | undefined> {
  for (const command of macAppServerCommands(app, probe.homedir)) {
    const bundle = command.slice(0, -(app.serverPath.length + 1));
    if (!(await probe.isExecutable(command))) continue;
    if ((await probe.bundleInfo(bundle, "CFBundleIdentifier")) !== app.bundleId) continue;
    const version = await probe.bundleInfo(bundle, "CFBundleShortVersionString");
    return { bundle, command, ...(version ? { version } : {}) };
  }
  return undefined;
}

export async function mcpMacAppStatus(
  preset: MacAppMcpPreset,
  probe: McpMacAppProbe = nodeMacAppProbe(),
): Promise<McpMacAppStatus> {
  if (probe.platform !== "darwin") return { supported: false, installed: false, open: false };
  const [installed, open] = await Promise.all([
    findMacApp(preset.macApp, probe),
    probe.isRunning(preset.macApp.processName),
  ]);
  if (!installed) return { supported: true, installed: false, open: false };
  return {
    supported: true,
    installed: true,
    command: installed.command,
    ...(installed.version ? { version: installed.version } : {}),
    open,
  };
}

/** Its server only answers while the app runs, so a closed app fails fast instead of timing out. */
export async function isMcpMacAppOpen(
  preset: MacAppMcpPreset,
  probe: McpMacAppProbe = nodeMacAppProbe(),
): Promise<boolean> {
  return probe.platform === "darwin" && probe.isRunning(preset.macApp.processName);
}

/** Open the installed copy, the one whose server Aiden runs. */
export async function openMcpMacApp(
  preset: MacAppMcpPreset,
  probe: McpMacAppProbe = nodeMacAppProbe(),
): Promise<void> {
  if (probe.platform !== "darwin") throw new Error(`${preset.name} works only on a Mac.`);
  const installed = await findMacApp(preset.macApp, probe);
  if (!installed) throw new Error(`${preset.name} isn’t in your Applications folder.`);
  await probe.open(installed.bundle);
}

function run(file: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

/** The real probe: system tools at fixed paths, never a PATH lookup. */
export function nodeMacAppProbe(): McpMacAppProbe {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    async isExecutable(file) {
      try {
        await fs.access(file, fsConstants.X_OK);
        return (await fs.stat(file)).isFile();
      } catch {
        return false;
      }
    },
    async bundleInfo(bundle, key) {
      const { ok, stdout } = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", `${bundle}/Contents/Info.plist`]);
      const value = stdout.trim();
      return ok && value ? value : undefined;
    },
    async isRunning(processName) {
      const uid = process.getuid?.();
      return (await run("/usr/bin/pgrep", [...(uid === undefined ? [] : ["-U", String(uid)]), "-x", processName])).ok;
    },
    async open(bundle) {
      if (!(await run("/usr/bin/open", [bundle])).ok) throw new Error(`Couldn’t open ${bundle}.`);
    },
  };
}
