import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPlaintextMcpFields,
  isMcpFieldSecretMarker,
  MCP_FIELD_SECRET_LIMITS,
  McpFieldSecretMissingError,
  mcpFieldSecretCleanupBaseline,
  mcpFieldSecretDestination,
  mcpStdioLaunchFingerprint,
  nextMcpFieldSecretRecord,
  parseMcpFieldSecretRecord,
  serializeMcpFieldSecretRecord,
  type McpFieldSecretPlan,
  planMcpFieldSecrets,
  pruneMcpFieldSecretRecord,
  resolveMcpFieldSecrets,
} from "./mcp-field-secrets-core.js";
import {
  mcpAuthorityConnectionSnapshot,
  pendingMcpCredentialCleanupForSave,
} from "./mcp-credential-cleanup-core.js";
import type { McpServer } from "./types.js";

/** The record storing `plan` creates for a server with nothing stored yet. */
const stored = (plan: McpFieldSecretPlan) => nextMcpFieldSecretRecord(undefined, plan)!;

function counter() {
  let next = 0;
  return () => (++next).toString(16).padStart(32, "0");
}

const remote: McpServer = {
  id: "docs",
  name: "Docs",
  transport: "http",
  url: "https://docs.example.test/mcp",
  headers: { Authorization: "Bearer secret-token", "X-Team": "blue" },
  oauth: true,
  enabled: true,
};

test("saving moves every env and header value out of the stored record and back on connect", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  const configJson = JSON.stringify(plan.server);
  assert.doesNotMatch(configJson, /secret-token|blue/u);
  assert.deepEqual(Object.keys(plan.server.headers!), ["Authorization", "X-Team"]);
  assert.ok(Object.values(plan.server.headers!).every(isMcpFieldSecretMarker));
  assert.equal(hasPlaintextMcpFields(plan.server), false);
  assert.equal(hasPlaintextMcpFields(remote), true);
  // The connection sees the original values.
  assert.deepEqual(resolveMcpFieldSecrets(plan.server, stored(plan)).headers, remote.headers);
});

test("a value the editor did not replace keeps its marker; a replaced one gets a new marker", () => {
  const first = planMcpFieldSecrets(remote, counter());
  const keptMarker = first.server.headers!.Authorization!;
  const edit = { ...first.server, headers: { ...first.server.headers!, "X-Team": "green" } };
  const second = planMcpFieldSecrets(edit, () => "f".repeat(32));
  assert.equal(second.server.headers!.Authorization, keptMarker);
  assert.deepEqual(second.kept.map(({ marker }) => marker), [keptMarker]);
  assert.deepEqual(Object.values(second.added), ["green"]);
  assert.notEqual(second.server.headers!["X-Team"], first.server.headers!["X-Team"]);
});

test("moving unchanged values into the keychain is not a credential change, but replacing one is", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  // Without the baseline the marker swap would look like a new credential and clear the sign-in.
  assert.notEqual(pendingMcpCredentialCleanupForSave(remote, plan.server), null);
  assert.equal(pendingMcpCredentialCleanupForSave(mcpFieldSecretCleanupBaseline(remote, plan), plan.server), null);

  const changed = planMcpFieldSecrets({ ...remote, headers: { ...remote.headers!, Authorization: "Bearer rotated" } }, counter());
  const pending = pendingMcpCredentialCleanupForSave(mcpFieldSecretCleanupBaseline(remote, changed), changed.server);
  assert.equal(pending?.kind, "replace");

  // A rotated value changes the authority Bots and schedules were approved for.
  const rotated = planMcpFieldSecrets({ ...plan.server, headers: { ...plan.server.headers!, Authorization: "Bearer rotated" } }, () => "e".repeat(32));
  assert.notDeepEqual(mcpAuthorityConnectionSnapshot(rotated.server), mcpAuthorityConnectionSnapshot(plan.server));
});

test("a marker without a stored value fails closed and names the field", () => {
  const plan = planMcpFieldSecrets({ ...remote, transport: "stdio", url: undefined, headers: undefined, command: "mcp", env: { API_KEY: "k" } }, counter());
  assert.throws(
    () => resolveMcpFieldSecrets(plan.server, { destination: mcpFieldSecretDestination(plan.server), values: {} }),
    (error: unknown) => error instanceof McpFieldSecretMissingError && /environment variable “API_KEY”/u.test(error.message),
  );
});

test("pruning keeps only the values the configured record still references", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  const [authorization, team] = [plan.server.headers!.Authorization!, plan.server.headers!["X-Team"]!];
  const withoutTeam = { ...plan.server, headers: { Authorization: authorization } };
  assert.deepEqual(pruneMcpFieldSecretRecord(stored(plan), withoutTeam)?.values, { [authorization]: "Bearer secret-token" });
  assert.equal(pruneMcpFieldSecretRecord(stored(plan), undefined), undefined);
  assert.ok(team);
});

test("stored records round-trip, and anything else reads as nothing stored", () => {
  const marker = `aiden-secret:v1:${"a".repeat(32)}`;
  const record = { destination: "d".repeat(64), values: { [marker]: "v" } };
  assert.deepEqual(parseMcpFieldSecretRecord(serializeMcpFieldSecretRecord(record)), record);
  assert.deepEqual(parseMcpFieldSecretRecord(JSON.stringify({ v: 1, destination: "d".repeat(64), values: { [marker]: "v", other: "x" } }))?.values, { [marker]: "v" });
  assert.equal(parseMcpFieldSecretRecord(JSON.stringify({ [marker]: "v" })), undefined);
  assert.equal(parseMcpFieldSecretRecord(null), undefined);
  assert.throws(() => parseMcpFieldSecretRecord("[]"));
});

test("stored values never follow a server to a new address or command", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  const record = stored(plan);
  // A hand edit points the record somewhere else but keeps its markers.
  const moved = { ...plan.server, url: "https://attacker.example/mcp" };
  assert.throws(() => resolveMcpFieldSecrets(moved, record), /changed outside Aiden/u);
  // Cleanup after that edit drops the values instead of keeping the referenced ones.
  assert.equal(pruneMcpFieldSecretRecord(record, moved), undefined);
  // A save that did not come from the editor cannot carry them over either.
  assert.throws(() => nextMcpFieldSecretRecord(record, planMcpFieldSecrets(moved, counter())), /changed outside Aiden/u);
  // Changing the URL in the editor (which keeps the header) rebinds them.
  const rebound = nextMcpFieldSecretRecord(record, planMcpFieldSecrets(moved, counter()), { allowNewDestination: true })!;
  assert.deepEqual(resolveMcpFieldSecrets(moved, rebound).headers, remote.headers);

  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "npx", args: ["server"], env: { TOKEN: "t" }, enabled: true };
  const localPlan = planMcpFieldSecrets(local, counter());
  assert.throws(() => resolveMcpFieldSecrets({ ...localPlan.server, args: ["other"] }, stored(localPlan)), /changed outside Aiden/u);
});

test("re-saving a stale plain-text copy of a stored value keeps its marker (no sign-out)", () => {
  const first = planMcpFieldSecrets(remote, counter());
  const record = stored(first);
  // The renderer still holds the plain text from before the move and saves a toggle.
  const again = planMcpFieldSecrets({ ...remote, enabled: false }, () => "f".repeat(32), { reuse: { current: first.server, values: record.values } });
  assert.deepEqual(again.server.headers, first.server.headers);
  assert.deepEqual(again.added, {});
  assert.equal(pendingMcpCredentialCleanupForSave(first.server, again.server), null);
  assert.equal(nextMcpFieldSecretRecord(record, again), undefined);
  // A different value still gets a new marker.
  const rotated = planMcpFieldSecrets({ ...remote, headers: { ...remote.headers!, Authorization: "Bearer new" } }, () => "f".repeat(32), { reuse: { current: first.server, values: record.values } });
  assert.notEqual(rotated.server.headers!.Authorization, first.server.headers!.Authorization);
});

test("an unapproved local server's env stays reviewable in config.json", () => {
  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "node", args: ["server.js"], env: { NODE_OPTIONS: "--require /tmp/p.js" }, enabled: true };
  const plan = planMcpFieldSecrets(local, counter(), { sealEnv: false });
  assert.deepEqual(plan.server.env, local.env);
  assert.deepEqual(plan.added, {});
  assert.equal(hasPlaintextMcpFields(plan.server), true);
});

test("oversized or unnamed fields are refused when saving", () => {
  assert.throws(() => planMcpFieldSecrets({ ...remote, headers: { "": "x" } }, counter()), /names must have/u);
  assert.throws(() => planMcpFieldSecrets({ ...remote, headers: { A: "x".repeat(MCP_FIELD_SECRET_LIMITS.valueChars + 1) } }, counter()), /too long/u);
  const many = Object.fromEntries(Array.from({ length: MCP_FIELD_SECRET_LIMITS.entries + 1 }, (_, index) => [`H${index}`, "v"]));
  assert.throws(() => planMcpFieldSecrets({ ...remote, headers: many }, counter()), /at most/u);
});

test("the launch fingerprint covers what runs, not how the server is labelled", () => {
  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "npx", args: ["-y", "server"], env: { TOKEN: "a" }, enabled: true };
  const base = mcpStdioLaunchFingerprint(local);
  assert.equal(mcpStdioLaunchFingerprint({ ...local, name: "Renamed", description: "x", enabled: false, exposure: "hidden" }), base);
  for (const changed of [
    { ...local, command: "node" },
    { ...local, args: ["-y", "other"] },
    { ...local, env: { TOKEN: "b" } },
    { ...local, env: { TOKEN: "a", EXTRA: "1" } },
    { ...local, id: "files-2" },
  ]) assert.notEqual(mcpStdioLaunchFingerprint(changed), base);
});

test("connection credentials: approval first, stored values filled in, preset key bound to the stored (marker) record", async () => {
  const { resolveMcpConnectionCredentials } = await import("./mcp-connection-credentials.js");
  const { MCP_PRESETS, serverFromPreset } = await import("./mcp-presets.js");
  const { mcpCredentialConnectionSnapshot } = await import("./mcp-credential-cleanup-core.js");
  const preset = MCP_PRESETS.find((candidate) => candidate.auth.kind === "apiKey")!;
  const plan = planMcpFieldSecrets({ ...serverFromPreset(preset), headers: { "X-Workspace": "team-1" } }, counter());
  const record = stored(plan);
  const bindings: string[] = [];
  const resolved = await resolveMcpConnectionCredentials(plan.server, {
    resolveFieldSecrets: async (server) => resolveMcpFieldSecrets(server, record),
    presetKey: async (_server, binding) => { bindings.push(binding); return "sk-preset"; },
    isCurrent: () => true,
    missingKey: (name) => `${name} needs a key`,
  });
  // The key was saved against the record as stored, so it is looked up the same way.
  assert.deepEqual(bindings, [JSON.stringify(mcpCredentialConnectionSnapshot(plan.server))]);
  assert.equal(resolved.headers!["X-Workspace"], "team-1");
  assert.equal(Object.keys(resolved.headers!).length, 2);

  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "npx", enabled: true };
  let filled = false;
  await assert.rejects(
    resolveMcpConnectionCredentials(local, {
      isLaunchApproved: async () => false,
      resolveFieldSecrets: async (server) => { filled = true; return server; },
      presetKey: async () => null,
      isCurrent: () => true,
      missingKey: () => "",
    }),
    /added outside Aiden/u,
  );
  assert.equal(filled, false, "nothing is resolved for a launch that may not run");
});
