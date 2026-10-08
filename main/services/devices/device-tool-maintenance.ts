/**
 * Adapted from t3code apps/server/src/device/deviceToolMaintenance.ts @ a6ec88f7 (MIT)
 *
 * Reclaims helper versions Aiden no longer pins. The same JavaScript runs in
 * two places: on this Mac through `runToolMaintenance` (under Electron's
 * Node), and on SSH hosts inside the bootstrap script. Both take one
 * directory lock per tool root, never delete the pinned install, and keep any
 * version a running process was started from.
 *
 * Two policies share the code:
 * - `reclaim` runs after a successful update. It waits until the pinned
 *   version is installed and keeps the newest previous install as a fallback.
 * - `prune` is the user's explicit **Prune old versions**. It removes every
 *   other completed install that no running helper uses.
 */
import { spawn } from "node:child_process";

/**
 * Defines `withToolMaintenance(root, operation)` and
 * `pruneTools(root, specs, flat, keepPrevious)`. `flat` matches the SSH layout
 * (`tools/<name>@<version>`); otherwise `tools/<name>/<version>`.
 */
export const deviceToolMaintenanceScript = String.raw`
const maintenanceFs = require('node:fs');
const maintenancePath = require('node:path');
const maintenanceAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
async function withToolMaintenance(root, operation) {
  maintenanceFs.mkdirSync(root, { recursive: true });
  const lock = maintenancePath.join(root, '.maintenance-lock');
  const nonce = require('node:crypto').randomUUID();
  const ownerFile = process.pid + '.' + nonce + '.json';
  const candidate = lock + '.' + nonce;
  const deadline = Date.now() + 30000;
  const removeEmptyLock = () => {
    try { maintenanceFs.rmdirSync(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code)) throw error; }
  };
  maintenanceFs.mkdirSync(candidate);
  try {
    maintenanceFs.writeFileSync(maintenancePath.join(candidate, ownerFile), JSON.stringify({ pid: process.pid }));
    while (true) {
      try {
        // Publishing a populated directory is atomic; rename cannot replace another populated lock.
        maintenanceFs.renameSync(candidate, lock);
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let files = [];
        try { files = maintenanceFs.readdirSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (files.length === 1) {
          const previousFile = maintenancePath.join(lock, files[0]);
          let previous;
          try { previous = JSON.parse(maintenanceFs.readFileSync(previousFile, 'utf8')); } catch {}
          if (Number.isSafeInteger(previous?.pid) && previous.pid > 0 && !maintenanceAlive(previous.pid)) {
            // The unique filename belongs only to that owner. Never unlink a replacement owner's file.
            try { maintenanceFs.unlinkSync(previousFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
        removeEmptyLock();
        if (Date.now() >= deadline) throw Error('Device tool maintenance is locked. Try again when the other operation finishes.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return await operation(); }
    finally {
      maintenanceFs.unlinkSync(maintenancePath.join(lock, ownerFile));
      removeEmptyLock();
    }
  } finally {
    maintenanceFs.rmSync(candidate, { recursive: true, force: true });
  }
}
function pruneTools(root, specs, flat, keepPrevious) {
  return withToolMaintenance(root, () => {
    // Keep installs used by any running helper, including ones an older Aiden started.
    const scan = require('node:child_process').spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 10000 });
    if (scan.status !== 0 || !scan.stdout) throw Error('Could not list running processes, so no helper versions were removed.');
    const removed = [];
    for (const [name, required] of specs) {
      const parent = flat ? root : maintenancePath.join(root, name);
      let names;
      try { names = maintenanceFs.readdirSync(parent); } catch { continue; }
      const completed = [];
      for (const item of names) {
        const version = flat ? (item.startsWith(name + '@') ? item.slice(name.length + 1) : '') : item;
        if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) continue;
        const directory = maintenancePath.join(parent, item);
        try {
          if (!maintenanceFs.lstatSync(directory).isDirectory()) continue;
          if (maintenanceFs.readFileSync(maintenancePath.join(directory, '.install-complete'), 'utf8').trim() !== version) continue;
          completed.push({ version, directory, modified: maintenanceFs.statSync(maintenancePath.join(directory, '.install-complete')).mtimeMs });
        } catch {}
      }
      // An automatic reclaim never runs until the pinned install has completed.
      if (keepPrevious && !completed.some(value => value.version === required)) continue;
      const previous = keepPrevious
        ? completed.filter(value => value.version !== required).sort((a, b) => b.modified - a.modified || b.version.localeCompare(a.version, 'en', { numeric: true }))[0]?.version
        : undefined;
      for (const { version, directory } of completed) {
        if (version === required || version === previous || scan.stdout.includes(directory + maintenancePath.sep)) continue;
        maintenanceFs.rmSync(directory, { recursive: true, force: true });
        removed.push(name + '@' + version);
      }
    }
    return removed;
  });
}
`;

export interface ToolMaintenanceSpec {
  name: string;
  version: string;
}

export interface ToolMaintenanceResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ToolMaintenanceRunner = (nodePath: string, script: string) => Promise<ToolMaintenanceResult>;

/** Builds the program `runToolMaintenance` evaluates; it prints the removed versions as JSON. */
export function toolMaintenanceProgram(
  toolsRoot: string,
  specs: readonly ToolMaintenanceSpec[],
  policy: "prune" | "reclaim",
  flat = false,
): string {
  const pairs = specs.map((spec) => [spec.name, spec.version]);
  return `${deviceToolMaintenanceScript}
pruneTools(${JSON.stringify(toolsRoot)}, ${JSON.stringify(pairs)}, ${flat}, ${policy === "reclaim"})
  .then(removed => console.log(JSON.stringify(removed)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
`;
}

export class DeviceToolMaintenanceError extends Error {
  constructor(readonly detail: string) {
    super(detail || "Old helper versions could not be removed.");
    this.name = "DeviceToolMaintenanceError";
  }
}

/** Runs the maintenance program under `nodePath` and returns the `name@version` entries it removed. */
export async function runToolMaintenance(
  input: { nodePath: string; toolsRoot: string; specs: readonly ToolMaintenanceSpec[]; policy: "prune" | "reclaim" },
  runner: ToolMaintenanceRunner = runNodeScript,
): Promise<string[]> {
  const result = await runner(input.nodePath, toolMaintenanceProgram(input.toolsRoot, input.specs, input.policy));
  if (result.code !== 0) throw new DeviceToolMaintenanceError(result.stderr.trim());
  try {
    const removed = JSON.parse(result.stdout.trim()) as unknown;
    return Array.isArray(removed) ? removed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** Evaluates a script with Electron-as-Node (or plain Node in tests). */
export function runNodeScript(nodePath: string, script: string): Promise<ToolMaintenanceResult> {
  return new Promise((resolve) => {
    const child = spawn(nodePath, ["-e", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-65_536);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
