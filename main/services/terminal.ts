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
  /** The shell that actually launched this session (e.g. `/bin/zsh`). */
  resolvedShell: string;
  /**
   * True when the preferred shell was skipped and a fallback launched the
   * session. The renderer surfaces a one-time toast so the user knows their
   * `$SHELL` was unavailable.
   */
  preferredShellSkipped: boolean;
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
  historyWorkspaceId: string;
}

export interface TerminalServiceOptions {
  prepareSpawnHelper?: () => Promise<void>;
  spawnPty?: typeof spawn;
  /**
   * Ordered shell candidates. The first that exists and is executable wins.
   * Exposed for tests; production resolves `$SHELL` then the macOS defaults.
   */
  shellCandidates?: () => string[];
  /** Test seam for candidate executability checks. */
  shellIsExecutable?: (filePath: string) => boolean;
  /**
   * Returns the `spawn-helper` paths node-pty will use. Exposed for tests so
   * the chmod/verify path can be exercised without touching node_modules.
   */
  spawnHelperPaths?: () => Promise<string[]>;
  /**
   * Optional persisted-history store. When present, prior output is restored on
   * open and new output is debounced-to-disk so a terminal survives close and
   * app restart. Defaults to none (in-memory only) for tests and legacy paths.
   */
  historyStore?: TerminalHistoryStoreLike;
}

/**
 * The history-store surface `TerminalService` depends on. The real
 * implementation lives in `terminal-history.ts`; this structural interface keeps
 * the service testable without the filesystem and without a circular import.
 */
export interface TerminalHistoryStoreLike {
  read(workspaceId: string): Promise<string>;
  append(workspaceId: string, data: string): void;
  flush(workspaceId: string): Promise<void>;
  flushAll?(): Promise<void>;
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

/**
 * Whether a shell spawn failure is worth retrying against the next candidate.
 * Walks the error + `cause` chain collecting messages (a wrapping layer like
 * node-pty often buries the real string on `cause`) and matches the substrings
 * that mean "this shell is missing or not launchable": `posix_spawnp failed`,
 * `ENOENT`, `not found`, `file not found`, `no such file`. Genuine errors
 * (e.g. `EINVAL`, out of fds) are NOT retryable and must surface immediately.
 *
 * Ported from t3code's `isRetryableShellSpawnError` (Manager.ts:567).
 */
function isRetryableShellSpawnError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (typeof current === "string") {
      messages.push(current);
    } else if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) queue.push(cause);
    } else if (typeof current === "object" && current !== null) {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") messages.push(value.message);
      if (value.cause) queue.push(value.cause);
    }
  }
  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface ShellSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
}

/**
 * Try each shell candidate in order, retrying the next on a retryable spawn
 * failure (missing binary, `posix_spawnp failed`). Returns the launched pty and
 * the shell that won. A non-retryable error rethrows immediately so it isn't
 * masked by the fallback chain. If every candidate fails to launch, throws a
 * descriptive error listing every attempted shell and the last cause.
 *
 * Ported from t3code's `trySpawn` (Manager.ts:1830).
 */
async function trySpawnShell(
  candidates: string[],
  spawnPty: typeof spawn,
  options: ShellSpawnOptions,
): Promise<{ pty: IPty; shell: string; preferredShellSkipped: boolean }> {
  let lastError: unknown = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const shell = candidates[index];
    if (!shell) continue;
    try {
      const pty = spawnPty(shell, [], {
        name: options.name ?? "xterm-256color",
        cols: options.cols ?? 120,
        rows: options.rows ?? 30,
        cwd: options.cwd,
        env: options.env,
      });
      return { pty, shell, preferredShellSkipped: index > 0 };
    } catch (error) {
      lastError = error;
      if (!isRetryableShellSpawnError(error)) throw error;
      // Retryable: try the next candidate.
    }
  }
  const attempted = candidates.filter(Boolean).map((shell) => JSON.stringify(shell)).join(", ");
  const causeMessage =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === "string"
        ? lastError
        : "unknown error";
  throw new Error(
    `Could not launch any shell (tried ${attempted}). Last failure: ${causeMessage}. Set $SHELL to an installed shell or reinstall macOS.`,
  );
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly webContentsEpochs = new Map<number, number>();
  private spawnHelperReady: Promise<void> | undefined;
  private historyStore: TerminalHistoryStoreLike | undefined;

  constructor(private readonly options: TerminalServiceOptions = {}) {
    this.historyStore = options.historyStore;
  }

  /** Install the production history store before any renderer can open a terminal. */
  installHistoryStore(historyStore: TerminalHistoryStoreLike): void {
    if (this.historyStore) throw new Error("Terminal history is already initialized.");
    if (this.sessions.size > 0) {
      throw new Error("Terminal history must be initialized before opening a terminal.");
    }
    this.historyStore = historyStore;
  }

  /** Settle every pending history write before application shutdown. */
  async flushHistory(): Promise<void> {
    if (!this.historyStore) return;
    if (this.historyStore.flushAll) {
      await this.historyStore.flushAll();
      return;
    }
    const workspaceIds = new Set(
      [...this.sessions.values()].map((session) => session.historyWorkspaceId),
    );
    await Promise.all([...workspaceIds].map((workspaceId) => this.historyStore!.flush(workspaceId)));
  }

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
    const candidates = (this.options.shellCandidates ?? defaultShellCandidates)();
    // Verify each candidate exists+is executable before spawning, so the retry
    // loop below only fights launch failures (not obvious "no such file" ones).
    const shellIsExecutable = this.options.shellIsExecutable ?? isExecutable;
    const executableCandidates = candidates.filter(shellIsExecutable);
    if (executableCandidates.length === 0) {
      throw new Error(
        `No executable shell found on this Mac (checked ${candidates
          .map((candidate) => JSON.stringify(candidate))
          .join(", ")}). Set $SHELL to an installed shell, or reinstall macOS.`,
      );
    }
    const { pty, shell: resolvedShell, preferredShellSkipped } = await trySpawnShell(
      executableCandidates,
      this.options.spawnPty ?? spawn,
      {
        cwd,
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      },
    );
    if (ownerInvalidated()) {
      this.terminatePty(pty);
      throw new Error("The workspace changed before the terminal could start.");
    }
    // Restore the sanitized prior-session output so the terminal reopens with
    // its history. The renderer writes this buffer to xterm on hydrate, so no
    // renderer change is required for the seed.
    const restoredHistory = await this.historyStore?.read(workspaceId);
    if (ownerInvalidated()) {
      this.terminatePty(pty);
      throw new Error("The workspace changed before the terminal could start.");
    }
    const session: TerminalSession = {
      id,
      workspaceId,
      cwd,
      resolvedShell,
      preferredShellSkipped,
      pty,
      ownerWebContentsId: owner.id,
      ownerDocumentId: owner.documentId,
      owner,
      removeOwnerInvalidation: () => {},
      buffer: restoredHistory ?? "",
      sequence: restoredHistory ? 1 : 0,
      historyWorkspaceId: workspaceId,
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
      // Persist new output (the store sanitizes and debounces the disk write).
      this.historyStore?.append(workspaceId, data);
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
      // Flush the final chunk before the session goes away.
      void this.historyStore?.flush(workspaceId);
      try {
        owner.send("terminal:exit", { sessionId: id, exitCode, signal });
      } catch {
        // The exact renderer document already disappeared.
      }
    });

    return { id, workspaceId, cwd, resolvedShell, preferredShellSkipped };
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
    // Best-effort flush so the last output chunk is on disk before the session
    // is torn down (window close, workspace switch, quit). Never block on it.
    void this.historyStore?.flush(session.historyWorkspaceId);
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
