import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPlaintextMcpFields,
  isMcpFieldSecretMarker,
  MCP_FIELD_SECRET_LIMITS,
  McpFieldSecretMissingError,
  mcpEnvForApproval,
  mcpFieldSecretDestination,
  mcpFieldSecretFieldValues,
  mcpStdioLaunchFingerprint,
  parseMcpFieldSecretRecord,
  serializeMcpFieldSecretRecord,
  stageMcpFieldSecrets,
  type McpFieldSecretPlan,
  type McpFieldSecretRecord,
  planMcpFieldSecrets,
  pruneMcpFieldSecretRecord,
  resolveMcpFieldSecrets,
} from "./mcp-field-secrets-core.js";
import {
  externalMcpCredentialCleanupKind,
  mcpAuthorityConnectionSnapshot,
  mcpCredentialCleanupAfterConfig,
  mcpPresetKeyBinding,
  pendingMcpCredentialCleanupForSave,
} from "./mcp-credential-cleanup-core.js";
import type { McpServer } from "./types.js";

function counter(start = 0) {
  let next = start;
  return () => (++next).toString(16).padStart(32, "0");
}

/** Stage `plan` against `record` as the save path does (editor saves pass `current`). */
function stage(record: McpFieldSecretRecord | undefined, plan: McpFieldSecretPlan, options: { fromEditor?: boolean; current?: McpServer } = {}) {
  return stageMcpFieldSecrets(record, plan, { ...options, random: counter(0x900) });
}

/** The record storing `plan` creates for a server with nothing stored yet. */
const stored = (plan: McpFieldSecretPlan) => stage(undefined, plan).record!;

const remote: McpServer = {
  id: "docs",
  name: "Docs",
  transport: "http",
  url: "https://docs.example.test/mcp",
  headers: { Authorization: "Bearer secret-token", "X-Team": "blue" },
  oauth: true,
  enabled: true,
};

/** Every value a record holds, across all destination groups and markers. */
function allEntries(record: McpFieldSecretRecord | undefined): string[] {
  return Object.entries(record?.bindings ?? {}).flatMap(([destination, group]) =>
    Object.entries(group).map(([marker, entry]) => `${destination.slice(0, 6)}/${marker.slice(-4)}/${entry.field}=${entry.value}`)).sort();
}

/** Staging may only add: every entry the record held before is still there, unchanged. */
function assertAdditive(before: McpFieldSecretRecord, after: McpFieldSecretRecord | undefined): void {
  const kept = new Set(allEntries(after ?? before));
  for (const entry of allEntries(before)) assert.ok(kept.has(entry), `staging changed or removed ${entry}`);
}

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

test("stored credentials are bound to the connection, not to how its env/header values are stored", () => {
  const plan = planMcpFieldSecrets(remote, counter());
  // Moving values into the keychain cleans nothing up (OAuth, grants and preset keys survive) ...
  assert.equal(pendingMcpCredentialCleanupForSave(remote, plan.server), null);
  assert.equal(externalMcpCredentialCleanupKind(remote, plan.server), null);
  // ... and a preset key saved against the plain-text record is read with the same binding afterwards.
  assert.equal(mcpPresetKeyBinding(plan.server), mcpPresetKeyBinding(remote));
  // A different endpoint still is a credential change.
  assert.equal(pendingMcpCredentialCleanupForSave(remote, { ...plan.server, url: "https://other.test/mcp" })?.kind, "replace");
  // A rotated value still changes the authority Bots and schedules were approved for.
  const rotated = planMcpFieldSecrets({ ...plan.server, headers: { ...plan.server.headers!, Authorization: "Bearer rotated" } }, () => "e".repeat(32));
  assert.notDeepEqual(mcpAuthorityConnectionSnapshot(rotated.server), mcpAuthorityConnectionSnapshot(plan.server));
});

test("a failed move into the keychain leaves the preset key readable, and a retry with new markers still reads it", () => {
  const plaintext: McpServer = { ...remote, oauth: undefined, presetId: "example", headers: { "X-Workspace": "team-1" } };
  // The key was saved against the plain-text record.
  const savedBinding = mcpPresetKeyBinding(plaintext);
  const firstAttempt = planMcpFieldSecrets(plaintext, counter());
  // Publication failed: config is still plain text; nothing about the key changed.
  assert.equal(mcpPresetKeyBinding(plaintext), savedBinding);
  // A later retry mints different markers and publishes them.
  const retry = planMcpFieldSecrets(plaintext, counter(0x500));
  assert.notDeepEqual(retry.server.headers, firstAttempt.server.headers);
  assert.equal(mcpPresetKeyBinding(retry.server), savedBinding);
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
  const authorization = plan.server.headers!.Authorization!;
  const withoutTeam = { ...plan.server, headers: { Authorization: authorization } };
  const pruned = pruneMcpFieldSecretRecord(stored(plan), withoutTeam);
  assert.deepEqual(mcpFieldSecretFieldValues(withoutTeam, pruned), { "headers:Authorization": "Bearer secret-token" });
  assert.deepEqual(Object.keys(Object.values(pruned!.bindings)[0]!), [authorization]);
  assert.equal(pruneMcpFieldSecretRecord(stored(plan), undefined), undefined);
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
  assert.throws(() => stage(record, planMcpFieldSecrets(moved, counter())), /changed outside Aiden/u);

  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "npx", args: ["server"], env: { TOKEN: "t" }, enabled: true };
  const localPlan = planMcpFieldSecrets(local, counter());
  assert.throws(() => resolveMcpFieldSecrets({ ...localPlan.server, args: ["other"] }, stored(localPlan)), /changed outside Aiden/u);
});

test("an editor address change keeps the old values usable until the new config is published", () => {
  const saved = planMcpFieldSecrets(remote, counter());
  const record = stored(saved);
  const edited = { ...saved.server, url: "https://new.example.test/mcp" };
  // The editor kept the masked header while changing the URL.
  const staged = stage(record, planMcpFieldSecrets(edited, counter()), { fromEditor: true, current: saved.server });
  assertAdditive(record, staged.record);
  assert.deepEqual(resolveMcpFieldSecrets(staged.server, staged.record).headers, remote.headers);

  // Publication failed (or the window went away): config.json still names the old URL.
  assert.deepEqual(resolveMcpFieldSecrets(saved.server, staged.record).headers, remote.headers);
  // Recovery (after a restart too) keeps the group the authoritative config points at.
  const recovered = pruneMcpFieldSecretRecord(staged.record!, saved.server)!;
  assert.deepEqual(resolveMcpFieldSecrets(saved.server, recovered).headers, remote.headers);
  // The never-published address loses its copy, so a later outside edit to it inherits nothing.
  assert.throws(() => resolveMcpFieldSecrets(edited, recovered), /changed outside Aiden/u);
  // The journal entry for that save resolves without clearing anything (config never changed).
  const pending = pendingMcpCredentialCleanupForSave(saved.server, staged.server)!;
  assert.deepEqual(mcpCredentialCleanupAfterConfig(pending, saved.server), { resolved: true, clearOAuth: false, clearPresetKey: false });

  // Publication committed: cleanup keeps the new address only.
  const committed = pruneMcpFieldSecretRecord(staged.record!, staged.server)!;
  assert.deepEqual(resolveMcpFieldSecrets(staged.server, committed).headers, remote.headers);
  assert.throws(() => resolveMcpFieldSecrets(saved.server, committed), /changed outside Aiden/u);
});

test("a stored value only fills the field it was saved for, checked for every occurrence", () => {
  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "node", args: ["server.js"], env: { CUSTOM_FLAGS: "--require /tmp/p.js", TOKEN: "secret" }, enabled: true };
  const plan = planMcpFieldSecrets(local, counter());
  const record = stored(plan);
  const flags = plan.server.env!.CUSTOM_FLAGS!;
  const token = plan.server.env!.TOKEN!;

  // An outside edit moves CUSTOM_FLAGS's marker under NODE_OPTIONS (same command and args).
  const reassigned = { ...plan.server, env: { NODE_OPTIONS: flags, TOKEN: token } };
  assert.throws(
    () => resolveMcpFieldSecrets(reassigned, record),
    (error: unknown) => error instanceof McpFieldSecretMissingError && /“NODE_OPTIONS”/u.test(error.message),
  );
  assert.deepEqual(mcpEnvForApproval(reassigned, record), [{ name: "NODE_OPTIONS", unavailable: true }, { name: "TOKEN" }]);

  // An outside edit keeps CUSTOM_FLAGS and adds NODE_OPTIONS with the same marker (an alias).
  const aliased = { ...plan.server, env: { CUSTOM_FLAGS: flags, NODE_OPTIONS: flags, TOKEN: token } };
  assert.throws(
    () => resolveMcpFieldSecrets(aliased, record),
    (error: unknown) => error instanceof McpFieldSecretMissingError && /“NODE_OPTIONS”/u.test(error.message),
  );
  assert.deepEqual(mcpEnvForApproval(aliased, record), [{ name: "CUSTOM_FLAGS" }, { name: "NODE_OPTIONS", unavailable: true }, { name: "TOKEN" }]);
  assert.deepEqual(mcpFieldSecretFieldValues(aliased, record), { "env:CUSTOM_FLAGS": "--require /tmp/p.js", "env:TOKEN": "secret" });

  // No save launders either into the new name: not outside the editor, and not
  // through the editor's masked save of a record that already held the alias.
  for (const edited of [reassigned, aliased]) {
    assert.throws(() => stage(record, planMcpFieldSecrets(edited, counter())), /saved for another field/u);
    assert.throws(() => stage(record, planMcpFieldSecrets(edited, counter()), { fromEditor: true, current: edited }), /saved for another field/u);
  }
  // Cleanup keeps only what resolves for its own field.
  assert.deepEqual(mcpFieldSecretFieldValues(reassigned, pruneMcpFieldSecretRecord(record, reassigned)), { "env:TOKEN": "secret" });

  // The editor's masked save sends the same names back and writes nothing.
  assert.equal(stage(record, planMcpFieldSecrets({ ...plan.server, name: "Renamed" }, counter()), { fromEditor: true, current: plan.server }).record, undefined);
});

test("an editor rename of a masked field copies the value to a new marker and keeps the old one until publication commits", () => {
  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "node", args: ["server.js"], env: { CUSTOM_FLAGS: "--verbose", TOKEN: "secret" }, enabled: true };
  const saved = planMcpFieldSecrets(local, counter());
  const record = stored(saved);
  const flags = saved.server.env!.CUSTOM_FLAGS!;
  const renamed = { ...saved.server, env: { FLAGS: flags, TOKEN: saved.server.env!.TOKEN! } };
  const staged = stage(record, planMcpFieldSecrets(renamed, counter()), { fromEditor: true, current: saved.server });
  assertAdditive(record, staged.record);
  // The published record names the value with a fresh marker.
  assert.notEqual(staged.server.env!.FLAGS, flags);
  assert.equal(resolveMcpFieldSecrets(staged.server, staged.record).env!.FLAGS, "--verbose");

  // Publication failed or was cancelled: the old config still resolves, including after recovery.
  assert.equal(resolveMcpFieldSecrets(saved.server, staged.record).env!.CUSTOM_FLAGS, "--verbose");
  const recovered = pruneMcpFieldSecretRecord(staged.record!, saved.server);
  assert.equal(resolveMcpFieldSecrets(saved.server, recovered).env!.CUSTOM_FLAGS, "--verbose");
  assert.throws(() => resolveMcpFieldSecrets(staged.server, recovered), McpFieldSecretMissingError);

  // Committed: cleanup drops the old field's entry.
  const committed = pruneMcpFieldSecretRecord(staged.record!, staged.server);
  assert.deepEqual(mcpFieldSecretFieldValues(staged.server, committed), { "env:FLAGS": "--verbose", "env:TOKEN": "secret" });
  assert.equal(Object.keys(Object.values(committed!.bindings)[0]!).length, 2);
});

test("re-saving a stale plain-text copy of a stored value keeps its marker (no sign-out)", () => {
  const first = planMcpFieldSecrets(remote, counter());
  const record = stored(first);
  const values = mcpFieldSecretFieldValues(first.server, record);
  // The renderer still holds the plain text from before the move and saves a toggle.
  const again = planMcpFieldSecrets({ ...remote, enabled: false }, () => "f".repeat(32), { reuse: { current: first.server, values } });
  assert.deepEqual(again.server.headers, first.server.headers);
  assert.deepEqual(again.added, {});
  assert.equal(stage(record, again).record, undefined);
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

test("connection credentials: approval first, stored values filled in, preset key bound to the connection", async () => {
  const { resolveMcpConnectionCredentials } = await import("./mcp-connection-credentials.js");
  const { MCP_PRESETS, serverFromPreset } = await import("./mcp-presets.js");
  const preset = MCP_PRESETS.find((candidate) => candidate.auth.kind === "apiKey")!;
  const plaintext = { ...serverFromPreset(preset), headers: { "X-Workspace": "team-1" } };
  const plan = planMcpFieldSecrets(plaintext, counter());
  const record = stored(plan);
  const bindings: string[] = [];
  const resolved = await resolveMcpConnectionCredentials(plan.server, {
    resolveFieldSecrets: async (server) => resolveMcpFieldSecrets(server, record),
    presetKey: async (_server, binding) => { bindings.push(binding); return "sk-preset"; },
    isCurrent: () => true,
    missingKey: (name) => `${name} needs a key`,
  });
  // The key saved against the plain-text record is read with the same binding after the move.
  assert.deepEqual(bindings, [mcpPresetKeyBinding(plaintext)]);
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
        const kind = externalMcpCredentialCleanupKind(before, next.find(({ id }) => id === before.id));
        if (kind) cleanups.push(`${kind}:${before.id}`);
      }
    },
  );
  setPortableCredentialSnapshotListener(() => reload.syncCurrent());
  try {
    await mutatePortableConfigAndSync(async () => {
      servers = [planMcpFieldSecrets(servers[0]!, counter()).server];
    });
    assert.deepEqual(cleanups, [], "no OAuth, provider grant or preset key cleanup for a move into the keychain");

    // An endpoint change through the same path still cleans up.
    await mutatePortableConfigAndSync(async () => {
      servers = [{ ...servers[0]!, url: "https://moved.example.test/mcp" }];
    });
    assert.deepEqual(cleanups, [`replace:${remote.id}`]);
  } finally {
    setPortableCredentialSnapshotListener(async () => undefined);
  }
});

test("an outside edit that drops a stored header prunes its value, so restoring the marker later resolves nothing", async () => {
  const { createLastSafeSnapshotReload } = await import("./portable-config-watch-core.js");
  const { mcpFieldSecretReferencesChanged } = await import("./mcp-field-secrets-core.js");
  const saved = planMcpFieldSecrets(remote, counter());
  let record: McpFieldSecretRecord | undefined = stored(saved);
  let servers: McpServer[] = [saved.server];
  const cleanups: string[] = [];
  // The production rule (reconcileExternalMcpCredentialChanges): sign-in
  // cleanup and stored-value pruning are decided independently.
  const reload = createLastSafeSnapshotReload(
    async () => true,
    async () => structuredClone(servers),
    async () => true,
    async (previous, next) => {
      for (const before of previous) {
        const after = next.find(({ id }) => id === before.id);
        const kind = externalMcpCredentialCleanupKind(before, after);
        if (kind) cleanups.push(kind);
        if (mcpFieldSecretReferencesChanged(before, after)) record = record && pruneMcpFieldSecretRecord(record, after);
      }
    },
  );
  await reload.syncCurrent();
  const team = saved.server.headers!["X-Team"]!;
  // config.json is edited by hand: X-Team is removed.
  servers = [{ ...saved.server, headers: { Authorization: saved.server.headers!.Authorization! } }];
  await reload();
  assert.deepEqual(cleanups, [], "no sign-in is cleared for a header edit");
  assert.equal(resolveMcpFieldSecrets(servers[0]!, record).headers!.Authorization, "Bearer secret-token");
  // Later the old marker is typed back in under the same name: it is gone.
  servers = [saved.server];
  await reload();
  assert.throws(() => resolveMcpFieldSecrets(saved.server, record), (error: unknown) => error instanceof McpFieldSecretMissingError && /“X-Team”/u.test(error.message));
  assert.ok(team);
});

test("a failed prune after an outside edit stays pending and the next reload retries it", async () => {
  const { createLastSafeSnapshotReload } = await import("./portable-config-watch-core.js");
  const { mcpFieldSecretReferencesChanged } = await import("./mcp-field-secrets-core.js");
  const saved = planMcpFieldSecrets(remote, counter());
  let record: McpFieldSecretRecord | undefined = stored(saved);
  let servers: McpServer[] = [saved.server];
  let storeAvailable = false;
  const reload = createLastSafeSnapshotReload(
    async () => true,
    async () => structuredClone(servers),
    async () => true,
    async (previous, next) => {
      for (const before of previous) {
        const after = next.find(({ id }) => id === before.id);
        if (!mcpFieldSecretReferencesChanged(before, after)) continue;
        // As in production, a store failure rejects reconciliation.
        if (!storeAvailable) throw new Error("keychain locked");
        record = record && pruneMcpFieldSecretRecord(record, after);
      }
    },
  );
  await reload.syncCurrent();
  servers = [{ ...saved.server, headers: { Authorization: saved.server.headers!.Authorization! } }];
  await assert.rejects(reload(), /keychain locked/u);
  assert.equal(mcpFieldSecretFieldValues(saved.server, record)["headers:X-Team"], "blue", "the failed prune removed nothing");
  storeAvailable = true;
  // config.json has not changed again; the pending transition is retried anyway.
  await reload();
  servers = [saved.server];
  await reload();
  assert.throws(() => resolveMcpFieldSecrets(saved.server, record), (error: unknown) => error instanceof McpFieldSecretMissingError && /“X-Team”/u.test(error.message));
});

test("a pre-registered OAuth client secret is sealed like a header, survives the record round trip and resolves only for its server", () => {
  const server: McpServer = { ...remote, headers: undefined, oauthClientId: "slack-app", oauthClientSecret: "client-secret-value" };
  assert.equal(hasPlaintextMcpFields(server), true);
  const plan = planMcpFieldSecrets(server, counter());
  assert.equal(plan.server.oauthClientId, "slack-app", "the client ID stays in config");
  assert.ok(isMcpFieldSecretMarker(plan.server.oauthClientSecret));
  assert.equal(JSON.stringify(plan.server).includes("client-secret-value"), false, "config never holds the secret");
  assert.equal(hasPlaintextMcpFields(plan.server), false);
  const record = parseMcpFieldSecretRecord(serializeMcpFieldSecretRecord(stored(plan)));
  assert.equal(resolveMcpFieldSecrets(plan.server, record).oauthClientSecret, "client-secret-value");
  // Sent nowhere else: another address resolves nothing.
  assert.throws(() => resolveMcpFieldSecrets({ ...plan.server, url: "https://elsewhere.test/mcp" }, record), /changed outside Aiden/u);
  // Unchanged on the next save: the marker is reused, so nothing looks like a new credential.
  const again = planMcpFieldSecrets({ ...server }, counter(0x500), { reuse: { current: plan.server, values: mcpFieldSecretFieldValues(plan.server, record) } });
  assert.equal(again.server.oauthClientSecret, plan.server.oauthClientSecret);
  assert.deepEqual(again.added, {});
  // Removing the secret prunes it from the record.
  assert.equal(pruneMcpFieldSecretRecord(record!, { ...plan.server, oauthClientSecret: undefined }), undefined);
  // A secret under the same marker but recorded for a header does not resolve as the client secret.
  const marker = plan.server.oauthClientSecret!;
  const misfiled: McpFieldSecretRecord = { bindings: { [mcpFieldSecretDestination(plan.server)]: { [marker]: { field: "headers:Authorization", value: "Bearer x" } } } };
  assert.throws(() => resolveMcpFieldSecrets(plan.server, misfiled), McpFieldSecretMissingError);
});
