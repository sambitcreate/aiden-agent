import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPlaintextMcpFields,
  isMcpFieldSecretMarker,
  MCP_FIELD_SECRET_LIMITS,
  McpFieldSecretMissingError,
  mcpFieldSecretCleanupBaseline,
  mcpStdioLaunchFingerprint,
  parseMcpFieldSecretRecord,
  planMcpFieldSecrets,
  pruneMcpFieldSecretRecord,
  resolveMcpFieldSecrets,
} from "./mcp-field-secrets-core.js";
import {
  mcpAuthorityConnectionSnapshot,
  pendingMcpCredentialCleanupForSave,
} from "./mcp-credential-cleanup-core.js";
import type { McpServer } from "./types.js";

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
  const stored = JSON.stringify(plan.server);
  assert.doesNotMatch(stored, /secret-token|blue/u);
  assert.deepEqual(Object.keys(plan.server.headers!), ["Authorization", "X-Team"]);
  assert.ok(Object.values(plan.server.headers!).every(isMcpFieldSecretMarker));
  assert.equal(hasPlaintextMcpFields(plan.server), false);
  assert.equal(hasPlaintextMcpFields(remote), true);
  // The connection sees the original values.
  assert.deepEqual(resolveMcpFieldSecrets(plan.server, plan.added).headers, remote.headers);
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
    () => resolveMcpFieldSecrets(plan.server, {}),
    (error: unknown) => error instanceof McpFieldSecretMissingError && /environment variable “API_KEY”/u.test(error.message),
  );
});

test("pruning keeps only the values the configured record still references", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  const [authorization, team] = [plan.server.headers!.Authorization!, plan.server.headers!["X-Team"]!];
  const withoutTeam = { ...plan.server, headers: { Authorization: authorization } };
  assert.deepEqual(pruneMcpFieldSecretRecord(plan.added, withoutTeam), { [authorization]: "Bearer secret-token" });
  assert.equal(pruneMcpFieldSecretRecord(plan.added, undefined), undefined);
  assert.ok(team);
});

test("stored records ignore entries that are not marker → text", () => {
  const marker = `aiden-secret:v1:${"a".repeat(32)}`;
  assert.deepEqual(parseMcpFieldSecretRecord(JSON.stringify({ [marker]: "v", other: "x", [`aiden-secret:v1:${"b".repeat(32)}`]: 3 })), { [marker]: "v" });
  assert.deepEqual(parseMcpFieldSecretRecord(null), {});
  assert.throws(() => parseMcpFieldSecretRecord("[]"));
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
