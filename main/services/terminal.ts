// Interactive, workspace-scoped terminal sessions. Processes are started only
// through a user's selected workspace and are owned by the renderer that
// created them; the renderer never supplies a shell command or working path.

import * as path from "path";
import * as fs from "fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "module";
import { spawn, type IPty } from "node-pty";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";

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
  /**
   * Ordered shell candidates. The first that exists and is executable wins.
   * Exposed for tests; production resolves `$SHELL` then the macOS defaults.
   */
  shellCandidates?: () => string[];
  /**
   * Returns the `spawn-helper` paths node-pty will use. Exposed for tests so
   * the chmod/verify path can be exercised without touching node_modules.
   */
  spawnHelperPaths?: () => Promise<string[]>;
}

function terminalId(): string {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
}

/**
 * Ordered candidate shells. `$SHELL` is honored first when it is absolute
 * (Terminal.app and friends set it to the user's default), then the macOS
 * default (`/bin/zsh`), then the POSIX fallbacks. The spawn-helper execs the
 * shell via `execvp`, so every candidate must be verified executable before
 * being handed to node-pty: a stale `$SHELL` pointing at a removed Homebrew
 * install would otherwise surface as an opaque `posix_spawnp failed.`.
 */
function defaultShellCandidates(): string[] {
  const candidates: string[] = [];
  const shell = process.env.SHELL;
  if (shell && path.isAbsolute(shell)) candidates.push(shell);
  candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  // De-duplicate while preserving order (e.g. SHELL=/bin/zsh).
  return [...new Set(candidates)];
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveShell(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error(
    `No executable shell found on this Mac (checked ${candidates
      .map((candidate) => JSON.stringify(candidate))
      .join(", ")}). Set $SHELL to an installed shell, or reinstall macOS.`,
  );
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
    const shell = await resolveShell((this.options.shellCandidates ?? defaultShellCandidates)());
    const pty = (this.options.spawnPty ?? spawn)(shell, [], {
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
      current.removeOwnerInvalidation();
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
  // prebuilt archive, and `posix_spawn` of a non-executable file is exactly
  // what surfaces to users as `posix_spawnp failed.`. Guard every helper that
  // node-pty may load: chmod if needed, then verify (never assume). A failure
  // here must be descriptive so the user can fix it, not opaque.
  private ensureSpawnHelperExecutable(): Promise<void> {
    if (this.options.prepareSpawnHelper) return this.options.prepareSpawnHelper();
    const resolveHelpers = this.options.spawnHelperPaths ?? defaultSpawnHelperPaths;
    this.spawnHelperReady ??= (async () => {
      const helpers = await resolveHelpers();
      await Promise.all(helpers.map((helper) => ensureHelperExecutable(helper)));
    })();
    return this.spawnHelperReady;
  }
}

/**
 * Resolve every `spawn-helper` node-pty may load on this machine.
 *
 * node-pty 1.1.0 loads the helper from `prebuilds/<platform>-<arch>/spawn-helper`
 * via `utils.loadNativeModule`, and in a packaged Electron app the same file
 * lives under `app.asar.unpacked`. We resolve from `node-pty/package.json` and
 * enumerate every `prebuilds/*` directory so a wrong-arch guess, a Rosetta run,
 * or an extra prebuild still gets fixed up.
 */
async function defaultSpawnHelperPaths(): Promise<string[]> {
  const require = createRequire(import.meta.url);
  let packageDir: string;
  try {
    packageDir = path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    // Without node-pty resolvable there is no helper to fix; node-pty's own
    // spawn will surface the underlying error.
    return [];
  }
  const prebuildsDir = path.join(packageDir, "prebuilds");
  let entries: string[];
  try {
    entries = await fs.readdir(prebuildsDir);
  } catch {
    return [];
  }
  const helpers: string[] = [];
  for (const entry of entries) {
    helpers.push(path.join(prebuildsDir, entry, "spawn-helper"));
    // Packaged apps unpack node-pty to app.asar.unpacked; mirror node-pty's
    // own helperPath rewrite so the on-disk copy there is fixed too.
    if (packageDir.includes("app.asar")) {
      helpers.push(
        path.join(prebuildsDir, entry, "spawn-helper").replace("app.asar", "app.asar.unpacked"),
      );
    }
  }
  return helpers;
}

async function ensureHelperExecutable(helper: string): Promise<void> {
  let info;
  try {
    info = await fs.stat(helper);
  } catch {
    return; // This prebuild dir has no helper; node-pty picks another path.
  }
  if (!info.isFile()) return;
  if ((info.mode & 0o111) === 0) {
    try {
      await fs.chmod(helper, 0o755);
    } catch (error) {
      throw new Error(
        `Aiden could not make node-pty's spawn-helper executable (${helper}): ${
          error instanceof Error ? error.message : String(error)
        }. Run "chmod 755 ${helper}" or reinstall dependencies.`,
      );
    }
  }
  // Verify, never assume: a read-only packaged copy or a permission loss
  // would otherwise leave the terminal broken with an opaque error.
  const after = await fs.stat(helper);
  if ((after.mode & 0o111) === 0) {
    throw new Error(
      `node-pty's spawn-helper is still not executable after chmod (${helper}). Run "chmod 755 ${helper}" or reinstall dependencies.`,
    );
  }
}

export const terminalService = new TerminalService();
