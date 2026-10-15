/**
 * Launch ACP agent processes from an installed runtime.
 *
 * Each process gets a runtime lease, its own temporary directory (some agent
 * builds unpack large bundles into TMPDIR and leave them behind when killed),
 * a pid-ledger entry for crash recovery, and a `BROWSER` hook that captures
 * sign-in URLs instead of letting the agent open windows on its own.
 */
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AcpHarnessDefinition, AcpLaunchPurpose } from "./harness.js";
import type { AcpRuntimeInstaller } from "./installer.js";
import { AcpPidLedger } from "./pid-ledger.js";
import { AcpProcess } from "./process.js";
import type { AcpLaunchedProcess, AcpProcessLauncher } from "./runtime.js";

export interface AcpLauncherOptions {
  definition: AcpHarnessDefinition;
  installer: AcpRuntimeInstaller;
  /** Harness-private state (profile, hooks). */
  stateDir: string;
  /** Root for per-process temporary directories. */
  tmpRoot: string;
  ledger: AcpPidLedger;
  /** Marker the browser hook prints before a URL. */
  browserUrlMarker?: string;
}

export interface AcpLaunchObservers {
  onStderrLine?(line: string): void;
}

/**
 * A directory Python's `webbrowser` accepts in BROWSER: it splits the value
 * on the path separator and may split commands on whitespace, so the hook
 * lives on a path with neither (macOS userData contains spaces).
 */
export function hookDirectory(stateDir: string, temporary: string = tmpdir()): string {
  const preferred = path.join(stateDir, "hooks");
  if (!/[\s:;]/u.test(preferred)) return preferred;
  return path.join(temporary, `aiden-acp-hooks-${process.getuid?.() ?? "user"}`);
}

export class AcpRuntimeLauncher implements AcpProcessLauncher {
  constructor(private readonly options: AcpLauncherOptions) {}

  launch(purpose: AcpLaunchPurpose, cwd: string, observers: AcpLaunchObservers = {}): Promise<AcpLaunchedProcess> {
    return this.launchWith(purpose, cwd, observers);
  }

  async launchWith(
    purpose: AcpLaunchPurpose,
    cwd: string,
    observers: AcpLaunchObservers = {},
    leaseOverride?: { runtimeDir: string; asset: Parameters<AcpHarnessDefinition["prepareLaunch"]>[0]["asset"]; release(): void },
  ): Promise<AcpLaunchedProcess> {
    const lease = leaseOverride ?? this.options.installer.acquire();
    let tmpDir: string | undefined;
    try {
      await mkdir(this.options.tmpRoot, { recursive: true, mode: 0o700 });
      tmpDir = await mkdtemp(path.join(this.options.tmpRoot, "run-"));
      const browserHook = await this.browserHook();
      const spec = await this.options.definition.prepareLaunch({
        runtimeDir: lease.runtimeDir,
        asset: lease.asset,
        stateDir: this.options.stateDir,
        tmpDir,
        cwd,
        purpose,
        ...(browserHook ? { browserHook } : {}),
      });
      const ledger = this.options.ledger;
      const child = new AcpProcess({
        command: spec.command,
        args: spec.args,
        cwd,
        env: spec.env,
        ...(observers.onStderrLine ? { onStderrLine: observers.onStderrLine } : {}),
        onStdoutNoise: (line) => this.options.definition.observeStdoutNoise?.(line),
        onSpawn: (pid) => ledger.record(pid, spec.command),
        onExit: (pid) => ledger.release(pid),
      });
      const directory = tmpDir;
      let disposed: Promise<void> | undefined;
      return {
        process: child,
        dispose: () => {
          disposed ??= (async () => {
            await child.close();
            lease.release();
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          })();
          return disposed;
        },
      };
    } catch (error) {
      lease.release();
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Stop processes and remove temporary directories left by a previous run. */
  async sweep(): Promise<void> {
    await this.options.ledger.sweep().catch(() => 0);
    let entries: string[] = [];
    try {
      entries = await readdir(this.options.tmpRoot);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("run-"))
        .map((entry) => rm(path.join(this.options.tmpRoot, entry), { recursive: true, force: true }).catch(() => undefined)),
    );
  }

  /**
   * Written before every launch: a temporary directory may be cleaned while
   * Aiden runs, and a missing hook would let the agent open a browser itself.
   */
  private async browserHook(): Promise<string | undefined> {
    const marker = this.options.browserUrlMarker;
    if (!marker || process.platform === "win32") return undefined;
    try {
      const directory = hookDirectory(this.options.stateDir);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, "capture-browser-url.sh");
      // Print, never open: the URL is shown by Aiden's own sign-in flow.
      await writeFile(file, `#!/bin/sh\nprintf '%s%s\\n' '${marker}' "$1" >&2\nexit 0\n`, { mode: 0o700 });
      await chmod(file, 0o700);
      return file;
    } catch {
      return undefined;
    }
  }
}
