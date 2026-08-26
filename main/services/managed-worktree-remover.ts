import { spawn } from "node:child_process";
import { trackDiagnosticChild } from "./performance-child.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ManagedWorktreeRemovalFailure =
  | "identity_changed"
  | "mutation_detected"
  | "io_failed"
  | "invalid_input";

export interface ManagedWorktreeDirectoryIdentity {
  path: string;
  device: number;
  inode: number;
  authorizedManifestDigest?: string;
  authorize?: (scannedPath: string, manifestDigest: string) => Promise<void>;
}

export interface ManagedWorktreeRemoverTestControls {
  failBeforeManifestUnlink?: boolean;
  pauseAfterScanPath?: string;
  pauseAfterUnlinkName?: string;
  pauseAfterUnlinkPath?: string;
}

const MANIFEST_DIGEST = /^[0-9a-f]{64}$/u;

function removalToken(targetPath: string): string | undefined {
  const match = /^(?:\.aiden-removing-|\.aiden-authorizing-)([A-Za-z0-9._-]+)$/u.exec(
    path.basename(targetPath),
  );
  return match?.[1];
}

function removalManifestPath(targetPath: string, token: string): string {
  return path.join(path.dirname(targetPath), `.aiden-removal-manifest-${token}`);
}

function finalizingRemovalManifestPath(manifestPath: string): string {
  return `${manifestPath}.finalizing`;
}

function deletingRemovalManifestPath(manifestPath: string): string {
  return `${manifestPath}.deleting`;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await fs.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Complete the helper's crash-safe sidecar cleanup only when it still matches
 * the exact manifest digest durably authorized by the deletion journal.
 */
export async function finalizeManagedWorktreeRemovalManifest(
  targetPath: string,
  expectedDigest: string,
  binary = defaultRemoverBinary(),
): Promise<void> {
  const token = removalToken(targetPath);
  if (!path.isAbsolute(targetPath) || !token || !MANIFEST_DIGEST.test(expectedDigest)) {
    throw new ManagedWorktreeRemoverError("invalid_input");
  }
  const parent = path.dirname(targetPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      binary,
      ["finalize-manifest", "--parent", parent, "--token", token, "--digest", expectedDigest],
      {
        detached: false,
        env: removerEnvironment(binary, undefined),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    trackDiagnosticChild("worktree-remover", child);
    const outputChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const finish = (error?: ManagedWorktreeRemoverError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new ManagedWorktreeRemoverError("io_failed"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= 256) outputChunks.push(chunk);
      else {
        child.kill("SIGKILL");
        finish(new ManagedWorktreeRemoverError("io_failed"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.byteLength;
      if (errorBytes <= 256) errorChunks.push(chunk);
      else {
        child.kill("SIGKILL");
        finish(new ManagedWorktreeRemoverError("io_failed"));
      }
    });
    child.once("error", () => finish(new ManagedWorktreeRemoverError("io_failed")));
    child.once("close", (code) => {
      if (settled) return;
      const output = Buffer.concat(outputChunks).toString("utf8");
      const error = Buffer.concat(errorChunks).toString("utf8");
      if (code === 0 && output.length === 0 && error.length === 0) {
        finish();
      } else if (code === 21 && output.length === 0 && error === "mutation_detected\n") {
        finish(new ManagedWorktreeRemoverError("mutation_detected"));
      } else if (code === 22 && output.length === 0 && error === "io_failed\n") {
        finish(new ManagedWorktreeRemoverError("io_failed"));
      } else if (code === 64 && output.length === 0 && error === "invalid_input\n") {
        finish(new ManagedWorktreeRemoverError("invalid_input"));
      } else {
        finish(new ManagedWorktreeRemoverError("io_failed"));
      }
    });
  });
}

/**
 * Inspect only the three exact sidecar-phase pathnames. This deliberately does
 * not open, hash, or remove unjournaled content; callers use presence as a
 * fail-closed recovery signal when no digest was durably authorized.
 */
export async function managedWorktreeRemovalManifestPresent(targetPath: string): Promise<boolean> {
  const token = removalToken(targetPath);
  if (!path.isAbsolute(targetPath) || !token) {
    throw new ManagedWorktreeRemoverError("invalid_input");
  }
  const manifestPath = removalManifestPath(targetPath, token);
  const candidates = [
    manifestPath,
    finalizingRemovalManifestPath(manifestPath),
    deletingRemovalManifestPath(manifestPath),
  ];
  const present = async (): Promise<boolean> => {
    for (const candidate of candidates) {
      try {
        await fs.lstat(candidate);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ManagedWorktreeRemoverError("io_failed");
        }
      }
    }
    return false;
  };
  if (await present()) return true;
  try {
    await syncDirectory(path.dirname(manifestPath));
  } catch {
    throw new ManagedWorktreeRemoverError("io_failed");
  }
  return present();
}

export class ManagedWorktreeRemoverError extends Error {
  readonly name = "ManagedWorktreeRemoverError";

  constructor(readonly failure: ManagedWorktreeRemovalFailure) {
    super(
      failure === "mutation_detected" || failure === "identity_changed"
        ? "The managed worktree changed during deletion and was preserved for review."
        : "Aiden could not safely remove the managed worktree quarantine.",
    );
  }
}

function defaultRemoverBinary(): string {
  if (
    process.defaultApp !== true &&
    typeof process.resourcesPath === "string" &&
    process.resourcesPath.length > 0
  ) {
    return path.resolve(process.resourcesPath, "..", "Helpers", "aiden-worktree-remover");
  }
  return path.resolve(process.cwd(), "build", "native", "aiden-worktree-remover");
}

function removerEnvironment(
  binary: string,
  controls: ManagedWorktreeRemoverTestControls | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  };
  if (!controls || Object.keys(controls).length === 0) return environment;
  const controlKeys = Object.keys(controls);
  if (path.basename(binary) !== "aiden-worktree-remover-test") {
    throw new ManagedWorktreeRemoverError("invalid_input");
  }
  if (
    controlKeys.some(
      (key) =>
        key !== "failBeforeManifestUnlink" &&
        key !== "pauseAfterScanPath" &&
        key !== "pauseAfterUnlinkName" &&
        key !== "pauseAfterUnlinkPath",
    ) ||
    (controls.pauseAfterScanPath !== undefined && !path.isAbsolute(controls.pauseAfterScanPath)) ||
    (controls.pauseAfterUnlinkPath !== undefined &&
      !path.isAbsolute(controls.pauseAfterUnlinkPath)) ||
    (controls.pauseAfterUnlinkName !== undefined &&
      (controls.pauseAfterUnlinkName.length === 0 ||
        controls.pauseAfterUnlinkName === "." ||
        controls.pauseAfterUnlinkName === ".." ||
        controls.pauseAfterUnlinkName.includes("/"))) ||
    (controls.pauseAfterUnlinkPath === undefined) !== (controls.pauseAfterUnlinkName === undefined)
  ) {
    throw new ManagedWorktreeRemoverError("invalid_input");
  }
  if (controls.pauseAfterScanPath) {
    environment.AIDEN_REMOVER_TEST_PAUSE_AFTER_SCAN = controls.pauseAfterScanPath;
  }
  if (controls.pauseAfterUnlinkPath && controls.pauseAfterUnlinkName) {
    environment.AIDEN_REMOVER_TEST_PAUSE_AFTER_UNLINK = controls.pauseAfterUnlinkPath;
    environment.AIDEN_REMOVER_TEST_PAUSE_AFTER_UNLINK_NAME = controls.pauseAfterUnlinkName;
  }
  if (controls.failBeforeManifestUnlink === true) {
    environment.AIDEN_REMOVER_TEST_FAIL_BEFORE_MANIFEST_UNLINK = "1";
  }
  return environment;
}

export async function removeManagedWorktreeDirectory(
  identity: ManagedWorktreeDirectoryIdentity,
  binary = defaultRemoverBinary(),
  testControls?: ManagedWorktreeRemoverTestControls,
): Promise<void> {
  const name = path.basename(identity.path);
  const token = removalToken(identity.path);
  if (
    !path.isAbsolute(identity.path) ||
    !token ||
    !Number.isSafeInteger(identity.device) ||
    !Number.isSafeInteger(identity.inode) ||
    identity.device < 0 ||
    identity.inode < 0 ||
    (identity.authorizedManifestDigest !== undefined &&
      !MANIFEST_DIGEST.test(identity.authorizedManifestDigest))
  ) {
    throw new ManagedWorktreeRemoverError("invalid_input");
  }
  const parent = path.dirname(identity.path);
  const expectedAuthorizationName = `.aiden-authorizing-${token}`;
  const environment = removerEnvironment(binary, testControls);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "remove",
        "--parent",
        parent,
        "--name",
        name,
        "--device",
        String(identity.device),
        "--inode",
        String(identity.inode),
        "--manifest-mode",
        identity.authorizedManifestDigest === undefined ? "fresh" : "resume",
      ],
      {
        detached: false,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    trackDiagnosticChild("worktree-remover", child);
    const errorChunks: Buffer[] = [];
    const outputChunks: Buffer[] = [];
    let errorBytes = 0;
    let outputBytes = 0;
    let authorizationStarted = false;
    let authorizationRejected = false;
    let authorizationError: unknown;
    let ready = false;
    let settled = false;
    const finish = (error?: unknown, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failed) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new ManagedWorktreeRemoverError("io_failed"), true);
    }, 30_000);
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > 256) {
        child.kill("SIGKILL");
        finish(new ManagedWorktreeRemoverError("io_failed"), true);
        return;
      }
      outputChunks.push(chunk);
      const output = Buffer.concat(outputChunks).toString("utf8");
      if (!output.endsWith("\n") || authorizationStarted) return;
      const match = /^ready:(\.aiden-authorizing-[A-Za-z0-9._-]+):([0-9a-f]{64})\n$/u.exec(output);
      if (!match || match[1] !== expectedAuthorizationName) {
        child.kill("SIGKILL");
        finish(new ManagedWorktreeRemoverError("io_failed"), true);
        return;
      }
      authorizationStarted = true;
      ready = true;
      const scannedPath = path.join(parent, match[1]);
      const scannedManifestDigest = match[2]!;
      if (
        identity.authorizedManifestDigest !== undefined &&
        scannedManifestDigest !== identity.authorizedManifestDigest
      ) {
        authorizationRejected = true;
        authorizationError = new ManagedWorktreeRemoverError("mutation_detected");
        child.stdin.end("abort\n");
        return;
      }
      void Promise.resolve(
        identity.authorizedManifestDigest === undefined
          ? identity.authorize?.(scannedPath, scannedManifestDigest)
          : undefined,
      )
        .then(() => {
          if (!settled) {
            child.stdin.end(
              identity.authorizedManifestDigest === undefined
                ? "continue\n"
                : `resume:${scannedManifestDigest}\n`,
            );
          }
        })
        .catch((error: unknown) => {
          if (settled) return;
          authorizationRejected = true;
          authorizationError = error;
          child.stdin.end("abort\n");
        });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.byteLength;
      if (errorBytes <= 16 * 1024) errorChunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", () => {
      if (authorizationRejected) {
        finish(authorizationError, true);
      } else {
        finish(new ManagedWorktreeRemoverError("io_failed"), true);
      }
    });
    child.once("close", (code) => {
      if (authorizationRejected) {
        finish(authorizationError, true);
        return;
      }
      if (code === 0 && ready) {
        const authorizedDigest =
          identity.authorizedManifestDigest ??
          /^ready:[^:]+:([0-9a-f]{64})\n$/u.exec(Buffer.concat(outputChunks).toString("utf8"))?.[1];
        if (!authorizedDigest) {
          finish(new ManagedWorktreeRemoverError("io_failed"), true);
          return;
        }
        void finalizeManagedWorktreeRemovalManifest(identity.path, authorizedDigest)
          .then(() => finish())
          .catch((error: unknown) => finish(error, true));
        return;
      }
      const failure = Buffer.concat(errorChunks).toString("utf8").trim();
      if (
        failure === "identity_changed" ||
        failure === "mutation_detected" ||
        failure === "io_failed" ||
        failure === "invalid_input"
      ) {
        finish(new ManagedWorktreeRemoverError(failure), true);
      } else {
        finish(new ManagedWorktreeRemoverError("io_failed"), true);
      }
    });
  });
}
