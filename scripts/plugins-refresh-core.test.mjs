import assert from "node:assert/strict";
import test from "node:test";
import {
  diffPluginCatalog,
  formatPluginCatalogReport,
  mapUpstreamPlugin,
} from "./plugins-refresh-core.mjs";

const localEntry = (name, extra = {}) => ({
  entry: { name, source: { source: "local", path: `./plugins/${name}` }, category: "Productivity" },
  manifest: {
    author: { name: "Fixture Inc" },
    interface: { displayName: name.toUpperCase(), developerName: "Fixture Inc", shortDescription: "Does things", websiteURL: `https://${name}.example/` },
  },
  ...extra,
});

test("upstream plugin files map to the catalog's compatibility shapes", () => {
  const hosted = mapUpstreamPlugin(localEntry("linear", {
    mcp: { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } },
    app: { apps: { linear: { id: "asdk_app_1" } } },
  }));
  assert.deepEqual(hosted, {
    id: "linear", name: "LINEAR", vendor: "By Fixture Inc", category: "Productivity",
    tagline: "Does things", docsUrl: "https://linear.example/", compatibility: "http-mcp",
    url: "https://mcp.linear.app/mcp",
  });

  const stdio = mapUpstreamPlugin(localEntry("ios", { mcp: { mcpServers: { x: { command: "npx", args: ["x"] } } } }));
  assert.equal(stdio.compatibility, "local-stdio");
  assert.equal(stdio.url, undefined);
  assert.equal(mapUpstreamPlugin(localEntry("teams", { app: { apps: { teams: { id: "a" } } } })).compatibility, "chatgpt-app");
  assert.equal(mapUpstreamPlugin(localEntry("expo")).compatibility, "skills");

  // A plain-HTTP MCP URL is never treated as a hosted endpoint.
  const insecure = mapUpstreamPlugin(localEntry("bad", { mcp: { mcpServers: { bad: { type: "http", url: "http://mcp.bad.example" } } } }));
  assert.equal(insecure.compatibility, "skills");

  const git = mapUpstreamPlugin({ entry: { name: "qodo", source: { source: "git-subdir", url: "https://github.com/qodo-ai/qodo-skills.git" }, category: "Coding" } });
  assert.equal(git.compatibility, "git-marketplace");
  assert.equal(git.name, undefined, "Git entries have no manifest name to compare");
  assert.equal(git.docsUrl, "https://github.com/qodo-ai/qodo-skills.git");

  assert.throws(() => mapUpstreamPlugin({ entry: {} }), /no name/u);
});

const local = [
  { id: "composio", name: "Composio", category: "Productivity", source: "aiden", compatibility: "http-mcp", url: "https://connect.composio.dev/mcp", auth: { kind: "apiKey" } },
  { id: "linear", name: "Linear", category: "Productivity", source: "openai-curated", compatibility: "http-mcp", url: "https://mcp.linear.app/mcp", auth: { kind: "oauth" } },
  { id: "slack", name: "Slack", category: "Productivity", source: "openai-curated", compatibility: "mcp-auth-unsupported", url: "https://mcp.slack.com/mcp" },
  { id: "chatcut", name: "ChatCut", category: "Creativity", source: "openai-curated", compatibility: "chatgpt-app" },
  { id: "retired", name: "Retired", category: "Productivity", source: "openai-curated", compatibility: "skills" },
];

test("the diff reports additions, removals and URL or shape changes, never Aiden-only entries", () => {
  const upstream = [
    { id: "linear", name: "Linear", category: "Productivity", compatibility: "http-mcp", url: "https://mcp.linear.app/v2/mcp" },
    // Aiden lists Slack as auth-unsupported; upstream calling it hosted MCP is not a change.
    { id: "slack", name: "Slack", category: "Productivity", compatibility: "http-mcp", url: "https://mcp.slack.com/mcp" },
    { id: "chatcut", name: "ChatCut", category: "Creativity", compatibility: "skills" },
    { id: "qodo", name: undefined, category: "Coding", compatibility: "git-marketplace" },
  ];
  const diff = diffPluginCatalog(local, upstream);
  assert.deepEqual(diff.added.map((plugin) => plugin.id), ["qodo"]);
  assert.deepEqual(diff.removed.map((plugin) => plugin.id), ["retired"]);
  assert.deepEqual(diff.changed, [
    { id: "linear", changes: [{ field: "url", local: "https://mcp.linear.app/mcp", upstream: "https://mcp.linear.app/v2/mcp" }] },
    { id: "chatcut", changes: [{ field: "compatibility", local: "chatgpt-app", upstream: "skills" }] },
  ]);
});

test("a connectable preset that loses its hosted MCP upstream is flagged", () => {
  const diff = diffPluginCatalog(local.slice(0, 2), [
    { id: "linear", name: "Linear", category: "Productivity", compatibility: "local-stdio" },
  ]);
  assert.deepEqual(diff.changed[0], {
    id: "linear", changes: [{ field: "compatibility", local: "http-mcp", upstream: "local-stdio" }],
  });
});

test("the report asks for review and never offers to overwrite sign-in details", () => {
  const clean = formatPluginCatalogReport({ added: [], removed: [], changed: [] }, { verifiedOn: "2026-09-02", sourceUrl: "src" });
  assert.match(clean, /No differences/u);
  const report = formatPluginCatalogReport(
    diffPluginCatalog(local, [{ id: "linear", name: "Linear", category: "Productivity", compatibility: "http-mcp", url: "https://x.example/mcp" }]),
    { verifiedOn: "2026-09-02", sourceUrl: "src" },
  );
  assert.match(report, /last verified 2026-09-02/u);
  assert.match(report, /linear\.url: https:\/\/mcp\.linear\.app\/mcp → https:\/\/x\.example\/mcp/u);
  assert.match(report, /- slack/u);
  assert.match(report, /sign-in .* verified before it becomes connectable/u);
});
