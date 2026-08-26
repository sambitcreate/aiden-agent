// Interactive, workspace-scoped terminal sessions. Processes are started only
// through a user's selected workspace and are owned by the renderer that
// created them; the renderer never supplies a shell command or working path.

import * as path from "path";
import * as fs from "fs/promises";
import { createRequire } from "module";
import { spawn, type IPty } from "node-pty";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";
import { recordDiagnosticCounter, recordDiagnosticGauge } from "./performance-diagnostics.js";

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
  ownerDocumentId: string;
  owner: RendererDocumentOwner;
  removeOwnerInvalidation: () => void;
  buffer: string;
  sequence: number;
}

export interface TerminalServiceOptions {
  prepareSpawnHelper?: () => Promise<void>;
  spawnPty?: typeof spawn;
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
  private readonly webContentsEpochs = new Map<number, number>();
  private spawnHelperReady: Promise<void> | undefined;

  constructor(private readonly options: TerminalServiceOptions = {}) {}

  async create(
    workspaceId: string,
    cwd: string,
    owner: RendererDocumentOwner,
    admissionSignal?: AbortSignal,
    revalidateAccess?: () => Promise<void>,
  ): Promise<TerminalSessionInfo> {
    const ownerEpoch = this.webContentsEpochs.get(owner.id) ?? 0;
    const ownerInvalidated = () =>
      admissionSignal?.aborted ||
      owner.isDestroyed() ||
      (this.webContentsEpochs.get(owner.id) ?? 0) !== ownerEpoch;
    await this.ensureSpawnHelperExecutable();
    if (ownerInvalidated()) {
      throw new Error("The workspace changed before the terminal could start.");
    }
    await revalidateAccess?.();
    if (ownerInvalidated()) {
      throw new Error("The workspace changed before the terminal could start.");
    }
    const sessionsForOwner = [...this.sessions.values()].filter(
      (session) =>
        session.ownerWebContentsId === owner.id && session.ownerDocumentId === owner.documentId,
    );
    if (sessionsForOwner.length >= MAX_SESSIONS_PER_WEB_CONTENTS) {
      throw new Error(
        `A maximum of ${MAX_SESSIONS_PER_WEB_CONTENTS} terminal sessions can be open at once.`,
      );
    }
    const id = terminalId();
    const pty = (this.options.spawnPty ?? spawn)(terminalShell(), [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    if (ownerInvalidated()) {
      this.terminatePty(pty);
      throw new Error("The workspace changed before the terminal could start.");
    }
    const session: TerminalSession = {
      id,
      workspaceId,
      cwd,
      pty,
      ownerWebContentsId: owner.id,
      ownerDocumentId: owner.documentId,
      owner,
      removeOwnerInvalidation: () => {},
      buffer: "",
      sequence: 0,
    };
    this.sessions.set(id, session);
    recordDiagnosticCounter("resource:pty", { count: 1 });
    recordDiagnosticGauge("live:pty", this.sessions.size);
    const removeOwnerInvalidation = owner.onInvalidated(() => {
      const current = this.sessions.get(id);
      if (current === session) this.terminate(id, session);
    });
    session.removeOwnerInvalidation = removeOwnerInvalidation;
    if (!this.sessions.has(id)) {
      removeOwnerInvalidation();
      throw new Error("The renderer document changed before the terminal could start.");
    }
    if (ownerInvalidated()) {
      this.terminate(id, session);
      throw new Error("The renderer document changed before the terminal could start.");
    }

    pty.onData((data) => {
      const current = this.sessions.get(id);
      if (!current) return;
      current.buffer = `${current.buffer}${data}`.slice(-MAX_BUFFER_CHARS);
      current.sequence += 1;
      recordDiagnosticCounter("pty:output", { bytesOut: data.length * 3 });
      try {
        owner.send("terminal:data", { sessionId: id, sequence: current.sequence, data });
      } catch {
        this.terminate(id, current);
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      const current = this.sessions.get(id);
      if (current !== session) return;
      this.sessions.delete(id);
      recordDiagnosticGauge("live:pty", this.sessions.size);
      current.removeOwnerInvalidation();
      recordDiagnosticCounter("resource:pty-exit", { errors: exitCode === 0 ? 0 : 1 });
      try {
        owner.send("terminal:exit", { sessionId: id, exitCode, signal });
      } catch {
        // The exact renderer document already disappeared.
      }
    });

    return { id, workspaceId, cwd };
  }

  snapshot(id: string, owner: RendererDocumentOwner): TerminalSnapshot {
    const session = this.getOwned(id, owner);
    return { buffer: session.buffer, sequence: session.sequence };
  }

  write(id: string, data: unknown, owner: RendererDocumentOwner): void {
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT_CHARS) {
      throw new Error("Terminal input must be a non-empty message smaller than 64 KB.");
    }
    this.getOwned(id, owner).pty.write(data);
    recordDiagnosticCounter("pty:input", { bytesIn: data.length * 3 });
  }

  resize(id: string, cols: unknown, rows: unknown, owner: RendererDocumentOwner): void {
    this.getOwned(id, owner).pty.resize(
      clamp(cols, MIN_COLS, MAX_COLS, 120),
      clamp(rows, MIN_ROWS, MAX_ROWS, 30),
    );
  }

  close(id: string, owner: RendererDocumentOwner): void {
    const session = this.getOwned(id, owner);
    this.terminate(id, session);
  }

  closeForWebContents(webContentsId: number): void {
    this.webContentsEpochs.set(webContentsId, (this.webContentsEpochs.get(webContentsId) ?? 0) + 1);
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

  workspaceId(id: string, owner: RendererDocumentOwner): string {
    return this.getOwned(id, owner).workspaceId;
  }

  private getOwned(id: string, owner: RendererDocumentOwner): TerminalSession {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.ownerWebContentsId !== owner.id ||
      session.ownerDocumentId !== owner.documentId ||
      owner.isDestroyed()
    ) {
      throw new Error("Terminal session is unavailable.");
    }
    return session;
  }

  private terminate(id: string, session: TerminalSession): void {
    this.sessions.delete(id);
    recordDiagnosticGauge("live:pty", this.sessions.size);
    session.removeOwnerInvalidation();
    this.terminatePty(session.pty);
    try {
      session.owner.send("terminal:exit", {
        sessionId: id,
        exitCode: null,
        signal: "SIGHUP",
      });
    } catch {
      // The exact renderer document already disappeared.
    }
  }

  private terminatePty(pty: IPty): void {
    // A PTY shell is normally its own process group. Signalling the group
    // cleans up ordinary foreground/background descendants as well as the
    // shell; deliberately detached processes retain normal Unix semantics.
    if (process.platform !== "win32") {
      try {
        process.kill(-pty.pid, "SIGHUP");
      } catch {
        // The process may have exited between lookup and termination.
      }
    }
    try {
      pty.kill();
    } catch {
      // Teardown is best effort and must not block other renderer-document
      // revocation callbacks.
    }
  }

  // node-pty's macOS helper can be restored without its execute bit by npm's
  // prebuilt archive. T3 Code guards this same boundary before opening a PTY.
  private ensureSpawnHelperExecutable(): Promise<void> {
    if (this.options.prepareSpawnHelper) return this.options.prepareSpawnHelper();
    this.spawnHelperReady ??= (async () => {
      const require = createRequire(import.meta.url);
      const packageDir = path.dirname(require.resolve("node-pty/package.json"));
      const helper = path.join(
        packageDir,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      );
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
