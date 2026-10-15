import assert from "node:assert/strict";
import test from "node:test";
import { registerMcpControlHandlers, type McpControlDependencies, type McpDraftCredentials } from "./mcp-controls.js";
import type { McpServer } from "../services/types.js";
import { MCP_PRESETS, serverFromPreset } from "../services/mcp-presets.js";
import type { McpStatus } from "../../renderer/shared/mcp-status.js";
import { McpLiveStatusRegistry } from "../services/mcp-status-events.js";
import { createMcpStdioApprovalStore, type McpStdioApprovalStore } from "../services/mcp-stdio-approvals.js";
import { mcpStdioLaunchFingerprint } from "../services/mcp-field-secrets-core.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const linear = { id: "custom-linear", name: "Linear", transport: "http", url: "https://mcp.test/sse", oauth: true, enabled: true } as const;

const noApprovals: McpStdioApprovalStore = {
  isApproved: async () => false,
  approve: async () => undefined,
  approveShown: async () => false,
  forget: async () => undefined,
};

function setup(saved: McpServer[] = [linear], registry = new McpLiveStatusRegistry(), approvals = noApprovals) {
  const handlers = new Map<string, (event: string, ...args: unknown[]) => unknown>();
  const log: string[] = [];
  const drafts: Array<{ server: McpServer; credentials: McpDraftCredentials }> = [];
  let destroyed = false;
  let waiting = new Set<string>();
  const admitted: string[] = [];
  let savedChanged = false;
  let signIn = { authorized: true, needsSignIn: false };
  const connected: McpStatus = { connected: true, toolCount: 3, tools: ["a", "b", "c"], serverCapabilities: {} };
  const deps: McpControlDependencies<string> = {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    owner(event) {
      if (event !== "settings") throw new Error("Untrusted document");
      return { isDestroyed: () => destroyed };
    },
    configured: async (id) => saved.find((server) => server.id === id),
    cancelAuthorization: (id) => { const had = waiting.delete(id); log.push(`cancel:${id}:${had}`); return had; },
    signOut: async (server) => { log.push(`signOut:${server.id}`); },
    testDraft: async (server, credentials) => { drafts.push({ server, credentials }); return connected; },
    // Models withConfiguredMcp: refuse when the saved record changed after it was compared.
    admitSaved: async (savedServer, operation) => {
      admitted.push(savedServer.id);
      if (savedChanged) throw new Error("This MCP server configuration changed. Try again.");
      return operation();
    },
    signInState: async () => signIn,
    dependents: async (id) => ({ schedules: [{ id: "t1", name: `uses ${id}` }], bots: [] }),
    liveStatus: () => [{ serverId: linear.id, state: "connected", toolCount: 3 }],
    toolList: (id) => registry.tools(id),
    // The production wiring: every saved stdio server not approved on this device.
    pendingLaunchApprovals: async () => {
      const pending = [];
      for (const server of saved) {
        if (server.transport !== "stdio" || (await approvals.isApproved(server))) continue;
        pending.push({ serverId: server.id, fingerprint: mcpStdioLaunchFingerprint(server), command: server.command ?? "", args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) });
      }
      return pending;
    },
    approveLaunch: (server, fingerprint) => approvals.approveShown(server, fingerprint),
    launchApproved: (server) => approvals.isApproved(server),
  };
  registerMcpControlHandlers(deps);
  const invoke = (channel: string, event: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!(event, ...args));
  return {
    invoke, log, drafts, admitted,
    changeSaved: () => { savedChanged = true; },
    setSignIn: (state: typeof signIn) => { signIn = state; },
    destroy: () => { destroyed = true; },
    wait: (id: string) => { waiting = new Set([...waiting, id]); },
  };
}

test("cancel sign-in reports whether a sign-in was waiting and requires the live document", async () => {
  const ipc = setup();
  ipc.wait(linear.id);
  assert.deepEqual(await ipc.invoke("mcp:cancelAuthorize", "settings", linear.id), { cancelled: true });
  assert.deepEqual(await ipc.invoke("mcp:cancelAuthorize", "settings", linear.id), { cancelled: false });
  await assert.rejects(ipc.invoke("mcp:cancelAuthorize", "foreign", linear.id), /Untrusted/u);
  ipc.destroy();
  await assert.rejects(ipc.invoke("mcp:cancelAuthorize", "settings", linear.id), /active application document/u);
});

test("sign out stops a waiting sign-in first, then clears the configured OAuth server", async () => {
  const stdio = { id: "files", name: "Files", transport: "stdio", command: "npx", enabled: true } as const;
  const ipc = setup([linear, stdio]);
  ipc.wait(linear.id);
  assert.deepEqual(await ipc.invoke("mcp:signOut", "settings", linear.id), { authorized: false });
  assert.deepEqual(ipc.log, [`cancel:${linear.id}:true`, `signOut:${linear.id}`]);
  await assert.rejects(ipc.invoke("mcp:signOut", "settings", "files"), /does not use browser sign-in/u);
  await assert.rejects(ipc.invoke("mcp:signOut", "settings", "gone"), /no longer configured/u);
  assert.equal(ipc.log.filter((entry) => entry.startsWith("signOut")).length, 1);
});

test("testing a draft validates like save and never lends saved sign-in to a changed endpoint", async () => {
  const ipc = setup();
  // Unchanged connection: stored credentials apply.
  assert.equal(((await ipc.invoke("mcp:testDraft", "settings", { ...linear, name: "Renamed" })) as McpStatus).connected, true);
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: true, savedDestination: true });
  // Changed URL on an OAuth server: refuse before any connection is attempted.
  const changed = (await ipc.invoke("mcp:testDraft", "settings", { ...linear, url: "https://other.test/mcp" })) as McpStatus;
  assert.equal(changed.connected, false);
  assert.match(changed.error ?? "", /Authorize this server/u);
  assert.equal(ipc.drafts.length, 1);
  // A brand-new stdio server is tested without a saved record.
  await ipc.invoke("mcp:testDraft", "settings", { id: "new", name: "New", transport: "stdio", command: "npx", enabled: true });
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: false, savedDestination: false });
  // Same validation as save.
  await assert.rejects(ipc.invoke("mcp:testDraft", "settings", { id: "", name: "x" }), /non-empty/u);
  // Only API-key presets accept a pasted key.
  await assert.rejects(ipc.invoke("mcp:testDraft", "settings", { id: "new", name: "New", transport: "stdio", command: "npx" }, "sk-1"), /does not take an API key/u);
  assert.equal(ipc.drafts.length, 2);
});

test("a draft borrowing saved credentials is tested only under admission for that saved record, with its sign-in state", async () => {
  const ipc = setup();
  ipc.setSignIn({ authorized: false, needsSignIn: true });
  const status = (await ipc.invoke("mcp:testDraft", "settings", { ...linear, name: "Renamed" })) as McpStatus;
  assert.deepEqual(ipc.admitted, [linear.id]);
  assert.equal(status.authorized, false);
  assert.equal(status.needsSignIn, true);
  // A brand-new draft borrows nothing: no admission, no sign-in fields.
  const fresh = (await ipc.invoke("mcp:testDraft", "settings", { id: "new", name: "New", transport: "stdio", command: "npx", enabled: true })) as McpStatus;
  assert.deepEqual(ipc.admitted, [linear.id]);
  assert.equal(fresh.authorized, undefined);
  // The saved record changed between comparison and admission: nothing is tested.
  ipc.changeSaved();
  const before = ipc.drafts.length;
  await assert.rejects(ipc.invoke("mcp:testDraft", "settings", linear), /configuration changed/u);
  assert.equal(ipc.drafts.length, before);
});

test("dependents and live status are read through the live document", async () => {
  const ipc = setup();
  assert.deepEqual(await ipc.invoke("mcp:dependents", "settings", linear.id), {
    schedules: [{ id: "t1", name: `uses ${linear.id}` }],
    bots: [],
  });
  assert.deepEqual(await ipc.invoke("mcp:liveStatus", "settings"), [{ serverId: linear.id, state: "connected", toolCount: 3 }]);
  await assert.rejects(ipc.invoke("mcp:dependents", "settings", 42), /Expected/u);
});

test("an API-key preset draft is tested with the pasted key, unsaved", async () => {
  const preset = MCP_PRESETS.find((candidate) => candidate.auth.kind === "apiKey")!;
  const ipc = setup([]);
  const draft = serverFromPreset(preset);
  await ipc.invoke("mcp:testDraft", "settings", draft, "  sk-draft  ");
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: false, savedDestination: false, apiKey: "sk-draft" });
  assert.equal(ipc.drafts[ipc.drafts.length - 1]?.server.headers, undefined);
});

test("the tool list comes from the last discovery, bounded, and is null before any discovery", async () => {
  const registry = new McpLiveStatusRegistry();
  const pushed: unknown[] = [];
  registry.subscribe((status) => pushed.push(status));
  const ipc = setup([linear], registry);
  assert.equal(await ipc.invoke("mcp:toolList", "settings", linear.id), null);
  registry.inventory(linear.id, {
    toolCount: 3,
    resources: false,
    tools: [
      { name: "create_issue", title: "  Create\n issue  " },
      { name: "search" },
      { name: "x".repeat(300), title: "Too long a name" },
    ],
  });
  assert.deepEqual(await ipc.invoke("mcp:toolList", "settings", linear.id), [
    { name: "create_issue", title: "Create issue" },
    { name: "search" },
  ]);
  // Pushes stay small: tool names never ride on live status.
  assert.ok(pushed.every((status) => !("tools" in (status as object))));
  registry.forget(linear.id);
  assert.equal(await ipc.invoke("mcp:toolList", "settings", linear.id), null);
  await assert.rejects(ipc.invoke("mcp:toolList", "foreign", linear.id), /Untrusted/u);
});

test("stored header values are lent to a draft only while it reaches the saved endpoint", async () => {
  const marker = `aiden-secret:v1:${"a".repeat(32)}`;
  const keyed = { id: "keyed", name: "Keyed", transport: "http", url: "https://keyed.test/mcp", headers: { Authorization: marker }, enabled: true } as const;
  const ipc = setup([keyed]);
  await ipc.invoke("mcp:testDraft", "settings", { ...keyed, headers: { ...keyed.headers, "X-New": "typed" } });
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: false, savedDestination: true });
  await ipc.invoke("mcp:testDraft", "settings", { ...keyed, url: "https://elsewhere.test/mcp" });
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: false, savedDestination: false });
});

test("local servers added outside Aiden are listed with what they run and approved only as shown", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-mcp-controls-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const approvals = createMcpStdioApprovalStore(async () => path.join(dir, "approvals.json"));
  const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "npx", args: ["-y", "server"], env: { TOKEN: `aiden-secret:v1:${"b".repeat(32)}` }, enabled: true };
  const saved: McpServer[] = [linear, local];
  const ipc = setup(saved, undefined, approvals);
  const [pending, ...others] = (await ipc.invoke("mcp:launchApprovals", "settings")) as { serverId: string; fingerprint: string; command: string; args: string[]; env: { name: string; value?: string }[] }[];
  assert.deepEqual(others, []);
  assert.equal(pending?.serverId, "files");
  assert.equal(pending?.command, "npx");
  assert.deepEqual(pending?.args, ["-y", "server"]);

  // Testing the saved command is a launch too: refused until approved, while a command the person typed may run.
  const blocked = (await ipc.invoke("mcp:testDraft", "settings", local)) as McpStatus;
  assert.equal(blocked.connected, false);
  assert.match(blocked.error ?? "", /Approve this server/u);
  assert.equal(ipc.drafts.length, 0);
  await ipc.invoke("mcp:testDraft", "settings", { ...local, command: "node" });
  assert.equal(ipc.drafts.length, 1);

  // config.json changed after Settings showed the command: nothing is approved.
  saved[1] = { ...local, args: ["-y", "other"] };
  await assert.rejects(ipc.invoke("mcp:approveLaunch", "settings", "files", pending!.fingerprint), /command changed/u);
  assert.equal(await approvals.isApproved(saved[1]!), false);

  saved[1] = local;
  assert.deepEqual(await ipc.invoke("mcp:approveLaunch", "settings", "files", pending!.fingerprint), { approved: true });
  assert.equal(await approvals.isApproved(local), true);
  assert.deepEqual(await ipc.invoke("mcp:launchApprovals", "settings"), []);
  await ipc.invoke("mcp:testDraft", "settings", local);
  assert.equal(ipc.drafts.length, 2, "an approved saved command can be tested");
  await assert.rejects(ipc.invoke("mcp:approveLaunch", "settings", linear.id, pending!.fingerprint), /Only local/u);
  await assert.rejects(ipc.invoke("mcp:approveLaunch", "settings", "files", "nope"), /Invalid launch fingerprint/u);
  await assert.rejects(ipc.invoke("mcp:approveLaunch", "foreign", "files", pending!.fingerprint), /Untrusted/u);
});
