import assert from "node:assert/strict";
import test from "node:test";
import { registerMcpControlHandlers, type McpControlDependencies, type McpDraftCredentials } from "./mcp-controls.js";
import type { McpServer } from "../services/types.js";
import { MCP_PRESETS, serverFromPreset } from "../services/mcp-presets.js";
import type { McpStatus } from "../../renderer/shared/mcp-status.js";

const linear = { id: "custom-linear", name: "Linear", transport: "http", url: "https://mcp.test/sse", oauth: true, enabled: true } as const;

function setup(saved: McpServer[] = [linear]) {
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
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: true });
  // Changed URL on an OAuth server: refuse before any connection is attempted.
  const changed = (await ipc.invoke("mcp:testDraft", "settings", { ...linear, url: "https://other.test/mcp" })) as McpStatus;
  assert.equal(changed.connected, false);
  assert.match(changed.error ?? "", /Authorize this server/u);
  assert.equal(ipc.drafts.length, 1);
  // A brand-new stdio server is tested without a saved record.
  await ipc.invoke("mcp:testDraft", "settings", { id: "new", name: "New", transport: "stdio", command: "npx", enabled: true });
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: false });
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
  assert.deepEqual(ipc.drafts[ipc.drafts.length - 1]?.credentials, { matchesSaved: false, apiKey: "sk-draft" });
  assert.equal(ipc.drafts[ipc.drafts.length - 1]?.server.headers, undefined);
});
