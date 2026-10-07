// GitHub token resolution for the main process. Tokens never leave this module
// except as the Authorization header the transport builds; callers see a
// fingerprint (`host:sha256-prefix`) for cache keys and rate-limit scopes.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GH_BINARY_CANDIDATES = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/opt/local/bin/gh",
  "/usr/bin/gh",
] as const;

const GIT_ROUTING_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
] as const;

const TOKEN_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 10_000;
const GH_AUTH_TOKEN_TIMEOUT_MS = 10_000;

export function githubCliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ROUTING_ENV) delete env[key];
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GH_HOST;
  delete env.GH_REPO;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
}

export async function resolveGitHubCliBinary(): Promise<string> {
  for (const candidate of GH_BINARY_CANDIDATES) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known macOS install location before falling back to PATH.
    }
  }
  return "gh";
}

export interface GitHubCredential {
  host: string;
  token: string;
  /** `host:sha256-prefix`; safe for cache keys and logs, never reversible. */
  fingerprint: string;
  source: "environment" | "gh";
}

export interface GitHubCredentialMissing {
  host: string;
  reason: "missing-tool" | "unauthenticated";
  message: string;
}

export type GitHubCredentialResult =
  | { ok: true; credential: GitHubCredential }
  | { ok: false; missing: GitHubCredentialMissing };

export type GhAuthTokenRunner = (host: string) => Promise<string>;

export interface GitHubCredentialSourceOptions {
  env?: () => NodeJS.ProcessEnv;
  ghAuthToken?: GhAuthTokenRunner;
  now?: () => number;
}

export function githubTokenFingerprint(host: string, token: string): string {
  return `${host}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function isDotComHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/** Token from the environment, following gh's precedence for the host kind. */
export function environmentGitHubToken(
  host: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const pick = (...keys: string[]) =>
    keys.map((key) => env[key]?.trim()).find((value) => value);
  if (isDotComHost(host)) return pick("GH_TOKEN", "GITHUB_TOKEN");
  const configuredHost = env.GH_HOST?.trim().toLowerCase();
  if (configuredHost && configuredHost !== host) return undefined;
  return pick("GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN");
}

async function defaultGhAuthToken(host: string): Promise<string> {
  const binary = await resolveGitHubCliBinary();
  const result = await execFileAsync(
    binary,
    ["auth", "token", "--hostname", host],
    {
      encoding: "utf8",
      env: { ...githubCliEnvironment(), GH_PROMPT_DISABLED: "1", GH_DEBUG: "" },
      maxBuffer: 64 * 1024,
      timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
    },
  );
  return String(result.stdout).trim();
}

function ghMissingReason(error: unknown): GitHubCredentialMissing["reason"] {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "ENOENT" || /spawn .*gh ENOENT/u.test(message)
    ? "missing-tool"
    : "unauthenticated";
}

type CacheEntry =
  | { result: GitHubCredentialResult; expiresAt: number }
  | undefined;

/**
 * Resolves a token per host: GH_TOKEN/GITHUB_TOKEN (or the enterprise pair for
 * GHES), then `gh auth token --hostname`. Results are cached for five minutes,
 * a missing token for ten seconds, and a 401 drops the cached token.
 */
export class GitHubCredentialSource {
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly ghAuthToken: GhAuthTokenRunner;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<GitHubCredentialResult>>();

  constructor(options: GitHubCredentialSourceOptions = {}) {
    this.env = options.env ?? (() => process.env);
    this.ghAuthToken = options.ghAuthToken ?? defaultGhAuthToken;
    this.now = options.now ?? Date.now;
  }

  async resolve(host: string): Promise<GitHubCredentialResult> {
    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > this.now()) return cached.result;
    const pending = this.inflight.get(host);
    if (pending) return pending;
    const next = this.lookup(host).finally(() => this.inflight.delete(host));
    this.inflight.set(host, next);
    return next;
  }

  /** Drop the cached token for `host` if it is still the one that was refused. */
  invalidate(host: string, fingerprint?: string): void {
    const cached = this.cache.get(host);
    if (
      fingerprint === undefined ||
      (cached?.result.ok && cached.result.credential.fingerprint === fingerprint)
    ) {
      this.cache.delete(host);
    }
  }

  private async lookup(host: string): Promise<GitHubCredentialResult> {
    const result = await this.read(host);
    this.cache.set(host, {
      result,
      expiresAt: this.now() + (result.ok ? TOKEN_TTL_MS : MISSING_TTL_MS),
    });
    return result;
  }

  private async read(host: string): Promise<GitHubCredentialResult> {
    const fromEnv = environmentGitHubToken(host, this.env());
    if (fromEnv) return this.credential(host, fromEnv, "environment");
    try {
      const token = (await this.ghAuthToken(host)).trim();
      if (token && !/\s/u.test(token)) return this.credential(host, token, "gh");
      return {
        ok: false,
        missing: {
          host,
          reason: "unauthenticated",
          message: `Run \`gh auth login --hostname ${host}\` on this Mac, or set GH_TOKEN, then refresh.`,
        },
      };
    } catch (error) {
      const reason = ghMissingReason(error);
      return {
        ok: false,
        missing: {
          host,
          reason,
          message:
            reason === "missing-tool"
              ? "Install GitHub CLI and run `gh auth login`, or set GH_TOKEN, so Aiden can read pull requests."
              : `Run \`gh auth login --hostname ${host}\` on this Mac, or set GH_TOKEN, then refresh.`,
        },
      };
    }
  }

  private credential(
    host: string,
    token: string,
    source: GitHubCredential["source"],
  ): GitHubCredentialResult {
    return {
      ok: true,
      credential: {
        host,
        token,
        fingerprint: githubTokenFingerprint(host, token),
        source,
      },
    };
  }
}
