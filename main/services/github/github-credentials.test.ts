import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubCredentialSource,
  environmentGitHubToken,
  githubCliEnvironment,
} from "./github-credentials.js";

function source(options: {
  env?: NodeJS.ProcessEnv;
  gh?: (host: string) => Promise<string>;
  clock?: { now: number };
}) {
  const asked: string[] = [];
  const clock = options.clock ?? { now: 0 };
  const credentials = new GitHubCredentialSource({
    env: () => options.env ?? {},
    now: () => clock.now,
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
  assert.equal(environmentGitHubToken("github.acme.test", env), "enterprise");
  assert.equal(
    environmentGitHubToken("github.acme.test", { ...env, GH_HOST: "other.acme.test" }),
    undefined,
  );
  assert.equal(environmentGitHubToken("github.com", { GITHUB_TOKEN: "only" }), "only");
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
  const { credentials, asked, clock } = source({ gh: async (host) => `token-for-${host}\n` });
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
