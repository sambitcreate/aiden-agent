// Interactive, workspace-scoped terminal sessions. Processes are started only
// through a user's selected workspace and are owned by the renderer that
// created them; the renderer never supplies a shell command or working path.

import * as path from "path";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { spawn, type IPty } from "node-pty";
import type { WebContents } from "electron";

const MAX_INPUT_CHARS = 64_000;
const MAX_BUFFER_CHARS = 200_000;
const MAX_SESSIONS_PER_WEB_CONTENTS = 8;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 4;
const MAX_ROWS = 300;

export interface TerminalSessionInfo {
  id: string;
  workspaceId: string;
  cwd: string;
}

export interface TerminalSnapshot {
  buffer: string;
  sequence: number;
}

interface TerminalSession extends TerminalSessionInfo {
  pty: IPty;
  ownerWebContentsId: number;
  webContents: WebContents;
  buffer: string;
  sequence: number;
}

function terminalId(): string {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
}

function terminalShell(): string {
  const shell = process.env.SHELL;
  return shell && path.isAbsolute(shell) ? shell : "/bin/zsh";
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  private spawnHelperReady: Promise<void> | undefined;

  async create(workspaceId: string, cwd: string, sender: WebContents): Promise<TerminalSessionInfo> {
    await this.ensureSpawnHelperExecutable();
    const sessionsForOwner = [...this.sessions.values()].filter((session) => session.ownerWebContentsId === sender.id);
    if (sessionsForOwner.length >= MAX_SESSIONS_PER_WEB_CONTENTS) {
      throw new Error(`A maximum of ${MAX_SESSIONS_PER_WEB_CONTENTS} terminal sessions can be open at once.`);
    }
    const id = terminalId();
    const pty = spawn(terminalShell(), [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    const session: TerminalSession = {
      id,
      workspaceId,
      cwd,
      pty,
      ownerWebContentsId: sender.id,
      webContents: sender,
      buffer: "",
      sequence: 0,
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      const current = this.sessions.get(id);
      if (!current) return;
      current.buffer = `${current.buffer}${data}`.slice(-MAX_BUFFER_CHARS);
      current.sequence += 1;
      if (!sender.isDestroyed()) sender.send("terminal:data", { sessionId: id, sequence: current.sequence, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (!this.sessions.delete(id)) return;
      if (!sender.isDestroyed()) sender.send("terminal:exit", { sessionId: id, exitCode, signal });
    });

    return { id, workspaceId, cwd };
  }

  snapshot(id: string, sender: WebContents): TerminalSnapshot {
    const session = this.getOwned(id, sender);
    return { buffer: session.buffer, sequence: session.sequence };
  }

  write(id: string, data: unknown, sender: WebContents): void {
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT_CHARS) {
      throw new Error("Terminal input must be a non-empty message smaller than 64 KB.");
    }
    this.getOwned(id, sender).pty.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown, sender: WebContents): void {
    this.getOwned(id, sender).pty.resize(
      clamp(cols, MIN_COLS, MAX_COLS, 120),
      clamp(rows, MIN_ROWS, MAX_ROWS, 30),
    );
  }

  close(id: string, sender: WebContents): void {
    const session = this.getOwned(id, sender);
    this.terminate(id, session);
  }

  closeForWebContents(webContentsId: number): void {
    for (const [id, session] of this.sessions) {
      if (session.ownerWebContentsId !== webContentsId) continue;
      this.terminate(id, session);
    }
  }

  closeForWorkspace(workspaceId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.workspaceId !== workspaceId) continue;
      this.terminate(id, session);
    }
  }

  workspaceId(id: string, sender: WebContents): string {
    return this.getOwned(id, sender).workspaceId;
  }

  private getOwned(id: string, sender: WebContents): TerminalSession {
    const session = this.sessions.get(id);
    if (!session || session.ownerWebContentsId !== sender.id) {
      throw new Error("Terminal session is unavailable.");
    }
    return session;
  }

  private terminate(id: string, session: TerminalSession): void {
    this.sessions.delete(id);
    // A PTY shell is normally its own process group. Signalling the group
    // cleans up ordinary foreground/background descendants as well as the
    // shell; deliberately detached processes retain normal Unix semantics.
    if (process.platform !== "win32") {
      try {
        process.kill(-session.pty.pid, "SIGHUP");
      } catch {
        // The process may have exited between lookup and termination.
      }
    }
    session.pty.kill();
    if (!session.webContents.isDestroyed()) {
      session.webContents.send("terminal:exit", { sessionId: id, exitCode: null, signal: "SIGHUP" });
    }
  }

  // node-pty's macOS helper can be restored without its execute bit by npm's
  // prebuilt archive. T3 Code guards this same boundary before opening a PTY.
  private ensureSpawnHelperExecutable(): Promise<void> {
    this.spawnHelperReady ??= (async () => {
      const require = createRequire(import.meta.url);
      const packageDir = path.dirname(require.resolve("node-pty/package.json"));
      const helper = path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
      try {
        await fs.chmod(helper, 0o755);
      } catch {
        // Some package layouts do not ship a separate helper; node-pty then
        // uses its own fallback path, so this stays a best-effort preparation.
      }
    })();
    return this.spawnHelperReady;
  }
}

export const terminalService = new TerminalService();
