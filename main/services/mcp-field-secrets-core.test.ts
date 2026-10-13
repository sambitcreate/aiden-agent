import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPlaintextMcpFields,
  isMcpFieldSecretMarker,
  MCP_FIELD_SECRET_LIMITS,
  McpFieldSecretMissingError,
  mcpFieldSecretCleanupBaseline,
  mcpEnvForApproval,
  mcpFieldSecretDestination,
  mcpFieldSecretSealingTransition,
  mcpFieldSecretValuesFor,
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
  assert.deepEqual(Object.values(second.added), [{ field: "headers:X-Team", value: "green" }]);
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
    () => resolveMcpFieldSecrets(plan.server, { bindings: { [mcpFieldSecretDestination(plan.server)]: {} } }),
    (error: unknown) => error instanceof McpFieldSecretMissingError && /environment variable “API_KEY”/u.test(error.message),
  );
});

test("pruning keeps only the values the configured record still references", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  const [authorization, team] = [plan.server.headers!.Authorization!, plan.server.headers!["X-Team"]!];
  const withoutTeam = { ...plan.server, headers: { Authorization: authorization } };
  assert.deepEqual(mcpFieldSecretValuesFor(withoutTeam, pruneMcpFieldSecretRecord(stored(plan), withoutTeam)), { [authorization]: "Bearer secret-token" });
  assert.deepEqual(Object.keys(Object.values(pruneMcpFieldSecretRecord(stored(plan), withoutTeam)!.bindings)[0]!), [authorization]);
  assert.equal(pruneMcpFieldSecretRecord(stored(plan), undefined), undefined);
  assert.ok(team);
});

test("stored records round-trip, and anything else reads as nothing stored", () => {
  const marker = `aiden-secret:v1:${"a".repeat(32)}`;
  const record = { bindings: { ["d".repeat(64)]: { [marker]: { field: "env:TOKEN", value: "v" } } } };
  assert.deepEqual(parseMcpFieldSecretRecord(serializeMcpFieldSecretRecord(record)), record);
  // Malformed entries are dropped, not trusted.
  assert.deepEqual(
    parseMcpFieldSecretRecord(JSON.stringify({ v: 2, bindings: { ["d".repeat(64)]: { [marker]: { field: "env:TOKEN", value: "v" }, other: { field: "env:X", value: "x" }, [`aiden-secret:v1:${"b".repeat(32)}`]: { field: "nope", value: "y" } } } })),
    record,
  );
  assert.equal(parseMcpFieldSecretRecord(JSON.stringify({ v: 1, destination: "d".repeat(64), values: { [marker]: "v" } })), undefined);
  assert.equal(parseMcpFieldSecretRecord(null), undefined);
  assert.throws(() => parseMcpFieldSecretRecord("[]"));
});

test("stored values never follow a server to a new address or command edited outside Aiden", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  const record = stored(plan);
  // A hand edit points the record somewhere else but keeps its markers.
  const moved = { ...plan.server, url: "https://attacker.example/mcp" };
  assert.throws(() => resolveMcpFieldSecrets(moved, record), /changed outside Aiden/u);
  // Cleanup after that edit drops the values instead of keeping the referenced ones.
  assert.equal(pruneMcpFieldSecretRecord(record, moved), undefined);
  // A save that did not come from the editor cannot carry them over either.
  assert.throws(() => nextMcpFieldSecretRecord(record, planMcpFieldSecrets(moved, counter())), /changed outside Aiden/u);

  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "npx", args: ["server"], env: { TOKEN: "t" }, enabled: true };
  const localPlan = planMcpFieldSecrets(local, counter());
  assert.throws(() => resolveMcpFieldSecrets({ ...localPlan.server, args: ["other"] }, stored(localPlan)), /changed outside Aiden/u);
});

test("an editor address change keeps the old values usable until the new config is published", () => {
  const saved = planMcpFieldSecrets(remote, counter());
  const record = stored(saved);
  const edited = { ...saved.server, url: "https://new.example.test/mcp" };
  // The editor kept the masked header while changing the URL.
  const staged = nextMcpFieldSecretRecord(record, planMcpFieldSecrets(edited, counter()), { fromEditor: true, current: saved.server })!;
  assert.deepEqual(resolveMcpFieldSecrets(edited, staged).headers, remote.headers);

  // Publication failed (or the window went away): config.json still names the old URL.
  assert.deepEqual(resolveMcpFieldSecrets(saved.server, staged).headers, remote.headers);
  // Recovery (after a restart too) keeps the group the authoritative config points at.
  const recovered = pruneMcpFieldSecretRecord(staged, saved.server)!;
  assert.deepEqual(resolveMcpFieldSecrets(saved.server, recovered).headers, remote.headers);
  // The never-published address loses its copy, so a later outside edit to it inherits nothing.
  assert.throws(() => resolveMcpFieldSecrets(edited, recovered), /changed outside Aiden/u);

  // Publication committed: cleanup keeps the new address only.
  const committed = pruneMcpFieldSecretRecord(staged, edited)!;
  assert.deepEqual(resolveMcpFieldSecrets(edited, committed).headers, remote.headers);
  assert.throws(() => resolveMcpFieldSecrets(saved.server, committed), /changed outside Aiden/u);
});

test("a stored value only fills the field it was saved for", () => {
  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "node", args: ["server.js"], env: { CUSTOM_FLAGS: "--verbose", TOKEN: "secret" }, enabled: true };
  const plan = planMcpFieldSecrets(local, counter());
  const record = stored(plan);
  const flags = plan.server.env!.CUSTOM_FLAGS!;
  // A hand edit moves CUSTOM_FLAGS's marker under NODE_OPTIONS, same command and args.
  const reassigned = { ...plan.server, env: { NODE_OPTIONS: flags, TOKEN: plan.server.env!.TOKEN! } };
  assert.throws(
    () => resolveMcpFieldSecrets(reassigned, record),
    (error: unknown) => error instanceof McpFieldSecretMissingError && /“NODE_OPTIONS”/u.test(error.message),
  );
  // The approval says so instead of presenting it as a saved value.
  assert.deepEqual(mcpEnvForApproval(reassigned, record), [{ name: "NODE_OPTIONS", unavailable: true }, { name: "TOKEN" }]);
  assert.deepEqual(mcpEnvForApproval(plan.server, record), [{ name: "CUSTOM_FLAGS" }, { name: "TOKEN" }]);
  // A save outside the editor cannot launder it into the new name.
  assert.throws(() => nextMcpFieldSecretRecord(record, planMcpFieldSecrets(reassigned, counter())), /saved for another field/u);
  // Cleanup does not keep it either.
  assert.deepEqual(mcpFieldSecretValuesFor(reassigned, pruneMcpFieldSecretRecord(record, reassigned)), { [plan.server.env!.TOKEN!]: "secret" });

  // The editor's masked save sends the same names back and keeps working.
  assert.equal(nextMcpFieldSecretRecord(record, planMcpFieldSecrets({ ...plan.server, name: "Renamed" }, counter()), { fromEditor: true, current: plan.server }), undefined);
  // Renaming a masked variable in the editor is the person's own change: it moves with them.
  const renamed = { ...plan.server, env: { FLAGS: flags, TOKEN: plan.server.env!.TOKEN! } };
  const next = nextMcpFieldSecretRecord(record, planMcpFieldSecrets(renamed, counter()), { fromEditor: true, current: plan.server })!;
  assert.equal(resolveMcpFieldSecrets(renamed, next).env!.FLAGS, "--verbose");
});

test("re-saving a stale plain-text copy of a stored value keeps its marker (no sign-out)", () => {
  const first = planMcpFieldSecrets(remote, counter());
  const record = stored(first);
  // The renderer still holds the plain text from before the move and saves a toggle.
  const values = mcpFieldSecretValuesFor(first.server, record);
  const again = planMcpFieldSecrets({ ...remote, enabled: false }, () => "f".repeat(32), { reuse: { current: first.server, values } });
  assert.deepEqual(again.server.headers, first.server.headers);
  assert.deepEqual(again.added, {});
  assert.equal(pendingMcpCredentialCleanupForSave(first.server, again.server), null);
  assert.equal(nextMcpFieldSecretRecord(record, again), undefined);
  // A different value still gets a new marker.
  const rotated = planMcpFieldSecrets({ ...remote, headers: { ...remote.headers!, Authorization: "Bearer new" } }, () => "f".repeat(32), { reuse: { current: first.server, values } });
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

test("moving plain-text values into the keychain survives the config snapshot listener without clearing credentials", async () => {
  const { createLastSafeSnapshotReload } = await import("./portable-config-watch-core.js");
  const { mutatePortableConfigAndSync, setPortableCredentialSnapshotListener } = await import("./portable-credential-snapshot.js");
  const { McpCredentialEquivalences, externalMcpCredentialCleanupKind } = await import("./mcp-credential-cleanup-core.js");
  const equivalences = new McpCredentialEquivalences();
  let servers: McpServer[] = [remote];
  const cleanups: string[] = [];
  // The production wiring (main/index.ts): every config mutation reconciles the
  // last-safe snapshot against the new one through the external cleanup rule.
  const reload = createLastSafeSnapshotReload(
    async () => true,
    async () => structuredClone(servers),
    async () => false,
    async (previous, next) => {
      for (const before of previous) {
        const kind = externalMcpCredentialCleanupKind(before, next.find(({ id }) => id === before.id), equivalences);
        if (kind) cleanups.push(`${kind}:${before.id}`);
      }
    },
  );
  setPortableCredentialSnapshotListener(() => reload.syncCurrent());
  try {
    // The sealing save: plan, register the pure move, publish.
    await mutatePortableConfigAndSync(async () => {
      const plan = planMcpFieldSecrets(servers[0]!, counter());
      const sealing = mcpFieldSecretSealingTransition(servers[0], plan);
      assert.ok(sealing, "a pure move is recognised");
      equivalences.register(remote.id, sealing.from, sealing.to);
      servers = [plan.server];
    });
    assert.deepEqual(cleanups, [], "no OAuth, provider grant or preset key cleanup for a pure move");

    // A real value change through the same path still cleans up.
    await mutatePortableConfigAndSync(async () => {
      const plan = planMcpFieldSecrets({ ...servers[0]!, headers: { ...servers[0]!.headers!, Authorization: "Bearer rotated" } }, () => "e".repeat(32));
      assert.equal(mcpFieldSecretSealingTransition(servers[0], plan), undefined);
      servers = [plan.server];
    });
    assert.deepEqual(cleanups, [`replace:${remote.id}`]);
  } finally {
    setPortableCredentialSnapshotListener(async () => undefined);
  }
});
