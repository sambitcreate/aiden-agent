import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitHubCredentialSource,
  defaultGhHostsPath,
  environmentGitHubToken,
  githubCliEnvironment,
  isAuthorizedGitHubHost,
  parseGhHostsFile,
} from "./github-credentials.js";

function source(options: {
  env?: NodeJS.ProcessEnv;
  gh?: (host: string) => Promise<string>;
  clock?: { now: number };
  knownHosts?: string[];
}) {
  const asked: string[] = [];
  const clock = options.clock ?? { now: 0 };
  const credentials = new GitHubCredentialSource({
    env: () => options.env ?? {},
    now: () => clock.now,
    knownHosts: async () => options.knownHosts ?? [],
    ghAuthToken: async (host) => {
      asked.push(host);
      if (!options.gh) throw new Error("gh: not logged in");
      return options.gh(host);
    },
  });
  return { credentials, asked, clock };
}

test("environment tokens follow gh's host precedence", () => {
  const env = {
    GH_TOKEN: "dotcom",
    GITHUB_TOKEN: "dotcom-fallback",
    GH_ENTERPRISE_TOKEN: "enterprise",
  };
  assert.equal(environmentGitHubToken("github.com", env), "dotcom");
  assert.equal(environmentGitHubToken("acme.ghe.com", env), "dotcom");
  assert.equal(environmentGitHubToken("github.acme.test", env), undefined);
  assert.equal(
    environmentGitHubToken("github.acme.test", { ...env, GH_HOST: "github.acme.test" }),
    "enterprise",
  );
  assert.equal(
    environmentGitHubToken("github.acme.test", { ...env, GH_HOST: "other.acme.test" }),
    undefined,
  );
  assert.equal(environmentGitHubToken("attacker.example", env), undefined);
  assert.equal(environmentGitHubToken("github.com", { GITHUB_TOKEN: "only" }), "only");
});

test("an unknown remote host is not authorized by a global enterprise token", async () => {
  const { credentials, asked } = source({ env: { GH_ENTERPRISE_TOKEN: "enterprise-secret" } });
  assert.equal(isAuthorizedGitHubHost("attacker.example", { GH_ENTERPRISE_TOKEN: "enterprise-secret" }), false);
  assert.equal(await credentials.authorizesHost("attacker.example"), false);
  const result = await credentials.resolve("attacker.example");
  assert.equal(result.ok, false);
  assert.deepEqual(asked, []);

  const configured = source({
    env: { GH_ENTERPRISE_TOKEN: "enterprise-secret", GH_HOST: "git.corp.example" },
  });
  assert.equal(await configured.credentials.authorizesHost("git.corp.example"), true);
  assert.equal(await configured.credentials.authorizesHost("attacker.example"), false);
  const accepted = await configured.credentials.resolve("git.corp.example");
  assert.ok(accepted.ok);
  assert.equal(accepted.credential.token, "enterprise-secret");
  const refused = await configured.credentials.resolve("attacker.example");
  assert.equal(refused.ok, false);
  assert.deepEqual(configured.asked, []);
});

test("gh hosts.yml is discovered with GH_CONFIG_DIR, then XDG, then ~/.config/gh", () => {
  const home = "/Users/ada";
  assert.equal(defaultGhHostsPath({}, home), join(home, ".config", "gh", "hosts.yml"));
  assert.doesNotMatch(defaultGhHostsPath({}, home), /Application Support/u);
  assert.equal(
    defaultGhHostsPath({ XDG_CONFIG_HOME: join(home, "xdg") }, home),
    join(home, "xdg", "gh", "hosts.yml"),
  );
  assert.equal(
    defaultGhHostsPath(
      { GH_CONFIG_DIR: "/tmp/gh-config", XDG_CONFIG_HOME: join(home, "xdg") },
      home,
    ),
    join("/tmp/gh-config", "hosts.yml"),
  );
});

test("default host discovery authorizes an enterprise login from gh's config directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-gh-hosts-"));
  const asked: string[] = [];
  const writeHosts = async (directory: string, host: string) => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "hosts.yml"),
      `${host}:\n    oauth_token: ghe_must-not-be-read\n`,
      "utf8",
    );
  };
  try {
    const configDir = join(root, "override");
    await writeHosts(configDir, "git.corp.example");
    const fromOverride = new GitHubCredentialSource({
      env: () => ({ GH_CONFIG_DIR: configDir }),
      ghAuthToken: async (host) => {
        asked.push(host);
        return `token-for-${host}`;
      },
    });
    assert.equal(await fromOverride.authorizesHost("git.corp.example"), true);
    assert.equal(await fromOverride.authorizesHost("attacker.example"), false);
    const accepted = await fromOverride.resolve("git.corp.example");
    assert.ok(accepted.ok);
    assert.equal(accepted.credential.token, "token-for-git.corp.example");
    assert.equal(accepted.credential.source, "gh");
    const refused = await fromOverride.resolve("attacker.example");
    assert.equal(refused.ok, false);
    assert.deepEqual(asked, ["git.corp.example"]);

    const xdgHome = join(root, "xdg");
    await writeHosts(join(xdgHome, "gh"), "github.acme.test");
    const fromXdg = new GitHubCredentialSource({
      env: () => ({ XDG_CONFIG_HOME: xdgHome }),
      ghAuthToken: async () => "xdg-token",
    });
    assert.equal(await fromXdg.authorizesHost("github.acme.test"), true);
    const xdgResult = await fromXdg.resolve("github.acme.test");
    assert.ok(xdgResult.ok);
    assert.equal(xdgResult.credential.token, "xdg-token");
    const missingFile = new GitHubCredentialSource({
      env: () => ({ GH_CONFIG_DIR: join(root, "empty") }),
      ghAuthToken: async () => "unused",
    });
    assert.equal(await missingFile.authorizesHost("git.corp.example"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gh hosts.yml records known enterprise hosts without exposing tokens", () => {
  const hosts = parseGhHostsFile(
    [
      "github.com:",
      "    oauth_token: gho_should-never-appear",
      "    user: octocat",
      "git.corp.example:",
      "    oauth_token: ghe_should-never-appear",
    ].join("\n"),
  );
  assert.deepEqual(hosts, ["github.com", "git.corp.example"]);
  assert.ok(hosts.every((host) => !host.includes("gho_") && !host.includes("ghe_")));
});

test("an environment token is used without asking gh", async () => {
  const { credentials, asked } = source({ env: { GH_TOKEN: "env-token" } });
  const result = await credentials.resolve("github.com");
  assert.ok(result.ok);
  assert.equal(result.credential.token, "env-token");
  assert.equal(result.credential.source, "environment");
  assert.deepEqual(asked, []);
});

test("gh auth token is asked per host and cached for five minutes", async () => {
  const { credentials, asked, clock } = source({
    gh: async (host) => `token-for-${host}\n`,
    knownHosts: ["github.acme.test"],
  });
  const first = await credentials.resolve("github.com");
  await credentials.resolve("github.com");
  clock.now = 4 * 60_000;
  await credentials.resolve("github.com");
  assert.ok(first.ok);
  assert.equal(first.credential.token, "token-for-github.com");
  assert.deepEqual(asked, ["github.com"]);

  clock.now = 5 * 60_000 + 1;
  await credentials.resolve("github.com");
  await credentials.resolve("github.acme.test");
  assert.deepEqual(asked, ["github.com", "github.com", "github.acme.test"]);
});

test("concurrent resolves share one gh process", async () => {
  const { credentials, asked } = source({ gh: async () => "shared" });
  const results = await Promise.all([1, 2, 3].map(() => credentials.resolve("github.com")));
  assert.ok(results.every((result) => result.ok));
  assert.equal(asked.length, 1);
});

test("a missing token is remembered for ten seconds and reported by cause", async () => {
  const { credentials, asked, clock } = source({});
  const missing = await credentials.resolve("github.com");
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.missing.reason, "unauthenticated");
  clock.now = 9_000;
  await credentials.resolve("github.com");
  assert.equal(asked.length, 1);
  clock.now = 10_001;
  await credentials.resolve("github.com");
  assert.equal(asked.length, 2);

  const noCli = new GitHubCredentialSource({
    env: () => ({}),
    ghAuthToken: async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    },
  });
  const result = await noCli.resolve("github.com");
  assert.equal(!result.ok && result.missing.reason, "missing-tool");
});

test("invalidating a refused token makes the next resolve ask again", async () => {
  let issued = 0;
  const { credentials, asked } = source({ gh: async () => `token-${++issued}` });
  const first = await credentials.resolve("github.com");
  assert.ok(first.ok);
  credentials.invalidate("github.com", "github.com:not-this-one");
  await credentials.resolve("github.com");
  assert.equal(asked.length, 1, "a stale fingerprint must not drop the current token");

  credentials.invalidate("github.com", first.credential.fingerprint);
  const second = await credentials.resolve("github.com");
  assert.ok(second.ok);
  assert.equal(second.credential.token, "token-2");
  assert.notEqual(second.credential.fingerprint, first.credential.fingerprint);
  assert.doesNotMatch(second.credential.fingerprint, /token-2/u);
});

test("GitHub CLI environment removes Git routing while preserving noninteractive auth lookup", () => {
  const previous = { ...process.env };
  try {
    process.env.GIT_DIR = "/tmp/wrong.git";
    process.env.GIT_CONFIG_KEY_0 = "remote.origin.url";
    process.env.GH_HOST = "github.example.test";
    process.env.GH_REPO = "owner/other";
    process.env.GH_TOKEN = "kept-for-gh";
    const env = githubCliEnvironment();
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
    assert.equal(env.GH_HOST, undefined);
    assert.equal(env.GH_REPO, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GH_TOKEN, "kept-for-gh");
  } finally {
    process.env = previous;
  }
});
