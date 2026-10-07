// Works out which GitHub repository and head a workspace's pull request reads
// target, from local git configuration only. Mirrors the parts of `gh`'s
// resolution Aiden relied on: the base repository comes from the remote marked
// `gh-resolved`, else upstream > github > origin > others; the head owner and
// branch come from the branch's push remote and upstream merge ref.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeGitHubHost } from "../../../renderer/shared/chat-pull-requests.js";
import { resolveGitExecutableMemoized } from "../git-executable.js";
import { githubCliEnvironment } from "./github-credentials.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const SSH_CONFIG_TIMEOUT_MS = 3_000;
const SSH_ALIAS_TTL_MS = 5 * 60_000;
const REMOTE_PRIORITY = ["upstream", "github", "origin"];
const CONFIG_PATTERN =
  "^(remote\\..+\\.(url|pushurl|gh-resolved)|branch\\..+\\.(remote|pushremote|merge)|remote\\.pushdefault|url\\..+\\.insteadof)$";

export interface GitCommandResult {
  stdout: string;
  /** Process exit code; a failure to start the process throws instead. */
  code: number;
}

export type LocalGitRunner = (cwd: string, args: string[], signal?: AbortSignal) => Promise<GitCommandResult>;

export interface GitRemoteLocation {
  host: string;
  owner: string;
  name: string;
}

export interface LocalGitHubRepository extends GitRemoteLocation {
  /** The checked-out local branch; absent when HEAD is detached. */
  branch?: string;
  /** Branch name on the push remote; usually the same as `branch`. */
  headBranch?: string;
  /** Lowercase owner of the repository the branch is pushed to. */
  headOwner?: string;
  /** Last fetched/pushed sha of the head branch on the push remote. */
  headSha?: string;
}

export type LocalRepositoryResult =
  | { ok: true; repository: LocalGitHubRepository }
  | { ok: false; availability: "not-repo" | "not-github"; message: string };

export interface LocalRepositoryResolverOptions {
  git?: LocalGitRunner;
  /** Whether `host` serves GitHub; github.com and GHE.com always do. */
  isGitHubHost?: (host: string) => Promise<boolean>;
  /** Real hostname behind an SSH alias, per `ssh -G`. */
  sshHostname?: (alias: string) => Promise<string | undefined>;
  now?: () => number;
}

async function defaultGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitCommandResult> {
  const env = { ...githubCliEnvironment(), GIT_OPTIONAL_LOCKS: "0" };
  const binary = await resolveGitExecutableMemoized("git", cwd, env, signal);
  try {
    const result = await execFileAsync(binary, args, {
      cwd,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      signal,
      timeout: GIT_TIMEOUT_MS,
    });
    return { stdout: String(result.stdout), code: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (typeof failure.code === "number") return { stdout: String(failure.stdout ?? ""), code: failure.code };
    throw error;
  }
}

async function defaultSshHostname(alias: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._-]+$/u.test(alias)) return undefined;
  try {
    const result = await execFileAsync("/usr/bin/ssh", ["-G", "--", alias], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: SSH_CONFIG_TIMEOUT_MS,
    });
    const line = String(result.stdout).split("\n").find((entry) => entry.startsWith("hostname "));
    return line?.slice("hostname ".length).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isWellKnownGitHubHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

interface ParsedRemoteUrl extends GitRemoteLocation {
  /** True for scp-like and ssh:// URLs, whose host may be an SSH alias. */
  ssh: boolean;
}

function splitRepositoryPath(path: string): { owner: string; name: string } | undefined {
  const parts = path.replace(/^\/+/u, "").replace(/\/+$/u, "").split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0]!.toLowerCase();
  const name = parts[1]!.replace(/\.git$/iu, "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/u.test(owner) || !/^[a-z0-9._-]{1,100}$/u.test(name)) return undefined;
  return { owner, name };
}

/** Parse a git remote URL (scp-like, ssh, https, git) into host/owner/name. */
export function parseGitRemoteUrl(raw: string): ParsedRemoteUrl | undefined {
  const value = raw.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/u.exec(value);
  if (scp && !value.includes("://")) {
    const host = normalizeGitHubHost(scp[1]!);
    const path = splitRepositoryPath(scp[2]!);
    return host && path ? { host, ...path, ssh: true } : undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(url.protocol)) return undefined;
  const host = normalizeGitHubHost(url.hostname);
  const path = splitRepositoryPath(decodeURIComponent(url.pathname));
  return host && path ? { host, ...path, ssh: url.protocol.includes("ssh") } : undefined;
}

interface GitConfigSnapshot {
  values: Map<string, string[]>;
  remoteNames: string[];
}

function parseConfigDump(stdout: string): GitConfigSnapshot {
  const values = new Map<string, string[]>();
  const remoteNames: string[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const newline = record.indexOf("\n");
    const rawKey = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? "" : record.slice(newline + 1);
    // Section and variable names are case-insensitive; subsections are not.
    const first = rawKey.indexOf(".");
    const last = rawKey.lastIndexOf(".");
    const key =
      first > 0 && last > first
        ? `${rawKey.slice(0, first).toLowerCase()}.${rawKey.slice(first + 1, last)}.${rawKey.slice(last + 1).toLowerCase()}`
        : rawKey.toLowerCase();
    values.set(key, [...(values.get(key) ?? []), value]);
    const remote = /^remote\.(.+)\.url$/u.exec(key);
    if (remote && !remoteNames.includes(remote[1]!)) remoteNames.push(remote[1]!);
  }
  return { values, remoteNames };
}

function lastValue(config: GitConfigSnapshot, key: string): string | undefined {
  const values = config.values.get(key);
  return values?.[values.length - 1];
}

/** Apply `url.<base>.insteadOf` rewrites the way git does: longest prefix wins. */
function rewriteUrl(config: GitConfigSnapshot, url: string): string {
  let best: { base: string; prefix: string } | undefined;
  for (const [key, prefixes] of config.values) {
    const match = /^url\.(.+)\.insteadof$/u.exec(key);
    if (!match) continue;
    for (const prefix of prefixes) {
      if (prefix && url.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
        best = { base: match[1]!, prefix };
      }
    }
  }
  return best ? best.base + url.slice(best.prefix.length) : url;
}

export class LocalRepositoryResolver {
  private readonly git: LocalGitRunner;
  private readonly isGitHubHost: (host: string) => Promise<boolean>;
  private readonly sshHostname: (alias: string) => Promise<string | undefined>;
  private readonly now: () => number;
  private readonly sshAliases = new Map<string, { host: string | undefined; at: number }>();

  constructor(options: LocalRepositoryResolverOptions = {}) {
    this.git = options.git ?? defaultGit;
    this.isGitHubHost = options.isGitHubHost ?? (async (host) => isWellKnownGitHubHost(host));
    this.sshHostname = options.sshHostname ?? defaultSshHostname;
    this.now = options.now ?? Date.now;
  }

  async resolve(cwd: string, signal?: AbortSignal): Promise<LocalRepositoryResult> {
    const head = await this.git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
    if (head.code !== 0 && head.code !== 1) {
      return { ok: false, availability: "not-repo", message: "This folder is not a git repository." };
    }
    const branch = head.code === 0 ? head.stdout.trim() || undefined : undefined;
    const dump = await this.git(cwd, ["config", "-z", "--get-regexp", CONFIG_PATTERN], signal);
    const config = parseConfigDump(dump.code === 0 ? dump.stdout : "");

    const remotes = new Map<string, GitRemoteLocation>();
    for (const name of config.remoteNames) {
      const url = lastValue(config, `remote.${name}.url`);
      const location = url ? await this.location(config, url) : undefined;
      if (location) remotes.set(name, location);
    }
    const base = this.baseRemote(config, remotes);
    if (!base) {
      return { ok: false, availability: "not-github", message: "This repository's remote is not hosted on GitHub." };
    }

    const repository: LocalGitHubRepository = { ...base };
    if (!branch) return { ok: true, repository };
    repository.branch = branch;
    const branchRemote = lastValue(config, `branch.${branch}.remote`);
    const pushRemote =
      lastValue(config, `branch.${branch}.pushremote`) ?? lastValue(config, "remote.pushdefault") ?? branchRemote;
    const merge = lastValue(config, `branch.${branch}.merge`);
    const headBranch = merge?.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : branch;
    repository.headBranch = headBranch;

    let headLocation: GitRemoteLocation | undefined;
    if (pushRemote && remotes.has(pushRemote)) {
      headLocation = remotes.get(pushRemote);
      const pushUrl = lastValue(config, `remote.${pushRemote}.pushurl`);
      const pushLocation = pushUrl ? await this.location(config, pushUrl) : undefined;
      if (pushLocation) headLocation = pushLocation;
    } else if (pushRemote && /[:/]/u.test(pushRemote)) {
      headLocation = await this.location(config, pushRemote);
    }
    if (headLocation && headLocation.host === base.host) repository.headOwner = headLocation.owner;

    if (pushRemote && remotes.has(pushRemote)) {
      const tracking = await this.git(
        cwd,
        ["rev-parse", "--verify", "--quiet", `refs/remotes/${pushRemote}/${headBranch}`],
        signal,
      );
      const sha = tracking.code === 0 ? tracking.stdout.trim().toLowerCase() : "";
      if (/^[0-9a-f]{40,64}$/u.test(sha)) repository.headSha = sha;
    }
    return { ok: true, repository };
  }

  private baseRemote(
    config: GitConfigSnapshot,
    remotes: Map<string, GitRemoteLocation>,
  ): GitRemoteLocation | undefined {
    for (const [name, location] of remotes) {
      const resolved = lastValue(config, `remote.${name}.gh-resolved`)?.trim();
      if (!resolved) continue;
      if (resolved === "base") return location;
      const path = splitRepositoryPath(resolved);
      if (path) return { host: location.host, ...path };
    }
    const ranked = [...remotes.keys()].sort((a, b) => {
      const rank = (name: string) => {
        const index = REMOTE_PRIORITY.indexOf(name);
        return index < 0 ? REMOTE_PRIORITY.length : index;
      };
      return rank(a) - rank(b);
    });
    return ranked.length > 0 ? remotes.get(ranked[0]!) : undefined;
  }

  private async location(config: GitConfigSnapshot, url: string): Promise<GitRemoteLocation | undefined> {
    const parsed = parseGitRemoteUrl(rewriteUrl(config, url));
    if (!parsed) return undefined;
    const { ssh, ...location } = parsed;
    if (location.host === "ssh.github.com" || location.host === "www.github.com") location.host = "github.com";
    if (await this.isGitHubHost(location.host)) return location;
    if (!ssh) return undefined;
    const real = await this.aliasHost(location.host);
    return real && real !== location.host && (await this.isGitHubHost(real)) ? { ...location, host: real } : undefined;
  }

  private async aliasHost(alias: string): Promise<string | undefined> {
    const cached = this.sshAliases.get(alias);
    if (cached && this.now() - cached.at < SSH_ALIAS_TTL_MS) return cached.host;
    const resolved = await this.sshHostname(alias);
    const host = resolved ? normalizeGitHubHost(resolved) : undefined;
    this.sshAliases.set(alias, { host, at: this.now() });
    return host;
  }
}
