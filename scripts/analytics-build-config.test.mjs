/* global process */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import {
  ANALYTICS_BUILD_CONFIG_MODULE,
  analyticsBuildConfigPlugin,
  resolveAnalyticsBuildConfig,
} from "./analytics-build-config.mjs";
import { electronBuildOptions } from "./build-electron.mjs";

const KEY = "phc_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

test("only a distribution build carries the project key", () => {
  assert.equal(resolveAnalyticsBuildConfig({ env: { AIDEN_POSTHOG_PROJECT_KEY: KEY }, version: "1.40.0" }), undefined);
  assert.deepEqual(
    resolveAnalyticsBuildConfig({ env: { AIDEN_DISTRIBUTION_BUILD: "1", AIDEN_POSTHOG_PROJECT_KEY: ` ${KEY}\n` }, version: "1.40.0" }),
    { config: { projectKey: KEY, channel: "release" } },
  );
  assert.equal(
    resolveAnalyticsBuildConfig({ env: { AIDEN_DISTRIBUTION_BUILD: "1", AIDEN_POSTHOG_PROJECT_KEY: KEY }, version: "1.41.0-beta.2" }).config.channel,
    "beta",
  );
});

test("a distribution build without a key warns and stays keyless; a malformed key fails", () => {
  const resolved = resolveAnalyticsBuildConfig({ env: { AIDEN_DISTRIBUTION_BUILD: "1" }, version: "1.40.0" });
  assert.deepEqual(resolved.config, { channel: "release" });
  assert.match(resolved.warning, /AIDEN_POSTHOG_PROJECT_KEY/u);
  assert.throws(
    () => resolveAnalyticsBuildConfig({ env: { AIDEN_DISTRIBUTION_BUILD: "1", AIDEN_POSTHOG_PROJECT_KEY: "sk-live-secret" }, version: "1.40.0" }),
    (error) => /not a PostHog project key/u.test(error.message) && !error.message.includes("sk-live-secret"),
  );
});

async function bundledConfig(plugins) {
  const result = await build({
    stdin: { contents: `export { ANALYTICS_BUILD_CONFIG } from ${JSON.stringify(ANALYTICS_BUILD_CONFIG_MODULE)};`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins,
  });
  const source = result.outputFiles[0].text;
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  return { config: module.ANALYTICS_BUILD_CONFIG, source };
}

test("the bundle carries the key only when the plugin supplies it", async () => {
  const committed = await bundledConfig([]);
  assert.deepEqual(committed.config, { channel: "dev" });

  const release = await bundledConfig([analyticsBuildConfigPlugin({ projectKey: KEY, channel: "release" })]);
  assert.deepEqual(release.config, { projectKey: KEY, channel: "release" });
});

test("the ordinary build options keep the committed keyless module", () => {
  const options = electronBuildOptions({ production: true });
  assert.ok(options.every((option) => (option.plugins ?? []).length === 0));
  const distribution = electronBuildOptions({ production: true, analytics: { channel: "release" } });
  assert.ok(distribution.some((option) => option.plugins?.some((plugin) => plugin.name === "aiden-analytics-build-config")));
});
